import { z } from 'zod';

/**
 * Identifier discipline.
 *
 * Internal Dinkel identifiers and Yahoo identifiers are deliberately distinct
 * types. Yahoo keys are opaque strings owned by Yahoo whose format can change;
 * internal IDs are ours forever. Nothing in this codebase uses a Yahoo key as a
 * primary key, so a Yahoo league can be re-linked or replaced without rewriting
 * Dinkel history.
 */

/** A Yahoo game key, e.g. the per-season NFL game. Format is Yahoo's to change. */
export const yahooGameKeySchema = z.string().min(1).max(32).brand<'YahooGameKey'>();
export type YahooGameKey = z.infer<typeof yahooGameKeySchema>;

/** A Yahoo league key, conventionally `{game_key}.l.{league_id}`. */
export const yahooLeagueKeySchema = z.string().min(3).max(64).brand<'YahooLeagueKey'>();
export type YahooLeagueKey = z.infer<typeof yahooLeagueKeySchema>;

/** A Yahoo team key, conventionally `{league_key}.t.{team_id}`. */
export const yahooTeamKeySchema = z.string().min(3).max(64).brand<'YahooTeamKey'>();
export type YahooTeamKey = z.infer<typeof yahooTeamKeySchema>;

/**
 * A Yahoo GUID identifying a Yahoo user.
 *
 * Per the Yahoo API Terms of Use this is one of the few values storable
 * indefinitely, which is exactly why portal identity keys on it. See
 * `yahoo-capabilities.json` and the retention notes in README.md.
 */
export const yahooGuidSchema = z.string().min(1).max(128).brand<'YahooGuid'>();
export type YahooGuid = z.infer<typeof yahooGuidSchema>;

/** Internal identifier: a ULID-like sortable random string. */
export const internalIdSchema = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'must be a ULID')
  .brand<'InternalId'>();
export type InternalId = z.infer<typeof internalIdSchema>;

/**
 * The actor recorded when a schedule did something, not a person.
 *
 * Audit and `createdBy` fields require an id, and a scheduled job has no user. A
 * reserved all-zero ULID keeps those fields honestly typed while being obviously
 * not an account — it cannot collide with a generated id, and a reader seeing it in
 * an audit row can tell at a glance that nobody clicked anything.
 */
export const SYSTEM_ACTOR_ID = '00000000000000000000000000' as InternalId;

/** An NFL season year, e.g. 2026. */
export const seasonYearSchema = z.number().int().min(1990).max(2100);
export type SeasonYear = z.infer<typeof seasonYearSchema>;

/** An NFL week number. 18 regular-season weeks since 2021; playoffs extend past. */
export const weekNumberSchema = z.number().int().min(1).max(22);
export type WeekNumber = z.infer<typeof weekNumberSchema>;

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generates a ULID: 48-bit timestamp then 80 bits of randomness, so IDs sort
 * chronologically inside a DynamoDB partition without needing a separate
 * created-at sort key.
 *
 * @param now - Millisecond timestamp, injectable so tests are deterministic.
 * @param randomBytes - Randomness source, injectable for the same reason.
 */
export function generateId(
  now: number = Date.now(),
  randomBytes: (size: number) => Uint8Array = defaultRandomBytes,
): InternalId {
  let timestamp = '';
  let remaining = now;
  for (let i = 0; i < 10; i += 1) {
    timestamp = ULID_ALPHABET[remaining % 32] + timestamp;
    remaining = Math.floor(remaining / 32);
  }

  const bytes = randomBytes(16);
  let random = '';
  for (let i = 0; i < 16; i += 1) {
    random += ULID_ALPHABET[bytes[i]! % 32];
  }

  return internalIdSchema.parse(timestamp + random);
}

function defaultRandomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}
