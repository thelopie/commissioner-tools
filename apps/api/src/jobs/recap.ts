import {
  generateId,
  SYSTEM_ACTOR_ID,
  type LeagueRecap,
  type RecapFact,
  type InternalId,
} from '@dinkel/shared';
import { currentLink } from '../routes/yahoo.js';
import { describeError } from '../lib/logger.js';
import type { JobContext } from './types.js';

/**
 * Builds a weekly recap.
 *
 * The division of labour is the whole point:
 *
 * - **This code computes every number.** Scores, margins, records, the bench total —
 *   all of it, from live Yahoo data, in plain arithmetic.
 * - **The model, if enabled, only writes sentences** from that finished fact pack. It
 *   is never given a roster, a scoreboard, or a reason to compute anything. It cannot
 *   invent a winner because it is never asked who won.
 * - **A template recap always exists.** Prose is an optional garnish; if generation
 *   is disabled or fails, the recap is still complete and readable.
 *
 * Nothing here publishes. The recap lands as a draft for a commissioner to read.
 */

const isoNow = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, '');

/** Fantasy scores are quoted to a tenth; whole numbers should not gain a `.0`. */
function points(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export async function buildRecap(
  ctx: JobContext,
  week: number,
  existing: LeagueRecap | null,
): Promise<LeagueRecap> {
  const seasonYear = existing?.seasonYear ?? new Date(ctx.scheduledAt).getUTCFullYear();
  const facts = await collectFacts(ctx, week, seasonYear);
  const templateBody = renderTemplate(week, facts);

  /**
   * Prose is attempted only when a key is configured, and a failure is not fatal.
   *
   * A recap that arrives without the flourish is fine. A job that fails because a
   * third-party API was slow is not: it would take the whole week's calculation
   * down with it and land in the dead-letter queue for no good reason.
   */
  let proseBody: string | null = null;
  let proseModel: string | undefined;

  if (ctx.config.env.ANTHROPIC_API_KEY) {
    try {
      const generated = await generateProse(ctx, week, facts);
      proseBody = generated.text;
      proseModel = generated.model;
    } catch (error) {
      ctx.logger.warn('Recap prose generation failed; keeping the template recap', {
        ...describeError(error),
      });
    }
  }

  const recap: LeagueRecap = {
    entity: 'LeagueRecap',
    recapId: existing?.recapId ?? generateId(),
    leagueId: ctx.leagueId,
    seasonYear,
    week,
    facts,
    templateBody,
    proseBody,
    ...(proseModel ? { proseModel, proseGeneratedAt: isoNow() } : {}),
    // Always a draft. A schedule does not get to speak to the league.
    status: 'draft',
    ...(existing
      ? {
          createdAt: existing.createdAt,
          createdBy: existing.createdBy,
          updatedAt: isoNow(),
          updatedBy: SYSTEM_ACTOR_ID,
          version: existing.version + 1,
        }
      : {
          createdAt: isoNow(),
          createdBy: SYSTEM_ACTOR_ID,
          updatedAt: isoNow(),
          updatedBy: SYSTEM_ACTOR_ID,
          version: 1,
        }),
  };

  await ctx.repositories.ops.saveRecap(recap, existing?.version);

  await ctx.repositories.audit.record({
    leagueId: ctx.leagueId,
    action: 'recap.drafted',
    actorUserId: null,
    actorRole: 'system',
    summary: `Drafted the week ${week} recap for review.`,
    correlationId: ctx.correlationId,
    targetEntity: 'LeagueRecap',
    targetId: recap.recapId,
    detail: { week, factCount: facts.length, hasProse: proseBody !== null },
  });

  return recap;
}

/**
 * The fact pack.
 *
 * Every value is computed here and rendered to a string before storage. Storing the
 * formatted value rather than the raw Yahoo number is deliberate: it is a derived
 * label, which the retention rules permit, and it means a recap read in 2030 does
 * not depend on Yahoo data nobody kept.
 */
async function collectFacts(
  ctx: JobContext,
  week: number,
  seasonYear: number,
): Promise<RecapFact[]> {
  const link = await currentLink({
    leagueId: ctx.leagueId,
    repositories: ctx.repositories,
  } as never);
  if (!link) return [];

  const facts: RecapFact[] = [];

  const matchups = await ctx.yahoo.getScoreboard(link.connectionUserId, link.yahooLeagueKey, week);
  const standings = await ctx.yahoo.getStandings(link.connectionUserId, link.yahooLeagueKey);

  // Highest score of the week.
  let best: { name: string; value: number } | null = null;
  let worst: { name: string; value: number } | null = null;

  for (const matchup of matchups) {
    for (const team of matchup.teams) {
      if (team.points === undefined) continue;
      const name = team.name ?? '(unnamed team)';
      if (!best || team.points > best.value) best = { name, value: team.points };
      if (!worst || team.points < worst.value) worst = { name, value: team.points };
    }
  }

  if (best) {
    facts.push({
      key: 'highest_score',
      label: 'Highest score',
      value: `${best.name}, ${points(best.value)}`,
    });
  }
  if (worst) {
    facts.push({
      key: 'lowest_score',
      label: 'Lowest score',
      value: `${worst.name}, ${points(worst.value)}`,
    });
  }

  // The closest game, which is usually the one worth writing about.
  let closest: { teams: string[]; margin: number } | null = null;
  for (const matchup of matchups) {
    const [first, second] = matchup.teams;
    if (first?.points === undefined || second?.points === undefined) continue;
    const margin = Math.round(Math.abs(first.points - second.points) * 10) / 10;
    if (!closest || margin < closest.margin) {
      closest = {
        teams: [first.name ?? '(unnamed team)', second.name ?? '(unnamed team)'],
        margin,
      };
    }
  }

  if (closest) {
    facts.push({
      key: 'closest_matchup',
      label: 'Closest game',
      value: `${closest.teams.join(' vs ')}, decided by ${points(closest.margin)}`,
    });
  }

  const leader = standings[0];
  if (leader) {
    facts.push({
      key: 'league_leader',
      label: 'Top of the table',
      value: `${leader.name}${leader.recordLabel ? `, ${leader.recordLabel}` : ''}`,
    });
  }

  /**
   * Challenge winners, from Dinkel's own finalized results.
   *
   * Only settled ones: a provisional result can still change, and a recap that named
   * a winner who later lost the challenge would be worse than one that stayed quiet.
   */
  const results = await ctx.repositories.challenges.listResults(ctx.leagueId, seasonYear, week);
  const members = await ctx.repositories.leagues.listMembers(ctx.leagueId, seasonYear);
  const users = await ctx.repositories.users.listByLeague(ctx.leagueId);
  const userById = new Map(users.map((user) => [user.userId, user]));

  const nameOf = (memberId: InternalId): string => {
    const member = members.find((candidate) => candidate.leagueMemberId === memberId);
    if (!member) return '(former member)';
    return (
      (member.userId ? userById.get(member.userId)?.displayName : undefined) ??
      member.legacyManagerName ??
      '(unnamed manager)'
    );
  };

  for (const result of results) {
    if (result.status !== 'finalized' && result.status !== 'overridden') continue;
    if (result.winningLeagueMemberIds.length === 0) continue;

    const winners = result.winningLeagueMemberIds.map(nameOf).join(' and ');
    const first = result.winningLeagueMemberIds[0];

    facts.push({
      key: `challenge_${result.challengeSlug}`,
      label: result.challengeSlug.replace(/-/g, ' '),
      value:
        result.winningValue === undefined ? winners : `${winners}, ${points(result.winningValue)}`,
      ...(first ? { leagueMemberId: first } : {}),
    });
  }

  return facts;
}

/**
 * The deterministic recap.
 *
 * Always produced, always accurate, and never dependent on a third party. If the
 * prose generation is switched off this is the recap.
 */
function renderTemplate(week: number, facts: RecapFact[]): string {
  if (facts.length === 0) {
    return `Week ${week}\n\nNo results were available when this recap was drafted.`;
  }

  const lines = facts.map((fact) => `- ${fact.label}: ${fact.value}`);
  return `Week ${week}\n\n${lines.join('\n')}`;
}

/**
 * Asks Claude for prose, given only the fact pack.
 *
 * The prompt states the constraint that matters: do not compute, do not add, do not
 * infer. The model has no numbers to work from beyond the ones already decided here,
 * and no access to anything else.
 */
async function generateProse(
  ctx: JobContext,
  week: number,
  facts: RecapFact[],
): Promise<{ text: string; model: string }> {
  const model = 'claude-sonnet-4-5';

  const factList = facts.map((fact) => `${fact.label}: ${fact.value}`).join('\n');

  const prompt =
    `Write a short, warm recap of week ${week} of a private fantasy football league, ` +
    `for the league's own members.\n\n` +
    `These are the only facts available. Use them as given.\n\n${factList}\n\n` +
    `Rules: do not invent any statistic, name, or result. Do not calculate anything. ` +
    `Do not state anything that is not in the list above. Three short paragraphs at most. ` +
    `No headings, no bullet points, no sign-off.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ctx.config.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API returned ${response.status}`);
  }

  const body = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };

  const text = (body.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();

  if (text.length === 0) throw new Error('Anthropic API returned no text');

  return { text, model };
}
