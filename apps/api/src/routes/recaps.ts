import { Hono } from 'hono';
import { AppError, seasonYearSchema, weekNumberSchema, type InternalId } from '@dinkel/shared';
import { z } from 'zod';
import type { AppEnv } from '../context.js';
import { requireLeagueId } from '../context.js';
import { requireAuthenticated, requireCommissioner } from '../lib/authorization.js';
import { buildRecap } from '../jobs/recap.js';
import { parseJson } from './auth.js';

/**
 * Weekly recaps.
 *
 * A recap is drafted by the weekly job and reviewed by a person before anyone else
 * sees it. That review step is the point: the fact pack is computed in code and is
 * trustworthy, but prose written from it still deserves a human read before it is
 * published to the league.
 *
 * Publishing makes a recap visible in the portal. It sends nothing.
 */

export const recapRoutes = new Hono<AppEnv>();

const isoNow = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, '');

recapRoutes.get('/api/recaps/:seasonYear', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireAuthenticated(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));

  const recaps = await ctx.repositories.ops.listRecaps(leagueId, seasonYear);

  /**
   * Drafts are commissioner-only.
   *
   * An unreviewed recap is not league communication, and model-written prose that
   * nobody has read yet is exactly the thing not to publish by accident.
   */
  const visible =
    principal.role === 'commissioner'
      ? recaps
      : recaps.filter((recap) => recap.status === 'published');

  return c.json({
    recaps: [...visible].sort((a, b) => b.week - a.week),
    note: 'Publishing shows a recap in the portal. Nothing is emailed or texted.',
  });
});

/**
 * Drafts (or redrafts) a week's recap now, rather than waiting for the schedule.
 *
 * The same builder the job uses, so a manual draft and a scheduled one cannot differ.
 * Refuses to overwrite a recap somebody has already published.
 */
recapRoutes.post('/api/recaps/:seasonYear/:week/draft', async (c) => {
  const ctx = c.get('ctx');
  requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));
  const week = weekNumberSchema.parse(Number(c.req.param('week')));

  const existing = await ctx.repositories.ops.findRecap(leagueId, seasonYear, week);
  if (existing?.status === 'published') {
    throw new AppError('conflict', {
      publicMessage:
        'That recap is already published. Redrafting it would replace what the league has read.',
    });
  }

  const recap = await buildRecap(
    {
      config: ctx.config,
      table: ctx.table,
      repositories: ctx.repositories,
      yahoo: ctx.yahoo,
      logger: ctx.logger,
      correlationId: ctx.correlationId,
      scheduledAt: isoNow(),
      leagueId,
    },
    week,
    existing ?? null,
  );

  return c.json({ recap });
});

/** Publishes a reviewed recap, or sends it back to draft. */
recapRoutes.post('/api/recaps/:seasonYear/:week/publish', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));
  const week = weekNumberSchema.parse(Number(c.req.param('week')));

  const body = await parseJson(
    c,
    z.object({
      /** The prose as reviewed. Edits are kept; the model's draft is not sacred. */
      body: z.string().min(1).max(20_000).optional(),
      publish: z.boolean().default(true),
    }),
  );

  const recap = await ctx.repositories.ops.findRecap(leagueId, seasonYear, week);
  if (!recap) throw new AppError('not_found', { publicMessage: 'No recap for that week yet.' });

  const actorId = principal.userId as InternalId;

  await ctx.repositories.ops.saveRecap(
    {
      ...recap,
      // A commissioner's edit replaces the prose, and is recorded as theirs.
      ...(body.body === undefined ? {} : { proseBody: body.body }),
      status: body.publish ? 'published' : 'draft',
      reviewedByUserId: actorId,
      reviewedAt: isoNow(),
      ...(body.publish ? { publishedAt: isoNow() } : {}),
      updatedAt: isoNow(),
      updatedBy: actorId,
      version: recap.version + 1,
    },
    recap.version,
  );

  await ctx.repositories.audit.record({
    leagueId,
    action: body.publish ? 'recap.published' : 'recap.returned_to_draft',
    actorUserId: actorId,
    actorRole: principal.role,
    summary: body.publish
      ? `Published the week ${week} recap.`
      : `Sent the week ${week} recap back to draft.`,
    correlationId: ctx.correlationId,
    targetEntity: 'LeagueRecap',
    targetId: recap.recapId,
  });

  return c.json({ ok: true, status: body.publish ? 'published' : 'draft' });
});
