import { z } from 'zod';
import {
  internalIdSchema,
  seasonYearSchema,
  yahooGameKeySchema,
  yahooGuidSchema,
  yahooLeagueKeySchema,
} from '../ids.js';
import {
  auditableSchema,
  externalKeySchema,
  isoDateSchema,
  isoTimestampSchema,
  moneySchema,
} from './common.js';

/** The league itself. One row for the Dinkel league; the model supports more. */
export const leagueSchema = auditableSchema.extend({
  entity: z.literal('League'),
  leagueId: internalIdSchema,
  /** Dinkel's own name for the league, not Yahoo's. */
  name: z.string().min(1).max(120),
  timezone: z.string().min(1).default('America/New_York'),
  /** Season the portal currently operates on. */
  currentSeasonYear: seasonYearSchema.optional(),
});
export type League = z.infer<typeof leagueSchema>;

export const seasonSchema = auditableSchema.extend({
  entity: z.literal('Season'),
  seasonId: internalIdSchema,
  leagueId: internalIdSchema,
  seasonYear: seasonYearSchema,

  status: z.enum(['planned', 'draft_pending', 'in_progress', 'complete', 'archived']),

  buyIn: moneySchema,
  teamCount: z.number().int().min(2).max(32).optional(),

  regularSeasonWeeks: z.number().int().min(1).max(22).optional(),
  playoffStartWeek: z.number().int().min(1).max(22).optional(),

  /** Set once the LLWS workflow produces a final order. */
  draftOrderFinalizedAt: isoTimestampSchema.optional(),
  draftDate: isoDateSchema.optional(),

  /**
   * Final finish order for the season, best first, as league member IDs.
   *
   * Dinkel-owned on purpose: the draft-order workflow breaks LLWS ties by prior
   * season finish, and Yahoo standings cannot be retained past 24 hours. A
   * commissioner records this at season close, or it arrives via CSV for legacy
   * seasons — so the tiebreaker still works in 2035 for a 2019 season.
   */
  finalFinishOrder: z.array(internalIdSchema).default([]),

  /** Present for legacy seasons imported from the spreadsheet. */
  externalKey: externalKeySchema.optional(),
  importBatchId: internalIdSchema.optional(),
});
export type Season = z.infer<typeof seasonSchema>;

/**
 * A stored Yahoo OAuth connection for one portal user.
 *
 * Access and refresh tokens are encrypted with AES-256-GCM before they reach
 * this shape's `encryptedAccessToken` / `encryptedRefreshToken` fields; plaintext
 * tokens exist only in memory inside the API. The refresh token is never sent to
 * the browser under any circumstance.
 */
export const yahooConnectionSchema = auditableSchema.extend({
  entity: z.literal('YahooConnection'),
  connectionId: internalIdSchema,
  userId: internalIdSchema,
  yahooGuid: yahooGuidSchema,

  encryptedAccessToken: z.string().min(1),
  encryptedRefreshToken: z.string().min(1),
  accessTokenExpiresAt: isoTimestampSchema,

  /**
   * Scope string Yahoo actually granted. Recorded so a future read/write request
   * is verifiable rather than assumed — the portal treats itself as read-only.
   */
  grantedScope: z.string().optional(),

  /**
   * Bumped whenever Yahoo rotates the refresh token on a refresh call. Rotation
   * is optional in Yahoo's implementation, so this doubles as evidence of what
   * actually happens in practice.
   */
  refreshTokenRotations: z.number().int().min(0).default(0),

  lastRefreshedAt: isoTimestampSchema.optional(),
  lastSuccessAt: isoTimestampSchema.optional(),
  lastFailureAt: isoTimestampSchema.optional(),
  /** Safe, user-facing failure summary. Never contains a token or secret. */
  lastFailureReason: z.string().max(500).optional(),

  status: z.enum(['active', 'needs_reconnect', 'revoked']),
});
export type YahooConnection = z.infer<typeof yahooConnectionSchema>;

/**
 * Links a Dinkel season to the Yahoo league that backs it.
 *
 * Separate from `Season` so that re-linking a Yahoo league — or losing access to
 * it — never mutates Dinkel's own season record. Nothing here is hardcoded: the
 * game key, league key, and season all come from the commissioner's selection.
 */
export const yahooLeagueLinkSchema = auditableSchema.extend({
  entity: z.literal('YahooLeagueLink'),
  linkId: internalIdSchema,
  leagueId: internalIdSchema,
  seasonYear: seasonYearSchema,

  yahooGameKey: yahooGameKeySchema,
  yahooLeagueKey: yahooLeagueKeySchema,

  /** Which user's connection is used for league reads. */
  connectionUserId: internalIdSchema,

  /**
   * Whether that Yahoo account is the Yahoo-side commissioner. Recorded for
   * diagnostics only — it grants nothing in this portal.
   */
  yahooCommissionerHint: z.boolean().optional(),

  linkedAt: isoTimestampSchema,
  status: z.enum(['active', 'inactive']),
});
export type YahooLeagueLink = z.infer<typeof yahooLeagueLinkSchema>;

/**
 * A league rule in Dinkel's own words.
 *
 * Yahoo holds scoring settings; this holds the human agreements Yahoo cannot
 * express — keeper terms, trade etiquette, punishment for last place.
 */
export const leagueRuleSchema = auditableSchema.extend({
  entity: z.literal('LeagueRule'),
  ruleId: internalIdSchema,
  leagueId: internalIdSchema,

  /** Rules are season-scoped so history stays truthful when a rule changes. */
  effectiveSeasonYear: seasonYearSchema,
  supersededSeasonYear: seasonYearSchema.optional(),

  category: z.enum([
    'scoring',
    'roster',
    'waivers',
    'trades',
    'draft',
    'dues',
    'payouts',
    'challenges',
    'conduct',
    'other',
  ]),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
  sortOrder: z.number().int().min(0).default(0),

  externalKey: externalKeySchema.optional(),
  importBatchId: internalIdSchema.optional(),
});
export type LeagueRule = z.infer<typeof leagueRuleSchema>;

/** How one slice of the prize pool is defined for a season. */
export const prizeRuleSchema = auditableSchema.extend({
  entity: z.literal('PrizeRule'),
  prizeRuleId: internalIdSchema,
  leagueId: internalIdSchema,
  seasonYear: seasonYearSchema,

  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),

  kind: z.enum([
    'champion',
    'runner_up',
    'third_place',
    'regular_season_best_record',
    'most_points',
    'weekly_challenge',
    'last_place_penalty',
    'other',
  ]),

  /** Fixed amount, or a share of the pool. Exactly one is set. */
  amount: moneySchema.optional(),
  poolPercentage: z.number().min(0).max(100).optional(),

  /** For per-week prizes such as weekly challenges. */
  perWeek: z.boolean().default(false),

  sortOrder: z.number().int().min(0).default(0),
  externalKey: externalKeySchema.optional(),
  importBatchId: internalIdSchema.optional(),
});
export type PrizeRule = z.infer<typeof prizeRuleSchema>;
