import { z } from 'zod';
import { internalIdSchema } from '../ids.js';
import { isoTimestampSchema } from './common.js';

/**
 * Every privileged action writes one of these.
 *
 * Audit records are append-only: no route updates or deletes them. They are the
 * mechanism by which a future commissioner can reconstruct why the league looks
 * the way it does — who granted whom access, who overrode a result, who marked a
 * payout settled.
 */
export const auditActionSchema = z.enum([
  // Authentication and access
  'user.signed_in',
  'user.signed_out',
  'user.display_name_confirmed',
  'commissioner.bootstrapped',
  'commissioner.granted',
  'commissioner.revoked',
  'commissioner.primary_transferred',
  'user.invited',
  'user.invite_revoked',
  'user.role_changed',
  'user.disabled',

  // Yahoo connection
  'yahoo.connection_created',
  'yahoo.connection_deleted',
  'yahoo.token_refreshed',
  'yahoo.refresh_token_rotated',
  'yahoo.connection_failed',
  'yahoo.league_linked',
  'yahoo.league_unlinked',

  // League configuration
  'season.created',
  'season.updated',
  'rule.created',
  'rule.updated',
  'prize_rule.created',
  'prize_rule.updated',

  // Money bookkeeping — records only; the portal moves no money
  'dues.recorded',
  'dues.updated',
  'payout.recorded',
  'payout.updated',
  'payout.settled',

  // Challenges
  'challenge.definition_created',
  'challenge.definition_updated',
  'challenge.calculated',
  'challenge.recalculated',
  'challenge.finalized',
  'challenge.overridden',
  'challenge.settled_result_change_blocked',

  // LLWS and draft order
  'llws.team_created',
  'llws.assignments_drawn',
  'llws.assignments_published',
  'llws.finish_recorded',
  'draft_order.calculated',
  'draft_order.turn_opened',
  'draft_order.selection_locked',
  'draft_order.reminder_recorded',
  'draft_order.finalized',
  'draft_order.overridden',

  // Imports
  'import.uploaded',
  'import.dry_run',
  'import.committed',
  'import.rolled_back',
  'import.rollback_blocked',

  // Content
  'announcement.published',
  'recap.generated',
  'recap.published',

  // Scheduled work
  'scheduled_job.started',
  'scheduled_job.succeeded',
  'scheduled_job.failed',
  'scheduled_job.replayed',

  // Data subject rights
  'data.exported',
  'data.deleted',
]);
export type AuditAction = z.infer<typeof auditActionSchema>;

export const auditLogSchema = z.object({
  entity: z.literal('AuditLog'),
  auditLogId: internalIdSchema,
  leagueId: internalIdSchema,

  action: auditActionSchema,
  at: isoTimestampSchema,

  /** Who did it. Null for scheduled jobs acting without a user. */
  actorUserId: internalIdSchema.nullable(),
  /** Role held at the time, so a later role change does not rewrite history. */
  actorRole: z.enum(['commissioner', 'manager', 'readonly', 'system']),

  /** What was acted on. */
  targetEntity: z.string().max(60).optional(),
  targetId: z.string().max(64).optional(),

  /** Human-readable summary written at the time of the action. */
  summary: z.string().min(1).max(1000),

  /**
   * Structured detail. Values are scalars only, and a redaction pass runs before
   * write: no tokens, secrets, or raw Yahoo payloads may enter an audit record.
   */
  detail: z.record(z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).default({}),

  /** Ties this record to the request or job execution that produced it. */
  correlationId: z.string().min(1).max(64),

  /** Present for user-initiated actions. Truncated; never a full fingerprint. */
  sourceIpPrefix: z.string().max(45).optional(),
});
export type AuditLog = z.infer<typeof auditLogSchema>;
