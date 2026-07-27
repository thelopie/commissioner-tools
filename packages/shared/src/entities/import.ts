import { z } from 'zod';
import { internalIdSchema } from '../ids.js';
import { auditableSchema, isoTimestampSchema } from './common.js';

/**
 * CSV import is the only migration mechanism into the portal.
 *
 * There is no Google Sheets integration, no Drive access, no spreadsheet
 * synchronization, and no write-back. A commissioner exports CSV from whatever
 * they use and imports it here. After a successful import the original file is
 * not required and the uploaded copy is deleted.
 */

/** The kinds of data a commissioner can import. Each has a downloadable template. */
export const importKindSchema = z.enum([
  'seasons',
  'managers',
  'league_rules',
  'prize_rules',
  'weekly_challenge_definitions',
  'historical_challenge_winners',
  'dues',
  'payouts',
  'draft_history',
]);
export type ImportKind = z.infer<typeof importKindSchema>;

export const importBatchStatusSchema = z.enum([
  /** File uploaded, headers parsed, awaiting column mapping. */
  'uploaded',
  /** Validated without writing. Row results show exactly what would happen. */
  'dry_run_complete',
  /** Applied to the database. */
  'committed',
  /** Reverted. Only possible while nothing else depends on the rows. */
  'rolled_back',
  /** Validation found blocking problems; nothing was written. */
  'failed',
  /** Abandoned before commit. */
  'cancelled',
]);
export type ImportBatchStatus = z.infer<typeof importBatchStatusSchema>;

/** Maps a CSV column to a target field. Mapping is always explicit, never guessed. */
export const columnMappingSchema = z.object({
  /** Header text exactly as it appeared in the file. */
  sourceHeader: z.string().min(1).max(200),
  /** Target field on the destination entity, or null to ignore the column. */
  targetField: z.string().min(1).max(80).nullable(),
});
export type ColumnMapping = z.infer<typeof columnMappingSchema>;

export const importBatchSchema = auditableSchema.extend({
  entity: z.literal('ImportBatch'),
  importBatchId: internalIdSchema,
  leagueId: internalIdSchema,

  kind: importKindSchema,
  status: importBatchStatusSchema,

  /** Original filename, for the commissioner's own recognition. */
  fileName: z.string().min(1).max(300),
  fileSizeBytes: z.number().int().min(0),
  /** SHA-256 of the file. Detects a re-upload of an identical file. */
  fileSha256: z.string().length(64),

  /**
   * S3 key of the temporarily stored upload, encrypted at rest.
   *
   * Cleared once the object is deleted. Uploads are removed by lifecycle policy
   * after the documented retention window; the file is not needed post-import.
   */
  uploadS3Key: z.string().max(500).nullable().default(null),
  uploadDeletedAt: isoTimestampSchema.optional(),

  detectedHeaders: z.array(z.string().max(200)).default([]),
  columnMappings: z.array(columnMappingSchema).default([]),

  totalRows: z.number().int().min(0).default(0),
  validRows: z.number().int().min(0).default(0),
  errorRows: z.number().int().min(0).default(0),
  /** Rows that would overwrite an existing record. Requires an explicit decision. */
  conflictRows: z.number().int().min(0).default(0),
  /** Rows already imported previously by external key — skipped, not duplicated. */
  duplicateRows: z.number().int().min(0).default(0),

  createdRecordCount: z.number().int().min(0).default(0),
  updatedRecordCount: z.number().int().min(0).default(0),
  skippedRecordCount: z.number().int().min(0).default(0),

  /**
   * How conflicts are resolved on commit. Chosen deliberately by the
   * commissioner after seeing the dry run — there is no silent overwrite.
   */
  conflictResolution: z
    .enum(['skip_conflicts', 'overwrite_conflicts', 'fail_on_conflict'])
    .default('fail_on_conflict'),

  dryRunAt: isoTimestampSchema.optional(),
  committedAt: isoTimestampSchema.optional(),
  committedByUserId: internalIdSchema.optional(),
  rolledBackAt: isoTimestampSchema.optional(),
  rolledBackByUserId: internalIdSchema.optional(),
  /** Why rollback was refused, when it was. */
  rollbackBlockedReason: z.string().max(500).optional(),

  /** Blocking, file-level problem — wrong headers, not UTF-8, empty file. */
  failureReason: z.string().max(1000).optional(),
});
export type ImportBatch = z.infer<typeof importBatchSchema>;

export const importRowOutcomeSchema = z.enum([
  'would_create',
  'would_update',
  'created',
  'updated',
  'skipped_duplicate',
  'skipped_conflict',
  'error',
]);
export type ImportRowOutcome = z.infer<typeof importRowOutcomeSchema>;

/** Per-row result. Errors are row-scoped so one bad row never fails the file. */
export const importRowResultSchema = auditableSchema.extend({
  entity: z.literal('ImportRowResult'),
  importRowResultId: internalIdSchema,
  importBatchId: internalIdSchema,
  leagueId: internalIdSchema,

  /** 1-based row number in the source file, excluding the header. */
  rowNumber: z.number().int().min(1),
  outcome: importRowOutcomeSchema,

  /** Stable key derived from the row's identifying columns. Drives idempotency. */
  externalKey: z.string().max(256).optional(),

  /** The entity written, once written. Enables precise rollback. */
  targetEntity: z.string().max(60).optional(),
  targetId: internalIdSchema.optional(),

  /** Field-level validation failures for this row. */
  errors: z
    .array(
      z.object({
        field: z.string().max(80),
        message: z.string().max(300),
      }),
    )
    .default([]),

  /** What differs from the existing record, for conflict rows. */
  conflicts: z
    .array(
      z.object({
        field: z.string().max(80),
        existingValue: z.string().max(300),
        incomingValue: z.string().max(300),
      }),
    )
    .default([]),
});
export type ImportRowResult = z.infer<typeof importRowResultSchema>;
