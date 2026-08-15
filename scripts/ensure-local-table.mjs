#!/usr/bin/env node
/**
 * Creates the local DynamoDB table if it is missing.
 *
 * DynamoDB Local runs in memory by default, so every container restart loses the
 * table and the API starts failing with a `ResourceNotFoundException` that reads
 * like a bug in the app. This was a manual, undocumented step; now `npm run dev`
 * does it, and running this twice is harmless.
 *
 * The key schema mirrors `infrastructure/src/portal-stack.ts` exactly — PK/SK,
 * GSI1, GSI2, and the `expiresAt` TTL attribute that enforces Yahoo's retention
 * rule. Local and production diverging here would mean a query that works on one
 * and not the other.
 */

import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://127.0.0.1:8000';
const tableName = process.env.DYNAMODB_TABLE_NAME ?? 'lopie-portal-local';
const region = process.env.AWS_REGION ?? 'us-east-1';

/**
 * Built exactly like the application's own client: region and endpoint, and the
 * default credential chain.
 *
 * This matters more than it looks. DynamoDB Local partitions its data by access
 * key unless started with `-sharedDb`, so a script using different credentials
 * creates a table in a database the API cannot see — `DescribeTable` succeeds here
 * while the API still reports the table does not exist.
 */
const client = new DynamoDBClient({ region, endpoint });

async function main() {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    console.log(`DynamoDB table "${tableName}" already exists.`);
    return;
  } catch (error) {
    if (error?.name !== 'ResourceNotFoundException') throw error;
  }

  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'GSI1PK', AttributeType: 'S' },
        { AttributeName: 'GSI1SK', AttributeType: 'S' },
        { AttributeName: 'GSI2PK', AttributeType: 'S' },
        { AttributeName: 'GSI2SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'GSI2',
          KeySchema: [
            { AttributeName: 'GSI2PK', KeyType: 'HASH' },
            { AttributeName: 'GSI2SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );

  /**
   * TTL is not decoration here: it is the mechanism that enforces Yahoo's 24-hour
   * retention rule on cached responses. Local should expire them like production.
   */
  await client.send(
    new UpdateTimeToLiveCommand({
      TableName: tableName,
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    }),
  );

  console.log(`Created DynamoDB table "${tableName}" with GSI1, GSI2 and TTL.`);
}

main().catch((error) => {
  if (error?.name === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED') {
    console.error(
      `Could not reach DynamoDB Local at ${endpoint}.\n` +
        `Start it with:  docker start dynamodb-local\n` +
        `Or create it:   docker run -d --name dynamodb-local -p 8000:8000 amazon/dynamodb-local`,
    );
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});
