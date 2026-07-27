import { z } from 'zod';

/**
 * Short-lived Yahoo cache.
 *
 * This is the ONLY place Yahoo-derived content may live, and it lives on a
 * DynamoDB TTL. There is no permanent table for players, rosters, matchups,
 * standings, transactions, draft results, or weekly statistics — those are
 * fetched on demand and allowed to expire.
 *
 * The ceiling is a hard 24 hours, from the Yahoo API Terms of Use: data not
 * explicitly identified as storable indefinitely must be removed "within 24
 * hours after the time at which you obtained the data". Two values are exempt
 * and therefore live in real entities instead of here: the Yahoo GUID and the
 * token values.
 *
 * @see https://legal.yahoo.com/us/en/yahoo/terms/product-atos/apiforydn/index.html
 */

/** Hard upper bound on any Yahoo cache entry, in seconds. Not configurable upward. */
export const YAHOO_CACHE_MAX_TTL_SECONDS = 24 * 60 * 60;

/**
 * Default TTL, deliberately far below the ceiling.
 *
 * Live scores change constantly, so a long cache would be wrong for users even
 * if it were permitted. Per-resource overrides tune this; none may exceed the
 * ceiling above.
 */
export const YAHOO_CACHE_DEFAULT_TTL_SECONDS = 5 * 60;

/** Per-resource TTLs. Slow-changing resources cache longer, still under the cap. */
export const YAHOO_CACHE_TTL_SECONDS = {
  /** League metadata: name, scoring type, week count. Rarely changes mid-season. */
  league_metadata: 60 * 60,
  /** Teams and managers. Changes only when a manager joins or leaves. */
  league_teams: 30 * 60,
  /** The user's list of leagues. */
  user_leagues: 15 * 60,
  /** Standings. Settles after the week completes. */
  standings: 10 * 60,
  /** Scoreboard and matchups. Live during games. */
  scoreboard: 2 * 60,
  /** Rosters, including bench assignment. Live during games. */
  roster: 2 * 60,
  /** Player weekly stats. Live during games, and subject to later corrections. */
  player_stats: 2 * 60,
  /** Transactions: adds, drops, trades, waivers. */
  transactions: 5 * 60,
  /** Draft results. Immutable once the draft ends, but still Yahoo's data. */
  draft_results: 60 * 60,
} as const satisfies Record<string, number>;

export type YahooCacheResource = keyof typeof YAHOO_CACHE_TTL_SECONDS;

export class YahooCacheTtlError extends Error {
  constructor(requestedSeconds: number) {
    super(
      `Yahoo cache TTL of ${requestedSeconds}s exceeds the ${YAHOO_CACHE_MAX_TTL_SECONDS}s ceiling ` +
        `required by the Yahoo API Terms of Use. Yahoo-derived data cannot be retained longer.`,
    );
    this.name = 'YahooCacheTtlError';
  }
}

/**
 * Clamps and validates a requested TTL.
 *
 * Throws rather than silently clamping down from an over-long request: a caller
 * asking for 48 hours has a wrong mental model, and quietly storing 24 would
 * hide the bug. Values at or below the ceiling pass through unchanged.
 *
 * @throws {YahooCacheTtlError} when the request exceeds the 24-hour ceiling.
 */
export function assertCacheTtl(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new YahooCacheTtlError(seconds);
  }
  if (seconds > YAHOO_CACHE_MAX_TTL_SECONDS) {
    throw new YahooCacheTtlError(seconds);
  }
  return Math.floor(seconds);
}

/** TTL for a known resource, already validated against the ceiling. */
export function ttlForResource(resource: YahooCacheResource): number {
  return assertCacheTtl(YAHOO_CACHE_TTL_SECONDS[resource]);
}

/**
 * A cache entry.
 *
 * `expiresAt` is a Unix-second DynamoDB TTL attribute, so expiry is enforced by
 * the database rather than by application code remembering to check.
 */
export const yahooCacheEntrySchema = z.object({
  entity: z.literal('YahooCacheEntry'),
  /** Composite of resource plus the Yahoo keys and parameters that identify it. */
  cacheKey: z.string().min(1).max(512),
  resource: z.string().min(1).max(60),
  /** Parsed, normalized payload. Never the raw Yahoo response body. */
  payload: z.unknown(),
  fetchedAt: z.string().datetime({ offset: false }),
  /** Unix seconds. DynamoDB deletes the item at this time. */
  expiresAt: z.number().int().positive(),
});
export type YahooCacheEntry = z.infer<typeof yahooCacheEntrySchema>;
