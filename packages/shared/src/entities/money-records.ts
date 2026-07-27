import { z } from 'zod';
import { internalIdSchema, seasonYearSchema, weekNumberSchema } from '../ids.js';
import {
  auditableSchema,
  externalKeySchema,
  isoDateSchema,
  isoTimestampSchema,
  moneySchema,
} from './common.js';

/**
 * Dues and payouts are internal administrative bookkeeping only.
 *
 * The portal records that money changed hands outside the portal. It does not
 * process payments, hold funds, move money, take a percentage, or integrate a
 * payment processor — deliberately, both to keep this a simple league tool and
 * because Yahoo's API terms prohibit gambling-adjacent use and commercialization
 * without written permission.
 */

export const paymentStatusSchema = z.enum(['unpaid', 'partial', 'paid', 'waived', 'refunded']);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

/** How a commissioner says the money actually moved. Descriptive, not executable. */
export const paymentMethodSchema = z.enum(['cash', 'venmo', 'zelle', 'paypal', 'check', 'other']);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const duesRecordSchema = auditableSchema.extend({
  entity: z.literal('DuesRecord'),
  duesRecordId: internalIdSchema,
  leagueId: internalIdSchema,
  seasonYear: seasonYearSchema,

  /** Who owes. A league member, which may or may not map to a portal user. */
  leagueMemberId: internalIdSchema,

  amountOwed: moneySchema,
  amountPaid: moneySchema,
  status: paymentStatusSchema,

  dueDate: isoDateSchema.optional(),
  paidAt: isoTimestampSchema.optional(),
  method: paymentMethodSchema.optional(),

  /** Free-text commissioner note, e.g. "paid at the draft, covered Mike too". */
  note: z.string().max(1000).optional(),

  /** Set when a commissioner recorded this on someone's behalf. */
  recordedByUserId: internalIdSchema.optional(),

  externalKey: externalKeySchema.optional(),
  importBatchId: internalIdSchema.optional(),
});
export type DuesRecord = z.infer<typeof duesRecordSchema>;

export const payoutRecordSchema = auditableSchema.extend({
  entity: z.literal('PayoutRecord'),
  payoutRecordId: internalIdSchema,
  leagueId: internalIdSchema,
  seasonYear: seasonYearSchema,

  /** Who gets paid. */
  leagueMemberId: internalIdSchema,

  /** The prize rule this satisfies, when it came from the season's structure. */
  prizeRuleId: internalIdSchema.optional(),

  /** Set for weekly-challenge payouts so a result links to its money. */
  week: weekNumberSchema.optional(),
  challengeResultId: internalIdSchema.optional(),

  reason: z.string().min(1).max(200),
  amount: moneySchema,
  status: paymentStatusSchema,

  paidAt: isoTimestampSchema.optional(),
  method: paymentMethodSchema.optional(),
  note: z.string().max(1000).optional(),

  externalKey: externalKeySchema.optional(),
  importBatchId: internalIdSchema.optional(),
});
export type PayoutRecord = z.infer<typeof payoutRecordSchema>;

/**
 * True once money has actually gone out for a payout.
 *
 * The challenge engine consults this before letting a recalculation change a
 * result: a paid outcome cannot be silently rewritten by a Yahoo stat correction
 * three days later. It requires an explicit commissioner decision instead.
 */
export function isSettled(status: PaymentStatus): boolean {
  return status === 'paid' || status === 'refunded';
}
