import { z } from 'zod';
import { internalIdSchema, seasonYearSchema, weekNumberSchema } from '../ids.js';
import { auditableSchema, externalKeySchema, isoTimestampSchema } from './common.js';

/**
 * Yahoo data a challenge needs in order to be calculable.
 *
 * Each key corresponds to an entry in `yahoo-capabilities.json`. A challenge is
 * only allowed to leave `blocked` status when every capability it requires is
 * marked verified there. This is the mechanism that stops the portal inventing
 * data: no field, no challenge.
 */
export const yahooCapabilityKeySchema = z.enum([
  /** Per-team fantasy points for a week (scoreboard / matchup). */
  'team_week_points',
  /** Win/loss/tie and opponent for a week. */
  'matchup_result',
  /** Which roster slot a player occupied, including bench (`BN`). */
  'roster_selected_position',
  /** A player's fantasy points for a given week within league scoring. */
  'player_week_points',
  /** A player's eligible position(s) — RB, TE, QB, DEF. */
  'player_position',
  /** A player's projected fantasy points for a week. */
  'player_projected_points',
  /** A team's projected fantasy points for a week. */
  'team_projected_points',
  /** Individual raw stat values by Yahoo stat id (receptions, TDs, yards). */
  'player_stat_by_id',
]);
export type YahooCapabilityKey = z.infer<typeof yahooCapabilityKeySchema>;

/**
 * How a winner is computed.
 *
 * Every variant is pure arithmetic implemented in `@dinkel/challenge-engine`.
 * A language model is never involved in determining a winner — it may only
 * describe an outcome that this code already decided.
 */
export const calculationSchema = z.discriminatedUnion('type', [
  /** Highest-scoring individual starter on any roster. */
  z.object({ type: z.literal('highest_single_starter_score') }),

  /** Narrowest winning margin among the week's matchups. */
  z.object({ type: z.literal('smallest_margin_of_victory') }),

  /** Highest combined points from players left on the bench. */
  z.object({ type: z.literal('highest_bench_total') }),

  /** Highest combined points from starters at the given positions. */
  z.object({
    type: z.literal('highest_position_group_total'),
    positions: z.array(z.string().min(1).max(8)).min(1),
  }),

  /** Highest score among teams that lost their matchup. */
  z.object({ type: z.literal('highest_score_in_loss') }),

  /** Largest amount by which a team beat its projection. */
  z.object({ type: z.literal('largest_projection_overperformance') }),

  /** Closest to a target without exceeding it — Blackjack's 21. */
  z.object({
    type: z.literal('closest_to_target_without_exceeding'),
    target: z.number(),
    /** Whether the target applies to a whole team or a single starter. */
    subject: z.enum(['team', 'starter']),
  }),

  /** Closest to a target in either direction. */
  z.object({
    type: z.literal('closest_to_target'),
    target: z.number().optional(),
    /** When set, the target is each team's own projected total. */
    targetIsTeamProjection: z.boolean().default(false),
    subject: z.enum(['team', 'starter']),
  }),

  /** Highest total of one raw Yahoo stat across starters. */
  z.object({
    type: z.literal('highest_stat_total'),
    yahooStatId: z.number().int().min(0),
    statLabel: z.string().min(1).max(60),
  }),

  /** Largest share of a team's points coming from one stat, e.g. touchdowns. */
  z.object({
    type: z.literal('highest_stat_share_of_points'),
    yahooStatIds: z.array(z.number().int().min(0)).min(1),
    statLabel: z.string().min(1).max(60),
    pointsPerUnit: z.number(),
    /** Guards against a tiny denominator producing a meaningless ratio. */
    minimumTeamPoints: z.number().min(0).default(0),
  }),
]);
export type Calculation = z.infer<typeof calculationSchema>;

/** Which direction wins. */
export const objectiveSchema = z.enum(['maximize', 'minimize']);
export type Objective = z.infer<typeof objectiveSchema>;

/** Ordered tiebreakers, applied in sequence until one separates the leaders. */
export const tieBreakerSchema = z.enum([
  /** Lower seed / worse record wins — rewards the underdog. */
  'worse_record',
  /** Higher total team points for the week. */
  'higher_team_points',
  /** Lower total team points for the week. */
  'lower_team_points',
  /** Fewer prior wins of this same challenge in the season. */
  'fewer_prior_wins_this_season',
  /** Split the prize between everyone still tied. */
  'split_prize',
  /** Stop and require a commissioner decision. */
  'commissioner_decides',
]);
export type TieBreaker = z.infer<typeof tieBreakerSchema>;

export const challengeStatusSchema = z.enum([
  /** Being drafted; not calculated. */
  'draft',
  /** Calculable and in use. */
  'active',
  /** Required Yahoo data is unverified, so no math runs. Never guessed. */
  'blocked',
  /** Previously used, kept for historical records. */
  'retired',
]);
export type ChallengeStatus = z.infer<typeof challengeStatusSchema>;

export const overridePolicySchema = z.enum([
  /** Commissioner may override before finalization only. */
  'before_finalization',
  /** Commissioner may override at any time, with a recorded reason. */
  'always_with_reason',
  /** No overrides; the arithmetic stands. */
  'never',
]);
export type OverridePolicy = z.infer<typeof overridePolicySchema>;

export const weeklyChallengeDefinitionSchema = auditableSchema.extend({
  entity: z.literal('WeeklyChallengeDefinition'),
  challengeDefinitionId: internalIdSchema,
  leagueId: internalIdSchema,

  /** Stable slug, e.g. `one-man-army`. Survives renames; used in URLs. */
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/, 'lowercase letters, digits, and hyphens only'),
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),

  /** Which season this definition applies to. Rules drift; history stays honest. */
  seasonYear: seasonYearSchema,

  /**
   * Weeks the challenge runs. Empty means every regular-season week.
   * A one-week special (a Thanksgiving challenge) lists a single week.
   */
  weeks: z.array(weekNumberSchema).default([]),

  /** Plain-language eligibility, plus the machine-checkable parts below. */
  eligibility: z.object({
    description: z.string().max(1000).default(''),
    /** Exclude teams whose dues are unpaid. Off by default — that is a policy call. */
    requiresDuesPaid: z.boolean().default(false),
    /** A manager may win this challenge at most N times per season. 0 = unlimited. */
    maxWinsPerSeason: z.number().int().min(0).default(0),
    /** Restrict to specific league members. Empty means everyone. */
    limitedToLeagueMemberIds: z.array(internalIdSchema).default([]),
  }),

  requiredYahooData: z.array(yahooCapabilityKeySchema).min(1),
  calculation: calculationSchema,
  objective: objectiveSchema,
  tieBreakers: z.array(tieBreakerSchema).default(['commissioner_decides']),

  /** Bench players count toward the value. Bench Mob sets this true. */
  benchCounts: z.boolean(),
  /** Fractional points count. False rounds to whole points before comparing. */
  decimalsCount: z.boolean(),
  /** Negative values are eligible. A -2 can win a minimize challenge. */
  negativesCount: z.boolean(),

  /**
   * Whether a Yahoo stat correction can change this outcome. True schedules a
   * delayed recalculation; the result stays provisional until that window closes.
   */
  statCorrectionsCanChangeOutcome: z.boolean(),

  status: challengeStatusSchema,
  /** Set when status is `blocked`: which capability is missing and why. */
  blockedReason: z.string().max(500).optional(),

  overridePolicy: overridePolicySchema,

  /** Prize for winning, when the season pays these out. */
  prizeRuleId: internalIdSchema.optional(),

  externalKey: externalKeySchema.optional(),
  importBatchId: internalIdSchema.optional(),
});
export type WeeklyChallengeDefinition = z.infer<typeof weeklyChallengeDefinitionSchema>;

/**
 * One competitor's computed value, with enough detail to explain the result.
 *
 * Transient by design: this is what the engine returns and the UI renders, and
 * it is NOT persisted. Keeping every competitor's Yahoo-derived value forever
 * would be a Yahoo data warehouse in miniature, and the finalized record only
 * needs the limited derived values below. Re-run the calculation to see the full
 * board again while Yahoo still serves the week.
 */
export const challengeStandingSchema = z.object({
  leagueMemberId: internalIdSchema,
  /** The comparable number this challenge produced. */
  value: z.number(),
  /** Human-readable arithmetic, e.g. "Starters: 14.2 + 9.8 + 3.0 = 27.0". */
  explanation: z.string().max(1000),
  /** 1-based rank after objective and tiebreakers. Ties share a rank. */
  rank: z.number().int().min(1),
  eligible: z.boolean(),
  /** Why this competitor was excluded, when not eligible. */
  ineligibleReason: z.string().max(300).optional(),
});
export type ChallengeStanding = z.infer<typeof challengeStandingSchema>;

export const challengeResultStatusSchema = z.enum([
  /** Computed, but Yahoo may still correct stats. Not payable. */
  'provisional',
  /** Commissioner accepted the outcome. Payable. */
  'finalized',
  /** Commissioner replaced the computed winner, with a recorded reason. */
  'overridden',
  /** Blocked challenge: recorded so the gap is visible, with no winner. */
  'not_calculable',
]);
export type ChallengeResultStatus = z.infer<typeof challengeResultStatusSchema>;

/**
 * A finalized (or provisional) challenge outcome.
 *
 * Stores only derived values — season, week, challenge, winning member, winning
 * value, timestamps, approval, and the explanation string. The Yahoo response
 * used to compute it is never persisted, per Yahoo's 24-hour retention rule.
 */
export const weeklyChallengeResultSchema = auditableSchema.extend({
  entity: z.literal('WeeklyChallengeResult'),
  challengeResultId: internalIdSchema,
  leagueId: internalIdSchema,
  seasonYear: seasonYearSchema,
  week: weekNumberSchema,
  challengeDefinitionId: internalIdSchema,
  /** Denormalized so historical results read correctly after a rename. */
  challengeSlug: z.string().min(1).max(60),

  status: challengeResultStatusSchema,

  /** Multiple winners when a tie is settled by splitting the prize. */
  winningLeagueMemberIds: z.array(internalIdSchema).default([]),
  winningValue: z.number().optional(),
  /**
   * How the winner was reached, including which tiebreaker applied.
   *
   * A sentence of arithmetic — "Bench: 12.4 + 9.8 + 6.2 = 28.4, ahead of 26.1" —
   * which is a limited derived value, not a copy of the Yahoo response. This is
   * what makes a 2021 result defensible years later without retaining Yahoo data.
   */
  explanation: z.string().max(2000).default(''),

  /** How many competitors were ranked, for context without retaining their values. */
  competitorCount: z.number().int().min(0).default(0),

  /** True when the top value was shared before tiebreakers ran. */
  wasTied: z.boolean().default(false),
  appliedTieBreaker: tieBreakerSchema.optional(),

  calculatedAt: isoTimestampSchema,
  /** Bumped on each recalculation, e.g. after a Yahoo stat correction. */
  calculationCount: z.number().int().min(1).default(1),
  /** Set when a recalculation changed the winner or value. */
  lastChangedAt: isoTimestampSchema.optional(),

  finalizedAt: isoTimestampSchema.optional(),
  finalizedByUserId: internalIdSchema.optional(),

  /** Set when status is `not_calculable`. */
  notCalculableReason: z.string().max(500).optional(),

  /**
   * True once a payout for this result has settled. The engine refuses to
   * silently change a settled result; it raises a conflict for the commissioner.
   */
  payoutSettled: z.boolean().default(false),

  externalKey: externalKeySchema.optional(),
  importBatchId: internalIdSchema.optional(),
});
export type WeeklyChallengeResult = z.infer<typeof weeklyChallengeResultSchema>;

/**
 * A commissioner's deliberate deviation from what the arithmetic produced.
 *
 * Every override is a first-class, permanent record with a reason. Overrides are
 * never applied by editing the result in place and losing what the math said.
 */
export const commissionerOverrideSchema = auditableSchema.extend({
  entity: z.literal('CommissionerOverride'),
  overrideId: internalIdSchema,
  leagueId: internalIdSchema,

  target: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('challenge_result'),
      challengeResultId: internalIdSchema,
      seasonYear: seasonYearSchema,
      week: weekNumberSchema,
    }),
    z.object({
      kind: z.literal('draft_position_selection'),
      selectionId: internalIdSchema,
      seasonYear: seasonYearSchema,
    }),
    z.object({
      kind: z.literal('llws_assignment'),
      assignmentId: internalIdSchema,
      seasonYear: seasonYearSchema,
    }),
    z.object({
      kind: z.literal('dues_record'),
      duesRecordId: internalIdSchema,
      seasonYear: seasonYearSchema,
    }),
    z.object({
      kind: z.literal('payout_record'),
      payoutRecordId: internalIdSchema,
      seasonYear: seasonYearSchema,
    }),
  ]),

  /** What the computation said. */
  computedSummary: z.string().max(1000),
  /** What the commissioner decided instead. */
  overriddenSummary: z.string().max(1000),
  /** Required. An override without a stated reason is not accepted. */
  reason: z.string().min(1).max(2000),

  overriddenByUserId: internalIdSchema,
  overriddenAt: isoTimestampSchema,

  /** True when this override changed an outcome whose payout had settled. */
  affectedSettledPayout: z.boolean().default(false),
});
export type CommissionerOverride = z.infer<typeof commissionerOverrideSchema>;
