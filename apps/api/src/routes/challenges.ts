import { Hono } from 'hono';
import {
  AppError,
  generateId,
  seasonYearSchema,
  weekNumberSchema,
  type InternalId,
  type WeeklyChallengeDefinition,
} from '@dinkel/shared';
import {
  assertCanFinalize,
  assertCanOverride,
  CHALLENGE_PROPOSALS,
  proposalToDefinition,
} from '@dinkel/challenge-engine';
import { isCapabilityVerified } from '@dinkel/yahoo-client';
import { z } from 'zod';
import type { AppEnv } from '../context.js';
import { requireLeagueId } from '../context.js';
import { requireAuthenticated, requireCommissioner } from '../lib/authorization.js';
import { created } from '../repositories.js';
import { parseJson } from './auth.js';
import { calculateWeek } from '../services/challenge-calculation.js';

/**
 * Weekly challenges.
 *
 * The route's job is fetching, translating Yahoo data into the engine's plain
 * numeric input, and persisting the outcome. All arithmetic lives in
 * `@dinkel/challenge-engine`, deliberately: nothing here decides a winner, and no
 * language model is involved at any point.
 */

export const challengeRoutes = new Hono<AppEnv>();

const isoNow = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, '');

challengeRoutes.get('/api/challenges/:seasonYear', async (c) => {
  const ctx = c.get('ctx');
  requireAuthenticated(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));

  const definitions = await ctx.repositories.challenges.listDefinitions(leagueId, seasonYear);

  return c.json({
    definitions,
    blockedCount: definitions.filter((definition) => definition.status === 'blocked').length,
  });
});

/**
 * Seeds the thirteen proposed challenge definitions for a season.
 *
 * Each arrives with its status derived from the capability matrix, so a challenge
 * whose Yahoo data is unverified is stored as `blocked` with the reason attached.
 * Existing definitions are left alone — a commissioner's corrections must not be
 * reverted by re-running setup.
 */
challengeRoutes.post('/api/challenges/:seasonYear/seed', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));

  const actorId = principal.userId as InternalId;
  const existing = await ctx.repositories.challenges.listDefinitions(leagueId, seasonYear);
  const existingSlugs = new Set(existing.map((definition) => definition.slug));

  const seeded: string[] = [];

  for (const proposal of CHALLENGE_PROPOSALS) {
    if (existingSlugs.has(proposal.slug)) continue;

    const derived = proposalToDefinition(proposal, { isCapabilityVerified });

    await ctx.repositories.challenges.saveDefinition({
      entity: 'WeeklyChallengeDefinition',
      challengeDefinitionId: generateId(),
      leagueId,
      seasonYear,
      ...derived,
      ...created(actorId),
    } as WeeklyChallengeDefinition);

    seeded.push(proposal.slug);
  }

  await ctx.repositories.audit.record({
    leagueId,
    action: 'challenge.definition_created',
    actorUserId: actorId,
    actorRole: principal.role,
    summary: `Seeded ${seeded.length} challenge definitions for ${seasonYear}.`,
    correlationId: ctx.correlationId,
    detail: { seededCount: seeded.length, skippedCount: existingSlugs.size },
  });

  return c.json({
    seeded,
    skipped: [...existingSlugs],
    note: 'Proposed rules. Every knob is editable — correct them here rather than in code.',
  });
});

/** Updates a definition. This is how a commissioner corrects a proposed rule. */
challengeRoutes.put('/api/challenges/:seasonYear/:slug', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));
  const slug = c.req.param('slug');

  const body = await parseJson(
    c,
    z.object({
      name: z.string().min(1).max(120).optional(),
      description: z.string().min(1).max(2000).optional(),
      benchCounts: z.boolean().optional(),
      decimalsCount: z.boolean().optional(),
      negativesCount: z.boolean().optional(),
      weeks: z.array(weekNumberSchema).optional(),
      tieBreakers: z
        .array(
          z.enum([
            'worse_record',
            'higher_team_points',
            'lower_team_points',
            'fewer_prior_wins_this_season',
            'split_prize',
            'commissioner_decides',
          ]),
        )
        .optional(),
      eligibility: z
        .object({
          description: z.string().max(1000).optional(),
          requiresDuesPaid: z.boolean().optional(),
          maxWinsPerSeason: z.number().int().min(0).optional(),
        })
        .optional(),
      status: z.enum(['draft', 'active', 'retired']).optional(),
      overridePolicy: z.enum(['before_finalization', 'always_with_reason', 'never']).optional(),
    }),
  );

  const existing = await ctx.repositories.challenges.findDefinition(leagueId, seasonYear, slug);
  if (!existing)
    throw new AppError('not_found', { publicMessage: 'No such challenge definition.' });

  // A commissioner cannot activate a challenge whose Yahoo data is unverified.
  // Allowing it would let the portal produce a number nobody can defend.
  if (body.status === 'active') {
    const missing = existing.requiredYahooData.filter(
      (capability) => !isCapabilityVerified(capability),
    );
    if (missing.length > 0) {
      throw new AppError('yahoo_capability_unverified', {
        publicMessage:
          `This challenge cannot be activated yet: ${missing.join(', ')} has not been verified ` +
          `against a real Yahoo league.`,
      });
    }
  }

  const actorId = principal.userId as InternalId;
  const updatedDefinition: WeeklyChallengeDefinition = {
    ...existing,
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.description === undefined ? {} : { description: body.description }),
    ...(body.benchCounts === undefined ? {} : { benchCounts: body.benchCounts }),
    ...(body.decimalsCount === undefined ? {} : { decimalsCount: body.decimalsCount }),
    ...(body.negativesCount === undefined ? {} : { negativesCount: body.negativesCount }),
    ...(body.weeks === undefined ? {} : { weeks: body.weeks }),
    ...(body.tieBreakers === undefined ? {} : { tieBreakers: body.tieBreakers }),
    ...(body.status === undefined ? {} : { status: body.status }),
    ...(body.overridePolicy === undefined ? {} : { overridePolicy: body.overridePolicy }),
    ...(body.eligibility === undefined
      ? {}
      : { eligibility: { ...existing.eligibility, ...body.eligibility } }),
    updatedAt: isoNow(),
    updatedBy: actorId,
    version: existing.version + 1,
  };

  await ctx.repositories.challenges.saveDefinition(updatedDefinition, existing.version);

  await ctx.repositories.audit.record({
    leagueId,
    action: 'challenge.definition_updated',
    actorUserId: actorId,
    actorRole: principal.role,
    summary: `Updated challenge "${slug}" for ${seasonYear}.`,
    correlationId: ctx.correlationId,
    targetEntity: 'WeeklyChallengeDefinition',
    targetId: slug,
  });

  return c.json({ definition: updatedDefinition });
});

challengeRoutes.get('/api/challenges/:seasonYear/results/:week', async (c) => {
  const ctx = c.get('ctx');
  requireAuthenticated(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));
  const week = weekNumberSchema.parse(Number(c.req.param('week')));

  const results = await ctx.repositories.challenges.listResults(leagueId, seasonYear, week);

  /**
   * Winners are resolved to names here rather than in the browser.
   *
   * The stored result holds portal member IDs, which is what makes a 2021 result
   * still readable today — but an ID is not something anyone can read, and having
   * every client join it against a member list would put the same lookup in several
   * places and get it wrong somewhere.
   */
  const members = await ctx.repositories.leagues.listMembers(leagueId, seasonYear);
  const users = await ctx.repositories.users.listByLeague(leagueId);
  const userById = new Map(users.map((user) => [user.userId, user]));

  const nameOf = (memberId: string): string => {
    const member = members.find((candidate) => candidate.leagueMemberId === memberId);
    if (!member) return '(former member)';
    return (
      (member.userId ? userById.get(member.userId)?.displayName : undefined) ??
      member.legacyManagerName ??
      '(unnamed manager)'
    );
  };

  return c.json({
    results: results.map((result) => ({
      ...result,
      winners: result.winningLeagueMemberIds.map((memberId) => ({
        leagueMemberId: memberId,
        displayName: nameOf(memberId),
      })),
    })),
    /**
     * Everyone eligible to win, so the override form can offer a choice without a
     * second request. Ordered by name, since there is no meaningful rank here.
     */
    members: members
      .filter((member) => member.isActive)
      .map((member) => ({
        leagueMemberId: member.leagueMemberId,
        displayName: nameOf(member.leagueMemberId),
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
  });
});

/**
 * Calculates challenges for a week.
 *
 * Results are provisional: Yahoo issues stat corrections days after games, so a
 * winner is not payable until a commissioner finalizes it.
 */
challengeRoutes.post('/api/challenges/:seasonYear/calculate/:week', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));
  const week = weekNumberSchema.parse(Number(c.req.param('week')));

  /**
   * The work happens in `challenge-calculation`, which the weekly scheduled job also
   * calls. A schedule and a button must not become two implementations of the
   * capability gate and the settled-payout guard.
   */
  const outcome = await calculateWeek(
    {
      repositories: ctx.repositories,
      yahoo: ctx.yahoo,
      correlationId: ctx.correlationId,
      leagueId,
    },
    {
      leagueId,
      seasonYear,
      week,
      actorId: principal.userId as InternalId,
      actorRole: principal.role,
    },
  );

  return c.json(outcome);
});

challengeRoutes.post('/api/challenges/:seasonYear/finalize/:week/:slug', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));
  const week = weekNumberSchema.parse(Number(c.req.param('week')));
  const slug = c.req.param('slug');

  const result = await ctx.repositories.challenges.findResult(leagueId, seasonYear, week, slug);
  if (!result) throw new AppError('not_found', { publicMessage: 'No result to finalize.' });

  assertCanFinalize(result);

  const actorId = principal.userId as InternalId;

  await ctx.repositories.challenges.saveResult(
    {
      ...result,
      status: 'finalized',
      finalizedAt: isoNow(),
      finalizedByUserId: actorId,
      updatedAt: isoNow(),
      updatedBy: actorId,
      version: result.version + 1,
    },
    result.version,
  );

  await ctx.repositories.audit.record({
    leagueId,
    action: 'challenge.finalized',
    actorUserId: actorId,
    actorRole: principal.role,
    summary: `Finalized ${slug} for ${seasonYear} week ${week}.`,
    correlationId: ctx.correlationId,
    targetEntity: 'WeeklyChallengeResult',
    targetId: result.challengeResultId,
    detail: { winningValue: result.winningValue ?? null },
  });

  return c.json({ ok: true });
});

/**
 * Overrides a computed result.
 *
 * The computed outcome is preserved in a permanent override record alongside the
 * commissioner's decision and reason, so the arithmetic is never simply erased.
 */
challengeRoutes.post('/api/challenges/:seasonYear/override/:week/:slug', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));
  const week = weekNumberSchema.parse(Number(c.req.param('week')));
  const slug = c.req.param('slug');

  const body = await parseJson(
    c,
    z.object({
      winningLeagueMemberIds: z.array(z.string().length(26)).min(1),
      winningValue: z.number().optional(),
      reason: z.string().min(1).max(2000),
    }),
  );

  const definition = await ctx.repositories.challenges.findDefinition(leagueId, seasonYear, slug);
  if (!definition) throw new AppError('not_found', { publicMessage: 'No such challenge.' });

  const result = await ctx.repositories.challenges.findResult(leagueId, seasonYear, week, slug);
  if (!result) throw new AppError('not_found', { publicMessage: 'No result to override.' });

  assertCanOverride(definition, result, body.reason);

  const actorId = principal.userId as InternalId;
  const overrideId = generateId();

  const computedSummary =
    result.winningLeagueMemberIds.length > 0
      ? `Computed winner(s): ${result.winningLeagueMemberIds.join(', ')} with ${result.winningValue ?? 'no value'}. ${result.explanation}`
      : `No computed winner. ${result.explanation}`;

  await ctx.repositories.challenges.saveOverride({
    entity: 'CommissionerOverride',
    overrideId,
    leagueId,
    target: {
      kind: 'challenge_result',
      challengeResultId: result.challengeResultId,
      seasonYear,
      week,
    },
    computedSummary,
    overriddenSummary: `Commissioner set winner(s): ${body.winningLeagueMemberIds.join(', ')}${
      body.winningValue === undefined ? '' : ` with ${body.winningValue}`
    }.`,
    reason: body.reason,
    overriddenByUserId: actorId,
    overriddenAt: isoNow(),
    // Recorded explicitly: overriding an already-paid result is a different kind
    // of event, and an auditor should be able to find them.
    affectedSettledPayout: result.payoutSettled,
    ...created(actorId),
  });

  await ctx.repositories.challenges.saveResult(
    {
      ...result,
      status: 'overridden',
      winningLeagueMemberIds: body.winningLeagueMemberIds as InternalId[],
      ...(body.winningValue === undefined ? {} : { winningValue: body.winningValue }),
      explanation: `${result.explanation} Overridden by commissioner: ${body.reason}`,
      updatedAt: isoNow(),
      updatedBy: actorId,
      version: result.version + 1,
    },
    result.version,
  );

  await ctx.repositories.audit.record({
    leagueId,
    action: 'challenge.overridden',
    actorUserId: actorId,
    actorRole: principal.role,
    summary: `Overrode ${slug} week ${week}. Reason: ${body.reason.slice(0, 200)}`,
    correlationId: ctx.correlationId,
    targetEntity: 'WeeklyChallengeResult',
    targetId: result.challengeResultId,
    detail: { affectedSettledPayout: result.payoutSettled, overrideId },
  });

  return c.json({ ok: true, overrideId });
});
