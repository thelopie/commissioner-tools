import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  AppError,
  assertCacheTtl,
  YAHOO_CACHE_MAX_TTL_SECONDS,
  type TableKey,
} from '@dinkel/shared';

/**
 * Single-table DynamoDB access.
 *
 * A thin layer over the document client, existing to enforce three invariants
 * that are easy to forget at a call site and expensive to get wrong:
 *
 *  1. Every Yahoo cache write carries a TTL at or under 24 hours (Yahoo's terms).
 *  2. Every entity write is guarded by an optimistic-concurrency version check,
 *     so two commissioners editing the same record cannot silently clobber each
 *     other.
 *  3. Uniqueness is enforced by conditional writes, not by read-then-write, which
 *     races.
 */

export interface TableOptions {
  tableName: string;
  region: string;
  /** Points at DynamoDB Local during development. Absent when deployed. */
  endpoint?: string;
}

export class Table {
  private readonly client: DynamoDBDocumentClient;
  readonly name: string;

  constructor(options: TableOptions) {
    const base = new DynamoDBClient({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    });

    this.client = DynamoDBDocumentClient.from(base, {
      marshallOptions: {
        // Undefined fields are dropped rather than stored as NULL, so an absent
        // optional field reads back as absent.
        removeUndefinedValues: true,
        convertClassInstanceToMap: false,
      },
    });
    this.name = options.tableName;
  }

  async get<T>(key: TableKey): Promise<T | null> {
    const result = await this.client.send(new GetCommand({ TableName: this.name, Key: key }));
    return (result.Item as T | undefined) ?? null;
  }

  /** Unconditional write. Use `putNew` or `putVersioned` for entities. */
  async put(item: Record<string, unknown>): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.name, Item: item }));
  }

  /**
   * Creates an item, failing if the key already exists.
   *
   * @throws {AppError} `duplicate`
   */
  async putNew(item: Record<string, unknown> & TableKey): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.name,
          Item: item,
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        throw new AppError('duplicate', {
          publicMessage: 'That record already exists.',
          cause: error,
        });
      }
      throw error;
    }
  }

  /**
   * Writes an entity, asserting the version last read.
   *
   * @param expectedVersion - Version the caller read. Omit for a first write.
   * @throws {AppError} `version_conflict` when someone else wrote first.
   */
  async putVersioned(
    item: Record<string, unknown> & TableKey & { version: number },
    expectedVersion?: number,
  ): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.name,
          Item: item,
          ...(expectedVersion === undefined
            ? { ConditionExpression: 'attribute_not_exists(PK)' }
            : {
                ConditionExpression: '#version = :expected',
                ExpressionAttributeNames: { '#version': 'version' },
                ExpressionAttributeValues: { ':expected': expectedVersion },
              }),
        }),
      );
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        throw new AppError('version_conflict', {
          publicMessage:
            'Someone else changed this while you were editing. Reload and try again — ' +
            'nothing was overwritten.',
          cause: error,
        });
      }
      throw error;
    }
  }

  async delete(key: TableKey): Promise<void> {
    await this.client.send(new DeleteCommand({ TableName: this.name, Key: key }));
  }

  /** Queries a partition, optionally by sort-key prefix. */
  async query<T>(options: {
    pk: string;
    skPrefix?: string;
    indexName?: 'GSI1' | 'GSI2';
    /** For an index query, the partition value is matched against this attribute. */
    limit?: number;
    ascending?: boolean;
  }): Promise<T[]> {
    const pkAttribute =
      options.indexName === 'GSI1' ? 'GSI1PK' : options.indexName === 'GSI2' ? 'GSI2PK' : 'PK';
    const skAttribute =
      options.indexName === 'GSI1' ? 'GSI1SK' : options.indexName === 'GSI2' ? 'GSI2SK' : 'SK';

    const items: T[] = [];
    let lastKey: Record<string, unknown> | undefined;

    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.name,
          ...(options.indexName ? { IndexName: options.indexName } : {}),
          KeyConditionExpression: options.skPrefix
            ? '#pk = :pk AND begins_with(#sk, :skPrefix)'
            : '#pk = :pk',
          ExpressionAttributeNames: {
            '#pk': pkAttribute,
            ...(options.skPrefix ? { '#sk': skAttribute } : {}),
          },
          ExpressionAttributeValues: {
            ':pk': options.pk,
            ...(options.skPrefix ? { ':skPrefix': options.skPrefix } : {}),
          },
          ScanIndexForward: options.ascending ?? true,
          ...(options.limit ? { Limit: options.limit } : {}),
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );

      items.push(...((result.Items ?? []) as T[]));
      lastKey = result.LastEvaluatedKey;

      // Respect an explicit limit rather than paging past it.
      if (options.limit && items.length >= options.limit) {
        return items.slice(0, options.limit);
      }
    } while (lastKey);

    return items;
  }

  /**
   * Applies several writes atomically.
   *
   * Used where a uniqueness sentinel must be written in the same breath as the
   * record it guards — a user and its Yahoo-GUID claim, an LLWS assignment and its
   * team claim, a draft pick and its slot claim. Two concurrent requests cannot
   * both succeed.
   *
   * @throws {AppError} `conflict` when any condition fails.
   */
  async transactWrite(
    operations: ReadonlyArray<
      | { kind: 'put'; item: Record<string, unknown> & TableKey; mustNotExist?: boolean }
      | { kind: 'delete'; key: TableKey }
    >,
    conflictMessage: string,
  ): Promise<void> {
    if (operations.length === 0) return;

    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: operations.map((operation) =>
            operation.kind === 'put'
              ? {
                  Put: {
                    TableName: this.name,
                    Item: operation.item,
                    ...(operation.mustNotExist
                      ? { ConditionExpression: 'attribute_not_exists(PK)' }
                      : {}),
                  },
                }
              : { Delete: { TableName: this.name, Key: operation.key } },
          ),
        }),
      );
    } catch (error) {
      if (isTransactionConflict(error)) {
        throw new AppError('conflict', { publicMessage: conflictMessage, cause: error });
      }
      throw error;
    }
  }

  /**
   * Increments a counter atomically and returns the new value.
   *
   * Used for reminder counts and similar, where read-modify-write would lose
   * concurrent increments.
   */
  async increment(key: TableKey, attribute: string): Promise<number> {
    const result = await this.client.send(
      new UpdateCommand({
        TableName: this.name,
        Key: key,
        UpdateExpression: 'SET #attribute = if_not_exists(#attribute, :zero) + :one',
        ExpressionAttributeNames: { '#attribute': attribute },
        ExpressionAttributeValues: { ':zero': 0, ':one': 1 },
        ReturnValues: 'UPDATED_NEW',
      }),
    );

    return Number((result.Attributes as Record<string, unknown>)[attribute] ?? 0);
  }

  // ------------------------------------------------------------------- cache

  /**
   * Reads a Yahoo cache entry, treating an expired one as absent.
   *
   * DynamoDB TTL deletion is eventual — items can linger for hours past expiry —
   * so expiry is also checked here. Relying on TTL alone would mean serving Yahoo
   * data past the window the terms allow.
   */
  async getCached<T>(
    cacheKey: string,
    nowSeconds = Math.floor(Date.now() / 1000),
  ): Promise<T | null> {
    const item = await this.get<{ payload: T; expiresAt: number }>({
      PK: `YAHOO_CACHE#${cacheKey}`,
      SK: 'CACHE',
    });

    if (!item) return null;
    if (item.expiresAt <= nowSeconds) return null;
    return item.payload;
  }

  /**
   * Writes a Yahoo cache entry.
   *
   * @throws {import('@dinkel/shared').YahooCacheTtlError} when the requested TTL
   *   exceeds the 24-hour ceiling. Refusing loudly rather than clamping keeps a
   *   caller's wrong assumption visible.
   */
  async putCached(
    cacheKey: string,
    resource: string,
    payload: unknown,
    ttlSeconds: number,
    nowSeconds = Math.floor(Date.now() / 1000),
  ): Promise<void> {
    const ttl = assertCacheTtl(ttlSeconds);

    await this.put({
      PK: `YAHOO_CACHE#${cacheKey}`,
      SK: 'CACHE',
      entity: 'YahooCacheEntry',
      cacheKey,
      resource,
      payload,
      fetchedAt: new Date(nowSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, ''),
      expiresAt: nowSeconds + ttl,
    });
  }

  /** Clears cache entries for a prefix, e.g. on a manual refresh. */
  async invalidateCache(cacheKeys: readonly string[]): Promise<void> {
    await Promise.all(
      cacheKeys.map((cacheKey) => this.delete({ PK: `YAHOO_CACHE#${cacheKey}`, SK: 'CACHE' })),
    );
  }
}

export { YAHOO_CACHE_MAX_TTL_SECONDS };

function isConditionalCheckFailed(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name: string }).name === 'ConditionalCheckFailedException'
  );
}

function isTransactionConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) return false;
  const name = (error as { name: string }).name;
  return name === 'TransactionCanceledException' || name === 'ConditionalCheckFailedException';
}
