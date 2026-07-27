import { Hono } from 'hono';
import {
  AppError,
  generateId,
  seasonYearSchema,
  weekNumberSchema,
  type InternalId,
  type WeeklyChallengeDefinition,
  type WeeklyChallengeResult,
} from '@dinkel/shared';
import {
  assertCanFinalize,
  assertCanOverride,
  calculateChallenge,
  CHALLENGE_PROPOSALS,
  decideRecalculation,
  proposalToDefinition,
  type PlayerWeek,
  type TeamWeek,
} from '@dinkel/challenge-engine';
import { isCapabilityVerified } from '@dinkel/yahoo-client';
import { z } from 'zod';
import type { AppEnv, RequestContext } from '../context.js';
import { requireLeagueId } from '../context.js';
import { requireAuthenticated, requireCommissioner } from '../lib/authorization.js';
import { created } from '../repositories.js';
import { parseJson } from './auth.js';
import { currentLink } from './yahoo.js';

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
  return c.json({ results });
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

  const actorId = principal.userId as InternalId;
  const definitions = await ctx.repositories.challenges.listDefinitions(leagueId, seasonYear);

  const calculable = definitions.filter((definition) => definition.status === 'active');
  const blocked = definitions.filter((definition) => definition.status === 'blocked');

  if (calculable.length === 0) {
    return c.json({
      calculated: [],
      blocked: blocked.map((definition) => ({
        slug: definition.slug,
        reason: definition.blockedReason ?? 'Required Yahoo data is unverified.',
      })),
      note:
        'No challenge is calculable yet. Every challenge requires Yahoo data verified against a ' +
        'real league — run `npm run verify:yahoo` once Yahoo grants API access.',
    });
  }

  const input = await buildWeekInput(ctx, leagueId, seasonYear, week);

  const calculated: Array<{ slug: string; status: string; winners: string[]; value?: number }> = [];
  const conflicts: Array<{ slug: string; summary: string }> = [];

  for (const definition of calculable) {
    const outcome = calculateChallenge(definition, input, { isCapabilityVerified });

    if (outcome.blocked) {
      blocked.push({ ...definition, blockedReason: outcome.reason });
      continue;
    }

    const existing = await ctx.repositories.challenges.findResult(
      leagueId,
      seasonYear,
      week,
      definition.slug,
    );

    if (existing) {
      const decision = decideRecalculation(existing, outcome);

      if (!decision.shouldUpdate) {
        if (decision.changed) {
          conflicts.push({ slug: definition.slug, summary: decision.summary });

          // A settled payout whose result just changed needs a human, so the
          // dashboard gets a task rather than a silent log line.
          if (decision.blockedBySettledPayout) {
            await ctx.repositories.ops.openSystemTask({
              entity: 'CommissionerTask',
              taskId: generateId(),
              leagueId,
              seasonYear,
              title: `Stat correction changed a paid result: ${definition.name} week ${week}`,
              detail: decision.summary,
              category: 'challenges',
              priority: 'high',
              status: 'open',
              systemSource: 'challenge_recalculation',
              idempotencyKey: `settled-change:${seasonYear}:${week}:${definition.slug}`,
              ...created(actorId),
            });

            await ctx.repositories.audit.record({
              leagueId,
              action: 'challenge.settled_result_change_blocked',
              actorUserId: actorId,
              actorRole: principal.role,
              summary: `Recalculation of ${definition.name} week ${week} was blocked: payout already settled.`,
              correlationId: ctx.correlationId,
              targetEntity: 'WeeklyChallengeResult',
              targetId: existing.challengeResultId,
            });
          }
        }

        calculated.push({
          slug: definition.slug,
          status: existing.status,
          winners: existing.winningLeagueMemberIds,
          ...(existing.winningValue === undefined ? {} : { value: existing.winningValue }),
        });
        continue;
      }

      await ctx.repositories.challenges.saveResult(
        {
          ...existing,
          status: 'provisional',
          winningLeagueMemberIds: outcome.winningLeagueMemberIds,
          ...(outcome.winningValue === undefined ? {} : { winningValue: outcome.winningValue }),
          explanation: outcome.explanation,
          competitorCount: outcome.standings.filter((standing) => standing.eligible).length,
          wasTied: outcome.wasTied,
          ...(outcome.appliedTieBreaker ? { appliedTieBreaker: outcome.appliedTieBreaker } : {}),
          calculatedAt: isoNow(),
          calculationCount: existing.calculationCount + 1,
          lastChangedAt: isoNow(),
          updatedAt: isoNow(),
          updatedBy: actorId,
          version: existing.version + 1,
        },
        existing.version,
      );

      await ctx.repositories.audit.record({
        leagueId,
        action: 'challenge.recalculated',
        actorUserId: actorId,
        actorRole: principal.role,
        summary: `Recalculated ${definition.name} week ${week}: ${decision.summary}`,
        correlationId: ctx.correlationId,
        targetEntity: 'WeeklyChallengeResult',
        targetId: existing.challengeResultId,
      });

      calculated.push({
        slug: definition.slug,
        status: 'provisional',
        winners: outcome.winningLeagueMemberIds,
        ...(outcome.winningValue === undefined ? {} : { value: outcome.winningValue }),
      });
      continue;
    }

    const result: WeeklyChallengeResult = {
      entity: 'WeeklyChallengeResult',
      challengeResultId: generateId(),
      leagueId,
      seasonYear,
      week,
      challengeDefinitionId: definition.challengeDefinitionId,
      challengeSlug: definition.slug,
      status: outcome.winningLeagueMemberIds.length === 0 ? 'not_calculable' : 'provisional',
      winningLeagueMemberIds: outcome.winningLeagueMemberIds,
      ...(outcome.winningValue === undefined ? {} : { winningValue: outcome.winningValue }),
      explanation: outcome.explanation,
      competitorCount: outcome.standings.filter((standing) => standing.eligible).length,
      wasTied: outcome.wasTied,
      ...(outcome.appliedTieBreaker ? { appliedTieBreaker: outcome.appliedTieBreaker } : {}),
      calculatedAt: isoNow(),
      calculationCount: 1,
      ...(outcome.notCalculableReason ? { notCalculableReason: outcome.notCalculableReason } : {}),
      payoutSettled: false,
      ...created(actorId),
    };

    await ctx.repositories.challenges.saveResult(result);

    calculated.push({
      slug: definition.slug,
      status: result.status,
      winners: result.winningLeagueMemberIds,
      ...(result.winningValue === undefined ? {} : { value: result.winningValue }),
    });
  }

  await ctx.repositories.audit.record({
    leagueId,
    action: 'challenge.calculated',
    actorUserId: actorId,
    actorRole: principal.role,
    summary: `Calculated ${calculated.length} challenge(s) for ${seasonYear} week ${week}.`,
    correlationId: ctx.correlationId,
    detail: { week, calculatedCount: calculated.length, blockedCount: blocked.length },
  });

  return c.json({
    calculated,
    conflicts,
    blocked: blocked.map((definition) => ({
      slug: definition.slug,
      reason: definition.blockedReason ?? 'Required Yahoo data is unverified.',
    })),
    // Provisional until the stat-correction window closes and a commissioner
    // accepts the outcome.
    note: 'Results are provisional. Yahoo stat corrections can still change them.',
  });
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

/**
 * Translates Yahoo data into the engine's input.
 *
 * This is the boundary: Yahoo shapes stop here, plain numbers go in, and the
 * fetched response is discarded rather than persisted.
 */
async function buildWeekInput(
  ctx: RequestContext,
  leagueId: InternalId,
  seasonYear: number,
  week: number,
): Promise<{ seasonYear: number; week: number; teams: TeamWeek[] }> {
  const link = await currentLink(ctx as never);
  if (!link) {
    throw new AppError('yahoo_league_not_linked', {
      publicMessage: 'Link a Yahoo league before calculating challenges.',
    });
  }

  const members = await ctx.repositories.leagues.listMembers(leagueId, seasonYear);
  const mapped = members.filter((member) => member.yahooTeamKey);

  if (mapped.length === 0) {
    throw new AppError('precondition_failed', {
      publicMessage:
        'No Yahoo teams are mapped to league members yet. Map them before calculating challenges.',
    });
  }

  const userId = link.connectionUserId;
  const matchups = await ctx.yahoo.getScoreboard(userId, link.yahooLeagueKey, week);
  const rosters = await ctx.yahoo.getRosters(
    userId,
    mapped.map((member) => member.yahooTeamKey!),
    week,
  );

  const dues = await ctx.repositories.money.listDues(leagueId, seasonYear);
  const duesByMember = new Map(dues.map((record) => [record.leagueMemberId, record]));

  const priorResults = await ctx.repositories.challenges.listResults(leagueId, seasonYear);

  const rosterByTeamKey = new Map(rosters.map((roster) => [roster.teamKey, roster]));
  const memberByTeamKey = new Map(mapped.map((member) => [member.yahooTeamKey!, member]));

  const teams: TeamWeek[] = [];

  for (const member of mapped) {
    const teamKey = member.yahooTeamKey!;
    const roster = rosterByTeamKey.get(teamKey);

    const matchup = matchups.find((candidate) =>
      candidate.teams.some((team) => team.teamKey === teamKey),
    );
    const own = matchup?.teams.find((team) => team.teamKey === teamKey);
    const opponent = matchup?.teams.find((team) => team.teamKey !== teamKey);

    const players: PlayerWeek[] = (roster?.slots ?? []).map((slot) => ({
      playerKey: slot.playerKey,
      playerName: slot.playerName,
      selectedPosition: slot.selectedPosition,
      position: slot.displayPosition ?? slot.eligiblePositions[0] ?? 'UNKNOWN',
      ...(slot.points === undefined ? {} : { points: slot.points }),
    }));

    const duesRecord = duesByMember.get(member.leagueMemberId);

    const outcome: TeamWeek['outcome'] =
      matchup === undefined || own?.points === undefined || opponent?.points === undefined
        ? undefined
        : matchup.isTied
          ? 'tie'
          : matchup.winnerTeamKey === teamKey
            ? 'win'
            : 'loss';

    teams.push({
      leagueMemberId: member.leagueMemberId,
      players,
      ...(own?.points === undefined ? {} : { teamPoints: own.points }),
      ...(own?.projectedPoints === undefined ? {} : { projectedTeamPoints: own.projectedPoints }),
      ...(opponent?.points === undefined ? {} : { opponentPoints: opponent.points }),
      ...(opponent && memberByTeamKey.has(opponent.teamKey)
        ? { opponentLeagueMemberId: memberByTeamKey.get(opponent.teamKey)!.leagueMemberId }
        : {}),
      ...(outcome === undefined ? {} : { outcome }),
      ...(duesRecord
        ? { duesPaid: duesRecord.status === 'paid' || duesRecord.status === 'waived' }
        : {}),
      priorWinsOfThisChallenge: priorResults.filter(
        (result) =>
          result.week < week &&
          result.winningLeagueMemberIds.includes(member.leagueMemberId) &&
          (result.status === 'finalized' || result.status === 'overridden'),
      ).length,
    });
  }

  return { seasonYear, week, teams };
}

export { buildWeekInput };
