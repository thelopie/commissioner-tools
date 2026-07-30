import {
  AppError,
  generateId,
  type InternalId,
  type WeeklyChallengeDefinition,
  type WeeklyChallengeResult,
} from '@dinkel/shared';
import {
  calculateChallenge,
  decideRecalculation,
  type PlayerWeek,
  type TeamWeek,
} from '@dinkel/challenge-engine';
import { isCapabilityVerified } from '@dinkel/yahoo-client';
import { created, type Repositories } from '../repositories.js';
import { currentLink } from '../routes/yahoo.js';
import type { YahooService } from './yahoo-service.js';

/**
 * Calculating a week's challenges, shared by the HTTP route and the scheduled job.
 *
 * It lives here rather than in the route because a schedule and a button must not
 * be two implementations of the same rules. When the stat-correction guard or the
 * capability re-check changes, it changes once.
 *
 * Nothing in here finalizes, publishes, or pays anything. Results are provisional
 * until a person accepts them.
 */

/** Everything the calculation needs, and nothing about HTTP. */
export interface CalculationDeps {
  repositories: Repositories;
  yahoo: YahooService;
  correlationId: string;
  /** Present so `currentLink` can resolve the linked season. */
  leagueId: InternalId | null;
}

export interface CalculationInput {
  leagueId: InternalId;
  seasonYear: number;
  week: number;
  /**
   * Who is responsible. A scheduled run passes `SYSTEM_ACTOR_ID`, never null —
   * every result must be attributable to something, even if that something is a cron
   * rule rather than a person.
   */
  actorId: InternalId;
  actorRole: 'commissioner' | 'manager' | 'readonly' | 'system';
}

export interface CalculationOutcome {
  calculated: Array<{ slug: string; status: string; winners: string[]; value?: number }>;
  conflicts: Array<{ slug: string; summary: string }>;
  blocked: Array<{ slug: string; reason: string }>;
  note: string;
}

const isoNow = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, '');

export async function calculateWeek(
  deps: CalculationDeps,
  input: CalculationInput,
): Promise<CalculationOutcome> {
  const ctx = deps;
  const { leagueId, seasonYear, week, actorId, actorRole } = input;
  const definitions = await ctx.repositories.challenges.listDefinitions(leagueId, seasonYear);

  /**
   * The capability gate is re-checked HERE, not trusted from the stored status.
   *
   * A definition's status is written once, when it is seeded or activated. If a
   * capability is later withdrawn — Yahoo changes a response, a resource is marked
   * `failed` in the matrix — an already-active definition would otherwise keep
   * producing winners from data nobody has verified. The number would look exactly
   * as authoritative as a real one, and someone would eventually be paid on it.
   */
  const unverified = (definition: WeeklyChallengeDefinition): string[] =>
    definition.requiredYahooData.filter((capability) => !isCapabilityVerified(capability));

  const calculable = definitions.filter(
    (definition) => definition.status === 'active' && unverified(definition).length === 0,
  );

  const blocked = [
    ...definitions.filter((definition) => definition.status === 'blocked'),
    // Active on paper, but its Yahoo data is no longer verified.
    ...definitions.filter(
      (definition) => definition.status === 'active' && unverified(definition).length > 0,
    ),
  ];

  if (calculable.length === 0) {
    return {
      calculated: [],
      blocked: blocked.map((definition) => ({
        slug: definition.slug,
        reason:
          definition.blockedReason ??
          (unverified(definition).length > 0
            ? `Unverified Yahoo data: ${unverified(definition).join(', ')}.`
            : 'Required Yahoo data is unverified.'),
      })),
      conflicts: [],
      note:
        'No challenge is calculable yet. Every challenge requires Yahoo data verified against a ' +
        'real league — run `npm run verify:yahoo` once Yahoo grants API access.',
    };
  }

  const weekInput = await buildWeekInput(deps, leagueId, seasonYear, week);

  const calculated: Array<{ slug: string; status: string; winners: string[]; value?: number }> = [];
  const conflicts: Array<{ slug: string; summary: string }> = [];

  for (const definition of calculable) {
    const outcome = calculateChallenge(definition, weekInput, { isCapabilityVerified });

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
              actorRole,
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
        actorRole,
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
    actorRole,
    summary: `Calculated ${calculated.length} challenge(s) for ${seasonYear} week ${week}.`,
    correlationId: ctx.correlationId,
    detail: { week, calculatedCount: calculated.length, blockedCount: blocked.length },
  });

  return {
    calculated,
    conflicts,
    blocked: blocked.map((definition) => ({
      slug: definition.slug,
      reason:
        definition.blockedReason ??
        (unverified(definition).length > 0
          ? `Unverified Yahoo data: ${unverified(definition).join(', ')}.`
          : 'Required Yahoo data is unverified.'),
    })),
    // Provisional until the stat-correction window closes and a commissioner
    // accepts the outcome.
    note: 'Results are provisional. Yahoo stat corrections can still change them.',
  };
}

async function buildWeekInput(
  ctx: CalculationDeps,
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
