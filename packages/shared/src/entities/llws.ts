import { z } from 'zod';
import { internalIdSchema, seasonYearSchema } from '../ids.js';
import { auditableSchema, externalKeySchema, isoTimestampSchema } from './common.js';

/**
 * The LLWS draft-order workflow.
 *
 * Dinkel decides fantasy draft order from the Little League World Series: each
 * manager is randomly assigned an LLWS team, the tournament plays out, and how
 * far your team advanced determines the order in which you *pick your draft slot*
 * — not the slot itself. So there are two ordered things kept distinct here:
 * selection order (who chooses first) and the draft position they choose.
 *
 * None of this touches Yahoo. No documented Yahoo endpoint writes draft order,
 * so the workflow's output is a printable order the commissioner enters manually.
 */

/** One team in the LLWS field for a season. Entered by hand or imported by CSV. */
export const llwsTeamSchema = auditableSchema.extend({
  entity: z.literal('LLWSTeam'),
  llwsTeamId: internalIdSchema,
  leagueId: internalIdSchema,
  seasonYear: seasonYearSchema,

  /** e.g. "Southwest — Needville, TX". Dinkel's own data, typed in. */
  name: z.string().min(1).max(160),
  region: z.string().max(80).optional(),
  bracket: z.enum(['united_states', 'international', 'unknown']).default('unknown'),

  /**
   * How far the team got. Set after the tournament; drives selection order.
   * Lower is better: 1 = champion.
   */
  finishRank: z.number().int().min(1).max(64).optional(),
  /** Human label for the finish, e.g. "Eliminated in pool play". */
  finishLabel: z.string().max(120).optional(),
  eliminatedAt: isoTimestampSchema.optional(),

  externalKey: externalKeySchema.optional(),
  importBatchId: internalIdSchema.optional(),
});
export type LLWSTeam = z.infer<typeof llwsTeamSchema>;

/**
 * A manager's assigned LLWS team.
 *
 * Assignment is one-to-one in both directions and enforced as such: a team
 * cannot back two managers and a manager cannot hold two teams.
 */
export const llwsAssignmentSchema = auditableSchema.extend({
  entity: z.literal('LLWSAssignment'),
  assignmentId: internalIdSchema,
  leagueId: internalIdSchema,
  seasonYear: seasonYearSchema,

  leagueMemberId: internalIdSchema,
  llwsTeamId: internalIdSchema,

  /**
   * The randomization seed that produced this assignment run.
   *
   * Recorded so the draw is reproducible and auditable: anyone can re-run the
   * same seed and confirm nobody's team was quietly swapped afterwards.
   */
  randomizationSeed: z.string().min(1).max(200),
  /** Which draw produced it — all assignments from one run share this. */
  randomizationRunId: internalIdSchema,
  assignedAt: isoTimestampSchema,

  /** Assignments are private until the commissioner publishes them. */
  publishedAt: isoTimestampSchema.optional(),

  /** Set when a commissioner hand-placed this rather than drawing it. */
  overrideId: internalIdSchema.optional(),

  externalKey: externalKeySchema.optional(),
  importBatchId: internalIdSchema.optional(),
});
export type LLWSAssignment = z.infer<typeof llwsAssignmentSchema>;

/** Tiebreakers when two LLWS teams finished level. */
export const draftOrderTieBreakerSchema = z.enum([
  /** Prior season's final standing, worst first. */
  'worse_prior_season_finish',
  /** Reverse of prior season's finish, best first. */
  'better_prior_season_finish',
  /** Another seeded coin flip, recorded like the original draw. */
  'seeded_random',
  /** Commissioner decides and records a reason. */
  'commissioner_decides',
]);
export type DraftOrderTieBreaker = z.infer<typeof draftOrderTieBreakerSchema>;

/**
 * One manager's turn to choose a fantasy draft slot.
 *
 * Turns open sequentially: only the manager whose turn is `open` may select, and
 * a selection locks once made so a later change cannot cascade into someone
 * else's slot.
 */
export const draftPositionSelectionSchema = auditableSchema.extend({
  entity: z.literal('DraftPositionSelection'),
  selectionId: internalIdSchema,
  leagueId: internalIdSchema,
  seasonYear: seasonYearSchema,

  leagueMemberId: internalIdSchema,

  /** 1-based order in which this manager chooses. Derived from LLWS finishes. */
  selectionOrder: z.number().int().min(1).max(32),

  /** The fantasy draft slot chosen. Null until they pick. */
  chosenDraftPosition: z.number().int().min(1).max(32).nullable(),

  status: z.enum([
    /** Earlier turns still outstanding. */
    'waiting',
    /** This manager may pick now. */
    'open',
    /** Picked and locked. */
    'locked',
    /** Commissioner picked on their behalf. */
    'commissioner_assigned',
    /** Turn passed without a pick; commissioner resolves. */
    'skipped',
  ]),

  openedAt: isoTimestampSchema.optional(),
  /** Advisory deadline for the turn. Nothing auto-expires in v1. */
  deadlineAt: isoTimestampSchema.optional(),
  selectedAt: isoTimestampSchema.optional(),
  lockedAt: isoTimestampSchema.optional(),

  /** Count of reminders sent. v1 records intent to remind; it does not send mail. */
  remindersSent: z.number().int().min(0).default(0),
  lastReminderAt: isoTimestampSchema.optional(),

  /** How this manager's place in line was decided. */
  derivedFrom: z.object({
    llwsTeamId: internalIdSchema.optional(),
    llwsFinishRank: z.number().int().min(1).max(64).optional(),
    appliedTieBreaker: draftOrderTieBreakerSchema.optional(),
    explanation: z.string().max(500).default(''),
  }),

  overrideId: internalIdSchema.optional(),

  externalKey: externalKeySchema.optional(),
  importBatchId: internalIdSchema.optional(),
});
export type DraftPositionSelection = z.infer<typeof draftPositionSelectionSchema>;
