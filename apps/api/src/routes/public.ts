import { Hono } from 'hono';
import { seasonYearSchema, type InternalId, type SeasonYear } from '@lopie/shared';
import { currentStandings, finalDraftOrder, type SelectionState } from '@lopie/draft-order';
import type { AppEnv } from '../context.js';

/**
 * The one part of the portal that anybody can see without signing in.
 *
 * Everything else requires a session, which is right for dues, rosters and audit
 * history. The draft order is different: it is the thing the league most wants to
 * look at, it gets shared into a group chat the moment it exists, and asking twelve
 * people to sign in to read twelve names they already know is friction with no
 * privacy left to protect.
 *
 * That reasoning has limits, and they are enforced here rather than assumed:
 *
 * - **Published only.** The order appears once the commissioner has published the
 *   draw and every draft slot is settled. A half-finished order is not public, so
 *   nobody reads a provisional position as final.
 * - **Names and positions, nothing else.** No email addresses, no user IDs, no
 *   member IDs, no Yahoo identifiers. What ships is what would be read aloud.
 * - **Nothing from Yahoo.** Every value here is portal-owned, so this endpoint keeps
 *   working when the Yahoo connection lapses and it retains nothing it should not.
 */
export const publicRoutes = new Hono<AppEnv>();

interface PublicOrderEntry {
  draftPosition: number;
  manager: string;
  llwsTeam: string | null;
}

publicRoutes.get('/api/public/home', async (c) => {
  const ctx = c.get('ctx');
  const leagueId = ctx.leagueId;

  // Before bootstrap there is no league at all. Not an error: the page renders a
  // holding state rather than a stack trace.
  if (!leagueId) {
    return c.json({ leagueName: null, seasonYear: null, draftAt: null, order: null });
  }

  const league = await ctx.repositories.leagues.find(leagueId);
  if (!league) {
    return c.json({ leagueName: null, seasonYear: null, draftAt: null, order: null });
  }

  const seasonYear = league.currentSeasonYear ?? latestSeasonYear(await seasons(ctx, leagueId));

  if (seasonYear === null) {
    return c.json({
      leagueName: league.name,
      seasonYear: null,
      draftAt: null,
      order: null,
    });
  }

  const season = await ctx.repositories.leagues.findSeason(leagueId, seasonYear);
  const draftAt = season?.draftAt ?? null;

  const [assignments, order] = await Promise.all([
    publishedAssignments(ctx, leagueId, seasonYear),
    publishedOrder(ctx, leagueId, seasonYear, season?.teamCount),
  ]);

  return c.json({
    leagueName: league.name,
    seasonYear,
    draftAt,
    assignments,
    order,
  });
});

/**
 * Who drew which Little League team, by owner.
 *
 * Available as soon as the draw is published, which is weeks before a draft order
 * exists — the tournament has to be played first. This is the part the league wants
 * to argue about in the meantime, so it is worth showing on its own.
 */
async function publishedAssignments(
  ctx: AppEnv['Variables']['ctx'],
  leagueId: InternalId,
  seasonYear: SeasonYear,
): Promise<{
  entries: Array<{
    manager: string;
    llwsTeam: string;
    region: string | null;
    /** Where this manager stands: a settled position, or a range still in play. */
    standing: { locked: boolean; best: number; worst: number } | null;
  }>;
  seed: string | null;
  drawnAt: string | null;
  /** How many drawn teams are still in the tournament. */
  stillPlaying: number;
} | null> {
  const assignments = await ctx.repositories.llws.listAssignments(leagueId, seasonYear);

  const published = assignments.length > 0 && assignments.every((a) => a.publishedAt);
  if (!published) return null;

  const teams = await ctx.repositories.llws.listTeams(leagueId, seasonYear);
  const teamById = new Map(teams.map((team) => [team.llwsTeamId, team]));
  const nameOf = await memberNamer(ctx, leagueId, seasonYear);

  /*
    Positions are derived, never stored. A team still playing finishes above every
    team already out, which settles an eliminated manager's position the moment they
    go out and narrows everyone else's range by itself.
  */
  const standings = new Map(
    currentStandings(
      assignments.map((assignment) => ({
        leagueMemberId: assignment.leagueMemberId,
        finishRank: teamById.get(assignment.llwsTeamId)?.finishRank,
      })),
    ).map((standing) => [standing.leagueMemberId, standing]),
  );

  const entries = assignments
    .map((assignment) => {
      const team = teamById.get(assignment.llwsTeamId);
      const standing = standings.get(assignment.leagueMemberId) ?? null;
      return {
        manager: nameOf(assignment.leagueMemberId),
        llwsTeam: team?.name ?? 'Unknown team',
        region: team?.region ?? null,
        standing: standing
          ? { locked: standing.locked, best: standing.best, worst: standing.worst }
          : null,
      };
    })
    // Best position first once the tournament is under way; it is the running order.
    .sort((a, b) => (a.standing?.best ?? 0) - (b.standing?.best ?? 0) || a.manager.localeCompare(b.manager));

  /*
    The seed is published deliberately. It is what turns "the commissioner says it
    was random" into something a suspicious manager can check for themselves, and it
    is worthless as a secret — the draw is already visible above it.
  */
  return {
    entries,
    seed: assignments[0]?.randomizationSeed ?? null,
    drawnAt: assignments[0]?.assignedAt ?? null,
    stillPlaying: [...standings.values()].filter((standing) => !standing.locked).length,
  };
}

/**
 * Resolves a member ID to the name the league would say out loud.
 *
 * Prefers a signed-in user's own confirmed display name, falling back to the name the
 * commissioner entered — which is what exists before anybody has signed in.
 */
async function memberNamer(
  ctx: AppEnv['Variables']['ctx'],
  leagueId: InternalId,
  seasonYear: SeasonYear,
): Promise<(memberId: string) => string> {
  const members = await ctx.repositories.leagues.listMembers(leagueId, seasonYear);
  const users = await ctx.repositories.users.listByLeague(leagueId);
  const userById = new Map(users.map((user) => [user.userId, user]));

  return (memberId: string): string => {
    const member = members.find((candidate) => candidate.leagueMemberId === memberId);
    if (!member) return 'Unknown manager';
    return (
      (member.userId ? userById.get(member.userId)?.displayName : undefined) ??
      member.legacyManagerName ??
      'Unnamed manager'
    );
  };
}

async function seasons(
  ctx: { repositories: { leagues: { listSeasons: (id: InternalId) => Promise<Array<{ seasonYear: number }>> } } },
  leagueId: InternalId,
): Promise<Array<{ seasonYear: number }>> {
  return ctx.repositories.leagues.listSeasons(leagueId);
}

function latestSeasonYear(all: Array<{ seasonYear: number }>): SeasonYear | null {
  const years = all.map((season) => season.seasonYear);
  if (years.length === 0) return null;
  return seasonYearSchema.parse(Math.max(...years));
}

/**
 * The final draft order, or null when it is not the league's to see yet.
 *
 * Returns null rather than a partial list in every unfinished case, so the page has
 * exactly one thing to check and cannot accidentally present an in-progress order as
 * the result.
 */
async function publishedOrder(
  ctx: AppEnv['Variables']['ctx'],
  leagueId: InternalId,
  seasonYear: SeasonYear,
  teamCount: number | undefined,
): Promise<PublicOrderEntry[] | null> {
  const assignments = await ctx.repositories.llws.listAssignments(leagueId, seasonYear);

  // Publishing is the commissioner's deliberate act of telling the league. Before it,
  // the draw exists but is nobody else's business.
  const published = assignments.length > 0 && assignments.every((a) => a.publishedAt);
  if (!published) return null;

  const selections = await ctx.repositories.llws.listSelections(leagueId, seasonYear);
  if (selections.length === 0) return null;

  const states: SelectionState[] = selections.map((selection) => ({
    leagueMemberId: selection.leagueMemberId,
    selectionOrder: selection.selectionOrder,
    chosenDraftPosition: selection.chosenDraftPosition,
    status: selection.status,
  }));

  const final = finalDraftOrder(states, teamCount ?? selections.length);
  if (!final.complete) return null;

  const teams = await ctx.repositories.llws.listTeams(leagueId, seasonYear);
  const teamById = new Map(teams.map((team) => [team.llwsTeamId, team]));
  const teamByMember = new Map(
    assignments.map((assignment) => [assignment.leagueMemberId, teamById.get(assignment.llwsTeamId)]),
  );

  const nameOf = await memberNamer(ctx, leagueId, seasonYear);

  return final.order.flatMap((entry) => {
    if (!entry.leagueMemberId) return [];
    const team = teamByMember.get(entry.leagueMemberId);
    return [
      {
        draftPosition: entry.draftPosition,
        manager: nameOf(entry.leagueMemberId),
        llwsTeam: team ? team.name : null,
      },
    ];
  });
}
