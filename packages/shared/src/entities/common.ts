import { z } from 'zod';
import { internalIdSchema } from '../ids.js';

/** ISO-8601 timestamp in UTC. Stored as a string so DynamoDB sorts it lexically. */
export const isoTimestampSchema = z.string().datetime({ offset: false });
export type IsoTimestamp = z.infer<typeof isoTimestampSchema>;

/** Calendar date with no time component, e.g. a dues deadline. */
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
export type IsoDate = z.infer<typeof isoDateSchema>;

/**
 * Money in integer cents.
 *
 * Never a float: a $12.34 buy-in read back as 12.339999999999998 would corrupt
 * dues reconciliation. Currency is always USD for this league; the field exists
 * so a future league is not stuck with a hidden assumption.
 */
export const moneySchema = z.object({
  amountCents: z.number().int(),
  currency: z.literal('USD').default('USD'),
});
export type Money = z.infer<typeof moneySchema>;

/** Fields present on every persisted entity. */
export const auditableSchema = z.object({
  createdAt: isoTimestampSchema,
  createdBy: internalIdSchema,
  updatedAt: isoTimestampSchema,
  updatedBy: internalIdSchema,
  /**
   * Optimistic-concurrency version. Every write asserts the version it read,
   * so two commissioners editing the same record cannot silently clobber each
   * other — the loser gets a conflict and re-reads.
   */
  version: z.number().int().min(1),
});
export type Auditable = z.infer<typeof auditableSchema>;

/**
 * Stable key from the source system for imported rows.
 *
 * This is what makes CSV imports idempotent: re-importing the same spreadsheet
 * matches on `externalKey` and updates in place instead of creating duplicates.
 */
export const externalKeySchema = z.string().min(1).max(256);
