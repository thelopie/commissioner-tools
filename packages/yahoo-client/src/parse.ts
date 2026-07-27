import { AppError } from '@dinkel/shared';

/**
 * Yahoo Fantasy JSON normalization.
 *
 * Yahoo's `format=json` output is XML mechanically converted to JSON, which
 * produces two shapes that ordinary parsing handles badly:
 *
 *  1. Collections arrive as numeric-keyed objects with a sibling `count`:
 *       { "0": { "team": ... }, "1": { "team": ... }, "count": 2 }
 *     ...but sometimes as real arrays. Both occur, so both are handled.
 *
 *  2. A single entity arrives as an ARRAY of partial objects that must be
 *     merged, interleaved with sub-collections:
 *       [ { "team_key": "..." }, { "name": "..." }, { "managers": {...} } ]
 *
 * Everything below is defensive by design: Yahoo's exact shapes are only
 * documented in an archived guide, so the parsers tolerate missing optional
 * fields and surface a clear `yahoo_unexpected_response` when a required one is
 * absent, rather than silently producing `undefined` deep in a calculation.
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function isRecord(value: unknown): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a Yahoo collection as a plain array.
 *
 * Handles the numeric-keyed-object form, the genuine-array form, and a single
 * bare item. Returns an empty array for null or absent input: an empty league
 * list is a legitimate answer, not an error.
 */
export function collect(value: unknown): Json[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.filter((item) => item !== null);

  if (isRecord(value)) {
    const numericKeys = Object.keys(value)
      .filter((key) => /^\d+$/.test(key))
      .sort((a, b) => Number(a) - Number(b));

    if (numericKeys.length > 0) {
      return numericKeys.map((key) => value[key]!).filter((item) => item !== null);
    }

    // A collection wrapper with only `count: 0` and no numeric keys.
    if ('count' in value) return [];

    // A single bare object where a collection was expected.
    return [value];
  }

  return [];
}

/**
 * Merges Yahoo's array-of-partials into one flat object.
 *
 * Nested arrays are flattened one level, which is how Yahoo wraps a team as
 * `[[{...}, {...}], {...}]`. Later keys win, matching Yahoo's own ordering where
 * more specific values appear later.
 */
export function mergeParts(value: unknown): Record<string, Json> {
  const merged: Record<string, Json> = {};

  const absorb = (item: unknown, depth: number): void => {
    if (depth > 4) return;
    if (Array.isArray(item)) {
      for (const element of item) absorb(element, depth + 1);
      return;
    }
    if (isRecord(item)) {
      for (const [key, val] of Object.entries(item)) {
        if (val === null || val === undefined) continue;
        merged[key] = val;
      }
    }
  };

  absorb(value, 0);
  return merged;
}

/**
 * Reads a property from a node that may not be an object.
 *
 * Yahoo collections hold heterogeneous entries — usually `{ team: [...] }`, but
 * occasionally a bare value — so indexing directly is not type-safe.
 */
export function pick(node: Json, key: string): Json | undefined {
  return isRecord(node) ? node[key] : undefined;
}

/** Reads `fantasy_content`, the envelope on every Yahoo Fantasy response. */
export function fantasyContent(body: unknown): Record<string, Json> {
  if (!isRecord(body) || !isRecord(body['fantasy_content'])) {
    throw new AppError('yahoo_unexpected_response', {
      detail: { reason: 'missing_fantasy_content' },
    });
  }
  return body['fantasy_content'];
}

/** A required string field. Yahoo sometimes returns numbers where strings are documented. */
export function requireString(
  source: Record<string, Json>,
  field: string,
  context: string,
): string {
  const value = source[field];
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);

  throw new AppError('yahoo_unexpected_response', {
    publicMessage: 'Yahoo returned league data in an unexpected shape. Nothing was changed.',
    detail: { reason: 'missing_field', field, context },
  });
}

/** An optional string field. */
export function optionalString(source: Record<string, Json>, field: string): string | undefined {
  const value = source[field];
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/**
 * A numeric field, tolerating Yahoo's habit of returning numbers as strings.
 *
 * An empty string means "no value" in Yahoo's output — notably for a player who
 * did not play — and maps to undefined rather than 0, because a 0 would quietly
 * enter a challenge calculation as a real score.
 */
export function optionalNumber(source: Record<string, Json>, field: string): number | undefined {
  const value = source[field];
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === '-') return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Yahoo booleans appear as 0/1, "0"/"1", and true/false. */
export function optionalBoolean(source: Record<string, Json>, field: string): boolean | undefined {
  const value = source[field];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    if (value === '1' || value === 'true') return true;
    if (value === '0' || value === 'false') return false;
  }
  return undefined;
}

/**
 * Walks a chain of collection wrappers.
 *
 * Yahoo nests as `users -> user -> games -> game -> leagues -> league`, where
 * each plural is a collection and each singular is an array of partials. This
 * turns that into a flat list of merged objects at the requested depth.
 *
 * @example
 * // users;use_login=1/games/leagues
 * descend(content, ['users', 'user', 'games', 'game', 'leagues', 'league'])
 */
export function descend(
  root: Record<string, Json>,
  path: readonly string[],
): Record<string, Json>[] {
  let current: Record<string, Json>[] = [root];

  for (const segment of path) {
    const next: Record<string, Json>[] = [];

    for (const node of current) {
      const child = node[segment];
      if (child === undefined || child === null) continue;

      // The two shapes are distinguished by JSON type, which tracks Yahoo's own
      // plural/singular naming:
      //
      //   `users`, `teams`, `players` — numeric-keyed object: MANY entities
      //   `user`,  `team`,  `player`  — real array: ONE entity's partial objects
      //
      // Collecting an array would split a single team into a dozen fragments,
      // each holding one field, which is precisely the bug this distinction
      // prevents.
      if (Array.isArray(child)) {
        next.push(mergeParts(child));
      } else {
        next.push(...collect(child).map((item) => mergeParts(item)));
      }
    }

    current = next;
  }

  return current;
}
