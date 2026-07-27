import { Hono } from 'hono';
import {
  AppError,
  generateId,
  isSettled,
  moneySchema,
  paymentMethodSchema,
  paymentStatusSchema,
  seasonYearSchema,
  weekNumberSchema,
  type InternalId,
} from '@dinkel/shared';
import { z } from 'zod';
import type { AppEnv } from '../context.js';
import { requireLeagueId } from '../context.js';
import { requireAuthenticated, requireCommissioner } from '../lib/authorization.js';
import { created } from '../repositories.js';
import { parseJson } from './auth.js';

/**
 * League operations: dues, payouts, tasks, announcements, and recaps.
 *
 * Dues and payouts are bookkeeping only. The portal records that money moved
 * elsewhere; it never processes a payment, holds funds, takes a percentage, or
 * integrates a payment processor.
 */

export const leagueOpsRoutes = new Hono<AppEnv>();

const isoNow = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, '');

// ------------------------------------------------------------------ seasons

leagueOpsRoutes.get('/api/seasons', async (c) => {
  const ctx = c.get('ctx');
  requireAuthenticated(ctx.principal);
  const leagueId = requireLeagueId(ctx);

  const seasons = await ctx.repositories.leagues.listSeasons(leagueId);
  return c.json({ seasons });
});

leagueOpsRoutes.put('/api/seasons/:seasonYear', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));

  const body = await parseJson(
    c,
    z.object({
      status: z
        .enum(['planned', 'draft_pending', 'in_progress', 'complete', 'archived'])
        .optional(),
      buyIn: moneySchema.optional(),
      teamCount: z.number().int().min(2).max(32).optional(),
      draftDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      /** Best-first finish order, Dinkel-owned so draft tiebreaks survive. */
      finalFinishOrder: z.array(z.string().length(26)).optional(),
    }),
  );

  const existing = await ctx.repositories.leagues.findSeason(leagueId, seasonYear);
  const actorId = principal.userId as InternalId;

  const season = {
    entity: 'Season' as const,
    seasonId: existing?.seasonId ?? generateId(),
    leagueId,
    seasonYear,
    status: body.status ?? existing?.status ?? ('planned' as const),
    buyIn: body.buyIn ?? existing?.buyIn ?? { amountCents: 0, currency: 'USD' as const },
    finalFinishOrder:
      (body.finalFinishOrder as InternalId[] | undefined) ?? existing?.finalFinishOrder ?? [],
    ...(body.teamCount === undefined ? {} : { teamCount: body.teamCount }),
    ...(body.draftDate === undefined ? {} : { draftDate: body.draftDate }),
    ...(existing
      ? {
          createdAt: existing.createdAt,
          createdBy: existing.createdBy,
          updatedAt: isoNow(),
          updatedBy: actorId,
          version: existing.version + 1,
        }
      : created(actorId)),
  };

  await ctx.repositories.leagues.saveSeason(season, existing?.version);

  await ctx.repositories.audit.record({
    leagueId,
    action: existing ? 'season.updated' : 'season.created',
    actorUserId: actorId,
    actorRole: principal.role,
    summary: `${existing ? 'Updated' : 'Created'} the ${seasonYear} season.`,
    correlationId: ctx.correlationId,
    targetEntity: 'Season',
    targetId: String(seasonYear),
  });

  return c.json({ season });
});

// --------------------------------------------------------------------- dues

leagueOpsRoutes.get('/api/dues/:seasonYear', async (c) => {
  const ctx = c.get('ctx');
  requireAuthenticated(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));

  const dues = await ctx.repositories.money.listDues(leagueId, seasonYear);

  return c.json({
    dues,
    summary: {
      totalOwedCents: dues.reduce((total, record) => total + record.amountOwed.amountCents, 0),
      totalPaidCents: dues.reduce((total, record) => total + record.amountPaid.amountCents, 0),
      unpaidCount: dues.filter(
        (record) => record.status === 'unpaid' || record.status === 'partial',
      ).length,
    },
    note: 'Bookkeeping only — the portal does not process payments.',
  });
});

leagueOpsRoutes.post('/api/dues/:seasonYear', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));

  const body = await parseJson(
    c,
    z.object({
      duesRecordId: z.string().length(26).optional(),
      leagueMemberId: z.string().length(26),
      amountOwed: moneySchema,
      amountPaid: moneySchema.optional(),
      status: paymentStatusSchema.optional(),
      dueDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      method: paymentMethodSchema.optional(),
      note: z.string().max(1000).optional(),
    }),
  );

  const actorId = principal.userId as InternalId;
  const existing = body.duesRecordId
    ? await ctx.repositories.money.findDues(leagueId, seasonYear, body.duesRecordId as InternalId)
    : null;

  const amountPaid = body.amountPaid ??
    existing?.amountPaid ?? { amountCents: 0, currency: 'USD' as const };

  const record = {
    entity: 'DuesRecord' as const,
    duesRecordId: (body.duesRecordId as InternalId | undefined) ?? generateId(),
    leagueId,
    seasonYear,
    leagueMemberId: body.leagueMemberId as InternalId,
    amountOwed: body.amountOwed,
    amountPaid,
    // Derived from the amounts when not stated, so status and money cannot drift.
    status: body.status ?? derivePaymentStatus(body.amountOwed.amountCents, amountPaid.amountCents),
    recordedByUserId: actorId,
    ...(body.dueDate === undefined ? {} : { dueDate: body.dueDate }),
    ...(body.method === undefined ? {} : { method: body.method }),
    ...(body.note === undefined ? {} : { note: body.note }),
    ...(amountPaid.amountCents > 0 ? { paidAt: existing?.paidAt ?? isoNow() } : {}),
    ...(existing
      ? {
          createdAt: existing.createdAt,
          createdBy: existing.createdBy,
          updatedAt: isoNow(),
          updatedBy: actorId,
          version: existing.version + 1,
        }
      : created(actorId)),
  };

  await ctx.repositories.money.saveDues(record, existing?.version);

  await ctx.repositories.audit.record({
    leagueId,
    action: existing ? 'dues.updated' : 'dues.recorded',
    actorUserId: actorId,
    actorRole: principal.role,
    summary: `Recorded dues of ${formatCents(body.amountOwed.amountCents)} (${record.status}).`,
    correlationId: ctx.correlationId,
    targetEntity: 'DuesRecord',
    targetId: record.duesRecordId,
    detail: { status: record.status, amountOwedCents: body.amountOwed.amountCents },
  });

  return c.json({ dues: record }, existing ? 200 : 201);
});

// ------------------------------------------------------------------ payouts

leagueOpsRoutes.get('/api/payouts/:seasonYear', async (c) => {
  const ctx = c.get('ctx');
  requireAuthenticated(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));

  const payouts = await ctx.repositories.money.listPayouts(leagueId, seasonYear);

  return c.json({
    payouts,
    summary: {
      pendingCount: payouts.filter((record) => !isSettled(record.status)).length,
      totalCents: payouts.reduce((total, record) => total + record.amount.amountCents, 0),
    },
    note: 'Bookkeeping only — the portal does not transfer money.',
  });
});

leagueOpsRoutes.post('/api/payouts/:seasonYear', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));

  const body = await parseJson(
    c,
    z.object({
      payoutRecordId: z.string().length(26).optional(),
      leagueMemberId: z.string().length(26),
      reason: z.string().min(1).max(200),
      amount: moneySchema,
      status: paymentStatusSchema.default('unpaid'),
      method: paymentMethodSchema.optional(),
      week: weekNumberSchema.optional(),
      challengeResultId: z.string().length(26).optional(),
      prizeRuleId: z.string().length(26).optional(),
      note: z.string().max(1000).optional(),
    }),
  );

  const actorId = principal.userId as InternalId;
  const existing = body.payoutRecordId
    ? await ctx.repositories.money.findPayout(
        leagueId,
        seasonYear,
        body.payoutRecordId as InternalId,
      )
    : null;

  const record = {
    entity: 'PayoutRecord' as const,
    payoutRecordId: (body.payoutRecordId as InternalId | undefined) ?? generateId(),
    leagueId,
    seasonYear,
    leagueMemberId: body.leagueMemberId as InternalId,
    reason: body.reason,
    amount: body.amount,
    status: body.status,
    ...(body.method === undefined ? {} : { method: body.method }),
    ...(body.week === undefined ? {} : { week: body.week }),
    ...(body.challengeResultId === undefined
      ? {}
      : { challengeResultId: body.challengeResultId as InternalId }),
    ...(body.prizeRuleId === undefined ? {} : { prizeRuleId: body.prizeRuleId as InternalId }),
    ...(body.note === undefined ? {} : { note: body.note }),
    ...(isSettled(body.status) ? { paidAt: existing?.paidAt ?? isoNow() } : {}),
    ...(existing
      ? {
          createdAt: existing.createdAt,
          createdBy: existing.createdBy,
          updatedAt: isoNow(),
          updatedBy: actorId,
          version: existing.version + 1,
        }
      : created(actorId)),
  };

  await ctx.repositories.money.savePayout(record, existing?.version);

  /**
   * Marking a payout settled locks the challenge result behind it.
   *
   * From this point a Yahoo stat correction cannot silently rewrite who won —
   * the engine raises a conflict for the commissioner instead, because the portal
   * must never claim someone won money they never received.
   */
  if (isSettled(body.status) && body.challengeResultId && body.week !== undefined) {
    const results = await ctx.repositories.challenges.listResults(leagueId, seasonYear, body.week);
    const target = results.find((result) => result.challengeResultId === body.challengeResultId);

    if (target && !target.payoutSettled) {
      await ctx.repositories.challenges.saveResult(
        {
          ...target,
          payoutSettled: true,
          updatedAt: isoNow(),
          updatedBy: actorId,
          version: target.version + 1,
        },
        target.version,
      );
    }
  }

  await ctx.repositories.audit.record({
    leagueId,
    action: isSettled(body.status)
      ? 'payout.settled'
      : existing
        ? 'payout.updated'
        : 'payout.recorded',
    actorUserId: actorId,
    actorRole: principal.role,
    summary: `${isSettled(body.status) ? 'Settled' : 'Recorded'} payout of ${formatCents(body.amount.amountCents)} for "${body.reason}".`,
    correlationId: ctx.correlationId,
    targetEntity: 'PayoutRecord',
    targetId: record.payoutRecordId,
    detail: { status: body.status, amountCents: body.amount.amountCents },
  });

  return c.json({ payout: record }, existing ? 200 : 201);
});

// -------------------------------------------------------------------- tasks

leagueOpsRoutes.get('/api/tasks', async (c) => {
  const ctx = c.get('ctx');
  requireAuthenticated(ctx.principal);
  const leagueId = requireLeagueId(ctx);

  const tasks = await ctx.repositories.ops.listTasks(leagueId);
  const open = tasks.filter((task) => task.status === 'open' || task.status === 'in_progress');

  return c.json({ tasks, openCount: open.length });
});

leagueOpsRoutes.post('/api/tasks', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);

  const body = await parseJson(
    c,
    z.object({
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
      dueDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    }),
  );

  const actorId = principal.userId as InternalId;
  const task = {
    entity: 'CommissionerTask' as const,
    taskId: generateId(),
    leagueId,
    title: body.title,
    category: body.category,
    priority: body.priority,
    status: 'open' as const,
    ...(body.detail === undefined ? {} : { detail: body.detail }),
    ...(body.dueDate === undefined ? {} : { dueDate: body.dueDate }),
    ...created(actorId),
  };

  await ctx.repositories.ops.saveTask(task);
  return c.json({ task }, 201);
});

leagueOpsRoutes.put('/api/tasks/:taskId', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const taskId = c.req.param('taskId') as InternalId;

  const body = await parseJson(
    c,
    z.object({ status: z.enum(['open', 'in_progress', 'done', 'dismissed']) }),
  );

  const existing = await ctx.repositories.ops.findTask(leagueId, taskId);
  if (!existing) throw new AppError('not_found', { publicMessage: 'No such task.' });

  const actorId = principal.userId as InternalId;

  await ctx.repositories.ops.saveTask(
    {
      ...existing,
      status: body.status,
      ...(body.status === 'done' ? { completedAt: isoNow(), completedByUserId: actorId } : {}),
      updatedAt: isoNow(),
      updatedBy: actorId,
      version: existing.version + 1,
    },
    existing.version,
  );

  return c.json({ ok: true });
});

// ------------------------------------------------------------- announcements

leagueOpsRoutes.get('/api/announcements', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireAuthenticated(ctx.principal);
  const leagueId = requireLeagueId(ctx);

  const announcements = await ctx.repositories.ops.listAnnouncements(leagueId);

  // Drafts are visible only to commissioners: an unpublished announcement is not
  // league communication yet.
  const visible =
    principal.role === 'commissioner'
      ? announcements
      : announcements.filter((announcement) => announcement.status === 'published');

  return c.json({ announcements: visible });
});

leagueOpsRoutes.post('/api/announcements', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);

  const body = await parseJson(
    c,
    z.object({
      title: z.string().min(1).max(200),
      body: z.string().min(1).max(20_000),
      publish: z.boolean().default(false),
      pinned: z.boolean().default(false),
    }),
  );

  const actorId = principal.userId as InternalId;
  const announcement = {
    entity: 'Announcement' as const,
    announcementId: generateId(),
    leagueId,
    title: body.title,
    body: body.body,
    status: body.publish ? ('published' as const) : ('draft' as const),
    pinned: body.pinned,
    audience: 'everyone' as const,
    ...(body.publish ? { publishedAt: isoNow(), publishedByUserId: actorId } : {}),
    ...created(actorId),
  };

  await ctx.repositories.ops.saveAnnouncement(announcement);

  if (body.publish) {
    await ctx.repositories.audit.record({
      leagueId,
      action: 'announcement.published',
      actorUserId: actorId,
      actorRole: principal.role,
      summary: `Published announcement "${body.title}".`,
      correlationId: ctx.correlationId,
      targetEntity: 'Announcement',
      targetId: announcement.announcementId,
    });
  }

  // No email or SMS is sent. Notification delivery is deliberately deferred, so
  // the portal never surprises a league with a message it did not expect.
  return c.json({ announcement, delivered: false }, 201);
});

function derivePaymentStatus(owedCents: number, paidCents: number): 'unpaid' | 'partial' | 'paid' {
  if (paidCents <= 0) return 'unpaid';
  if (paidCents >= owedCents) return 'paid';
  return 'partial';
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  return `${sign}$${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

export { derivePaymentStatus, formatCents };
