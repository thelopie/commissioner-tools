import { z } from 'zod';
import { internalIdSchema, seasonYearSchema, weekNumberSchema } from '../ids.js';
import { auditableSchema, externalKeySchema, isoDateSchema, isoTimestampSchema } from './common.js';

/** A thing the commissioner needs to do. The dashboard prioritizes these. */
export const commissionerTaskSchema = auditableSchema.extend({
  entity: z.literal('CommissionerTask'),
  taskId: internalIdSchema,
  leagueId: internalIdSchema,
  seasonYear: seasonYearSchema.optional(),

  title: z.string().min(1).max(200),
  detail: z.string().max(2000).optional(),

  category: z.enum([
    'dues',
    'payouts',
    'draft',
    'challenges',
    'yahoo_connection',
    'import',
    'announcement',
    'other',
  ]),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  status: z.enum(['open', 'in_progress', 'done', 'dismissed']).default('open'),

  dueDate: isoDateSchema.optional(),
  assignedToUserId: internalIdSchema.optional(),
  completedAt: isoTimestampSchema.optional(),
  completedByUserId: internalIdSchema.optional(),

  /**
   * Set when the system opened this task rather than a person — an OAuth health
   * check failing, or an import finishing with row errors. Lets the portal
   * close it automatically once the underlying condition clears.
   */
  systemSource: z.string().max(120).optional(),
  /** Dedupe key so a recurring check does not pile up identical tasks. */
  idempotencyKey: z.string().max(200).optional(),
});
export type CommissionerTask = z.infer<typeof commissionerTaskSchema>;

export const announcementSchema = auditableSchema.extend({
  entity: z.literal('Announcement'),
  announcementId: internalIdSchema,
  leagueId: internalIdSchema,
  seasonYear: seasonYearSchema.optional(),

  title: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),

  status: z.enum(['draft', 'published', 'archived']).default('draft'),
  publishedAt: isoTimestampSchema.optional(),
  publishedByUserId: internalIdSchema.optional(),

  /** Keeps an announcement at the top of the dashboard. */
  pinned: z.boolean().default(false),
  /** Advisory only in v1: nothing is emailed or texted. */
  audience: z.enum(['everyone', 'managers', 'commissioners']).default('everyone'),
});
export type Announcement = z.infer<typeof announcementSchema>;

/**
 * A weekly recap.
 *
 * The fact pack is computed by this application from Yahoo data. Prose is
 * optional and, when enabled, written by Claude *from that fact pack* — the
 * model never computes a score, a ranking, or a winner, and never sees a reason
 * to invent one. Recaps are reviewable and require explicit publication; v1
 * sends no email or SMS.
 */
export const recapFactSchema = z.object({
  /** Machine-readable fact key, e.g. `highest_score`. */
  key: z.string().min(1).max(80),
  /** Human label, e.g. "Highest score". */
  label: z.string().min(1).max(120),
  /** Rendered value, e.g. "142.6". Already formatted by this code. */
  value: z.string().min(1).max(300),
  /** Whose fact it is, when applicable. */
  leagueMemberId: internalIdSchema.optional(),
});
export type RecapFact = z.infer<typeof recapFactSchema>;

export const leagueRecapSchema = auditableSchema.extend({
  entity: z.literal('LeagueRecap'),
  recapId: internalIdSchema,
  leagueId: internalIdSchema,
  seasonYear: seasonYearSchema,
  week: weekNumberSchema,

  /** Validated structured facts. The only input prose generation may use. */
  facts: z.array(recapFactSchema).default([]),

  /** Deterministic prose assembled from the facts by template. Always present. */
  templateBody: z.string().max(20_000).default(''),

  /** Optional model-written prose. Null when generation is disabled or unused. */
  proseBody: z.string().max(20_000).nullable().default(null),
  proseModel: z.string().max(80).optional(),
  proseGeneratedAt: isoTimestampSchema.optional(),

  status: z.enum(['draft', 'in_review', 'published', 'archived']).default('draft'),
  reviewedByUserId: internalIdSchema.optional(),
  reviewedAt: isoTimestampSchema.optional(),
  publishedAt: isoTimestampSchema.optional(),

  externalKey: externalKeySchema.optional(),
  importBatchId: internalIdSchema.optional(),
});
export type LeagueRecap = z.infer<typeof leagueRecapSchema>;

/**
 * A durable league record, e.g. "most points in a week".
 *
 * These are Dinkel's own history: derived once, stored as a number plus a label,
 * with no Yahoo response retained. That is what lets the portal remember 2019
 * without keeping a warehouse of Yahoo data.
 */
export const historicalRecordSchema = auditableSchema.extend({
  entity: z.literal('HistoricalRecord'),
  recordId: internalIdSchema,
  leagueId: internalIdSchema,

  /** e.g. `most_points_week`, `longest_win_streak`. */
  key: z.string().min(1).max(80),
  label: z.string().min(1).max(160),

  value: z.number(),
  valueLabel: z.string().min(1).max(120),

  leagueMemberId: internalIdSchema.optional(),
  seasonYear: seasonYearSchema.optional(),
  week: weekNumberSchema.optional(),

  /** How this record was established. */
  source: z.enum(['calculated', 'csv_import', 'commissioner_entry']),

  externalKey: externalKeySchema.optional(),
  importBatchId: internalIdSchema.optional(),
});
export type HistoricalRecord = z.infer<typeof historicalRecordSchema>;
