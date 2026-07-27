import { Hono } from 'hono';
import { AppError, weekNumberSchema } from '@dinkel/shared';
import type { YahooManager } from '@dinkel/yahoo-client';
import type { AppEnv } from '../context.js';
import { requireLeagueId } from '../context.js';
import { requireAuthenticated } from '../lib/authorization.js';
import { currentLink } from './yahoo.js';

/**
 * The read-only league views every member cares about: standings and matchups.
 *
 * These are the reason a manager opens the portal at all. They were the gap in the
 * first build, which shipped commissioner plumbing and nothing a league member
 * would come back for.
 *
 * Both are available to any authenticated member, not just commissioners — this is
 * league information, not administration. Everything is read live from Yahoo and
 * cached for minutes; nothing here is persisted.
 */

export const leagueViewRoutes = new Hono<AppEnv>();

/** True when Yahoo says one of these managers is the signed-in user. */
function isOwnedByViewer(managers: readonly YahooManager[]): boolean {
  return managers.some((manager) => manager.isCurrentLogin === true);
}

leagueViewRoutes.get('/api/league/standings', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireAuthenticated(ctx.principal);
  requireLeagueId(ctx);

  const link = await currentLink(ctx as never);
  if (!link) {
    throw new AppError('yahoo_league_not_linked', {
      publicMessage: 'No Yahoo league is linked yet, so there are no standings to show.',
    });
  }

  const refresh = c.req.query('refresh') === '1';

  /**
   * Read through the linking commissioner's connection, not the viewer's.
   *
   * A manager who has not connected Yahoo can still see standings, which is the
   * point: the league's data should not require every member to authorize
   * separately before the portal is useful to them.
   */
  const rows = await ctx.yahoo.getStandings(link.connectionUserId, link.yahooLeagueKey, {
    refresh,
  });

  return c.json({
    seasonYear: link.seasonYear,
    standings: rows.map((row) => ({
      rank: row.rank ?? null,
      yahooTeamKey: row.teamKey,
      name: row.name,
      record: row.recordLabel ?? null,
      wins: row.wins ?? null,
      losses: row.losses ?? null,
      ties: row.ties ?? null,
      pointsFor: row.pointsFor ?? null,
      pointsAgainst: row.pointsAgainst ?? null,
      streak: row.streak ?? null,
      managers: row.managers.map((manager) => manager.nickname),
      isYou: isOwnedByViewer(row.managers),
    })),
    fetchedAt: new Date().toISOString(),
    viewerUserId: principal.userId,
  });
});

leagueViewRoutes.get('/api/league/matchups/:week', async (c) => {
  const ctx = c.get('ctx');
  requireAuthenticated(ctx.principal);
  requireLeagueId(ctx);

  const week = weekNumberSchema.parse(Number(c.req.param('week')));

  const link = await currentLink(ctx as never);
  if (!link) {
    throw new AppError('yahoo_league_not_linked', {
      publicMessage: 'No Yahoo league is linked yet, so there are no matchups to show.',
    });
  }

  const refresh = c.req.query('refresh') === '1';
  const matchups = await ctx.yahoo.getScoreboard(link.connectionUserId, link.yahooLeagueKey, week, {
    refresh,
  });

  return c.json({
    week,
    seasonYear: link.seasonYear,
    matchups: matchups.map((matchup) => {
      const teams = matchup.teams.map((team) => ({
        yahooTeamKey: team.teamKey,
        name: team.name ?? '(unnamed team)',
        points: team.points ?? null,
        managers: team.managers.map((manager) => manager.nickname),
        isYou: isOwnedByViewer(team.managers),
        isWinner: matchup.winnerTeamKey === team.teamKey,
      }));

      const [first, second] = teams;
      const margin =
        first?.points !== null &&
        first?.points !== undefined &&
        second?.points !== null &&
        second?.points !== undefined
          ? Math.round(Math.abs(first.points - second.points) * 10) / 10
          : null;

      return {
        teams,
        isTied: matchup.isTied ?? false,
        // Yahoo's own status: 'preevent', 'midevent', 'postevent'. Whether a score
        // is final matters, and guessing from the clock would be wrong.
        status: matchup.status ?? null,
        margin,
        // True when the signed-in user is in this matchup, so the UI can lead with it.
        involvesYou: teams.some((team) => team.isYou),
      };
    }),
    fetchedAt: new Date().toISOString(),
  });
});

/**
 * A compact summary for the home screen.
 *
 * One request rather than three, because this is the first paint a manager sees
 * and three round trips would show three separate loading states.
 */
leagueViewRoutes.get('/api/league/me', async (c) => {
  const ctx = c.get('ctx');
  requireAuthenticated(ctx.principal);
  requireLeagueId(ctx);

  const link = await currentLink(ctx as never);
  if (!link) return c.json({ linked: false });

  const metadata = await ctx.yahoo.getLeagueMetadata(link.connectionUserId, link.yahooLeagueKey);
  const week = metadata.currentWeek ?? metadata.startWeek ?? 1;

  const [standings, matchups] = await Promise.all([
    ctx.yahoo.getStandings(link.connectionUserId, link.yahooLeagueKey),
    ctx.yahoo.getScoreboard(link.connectionUserId, link.yahooLeagueKey, week),
  ]);

  const myRow = standings.find((row) => isOwnedByViewer(row.managers));
  const myMatchup = matchups.find((matchup) =>
    matchup.teams.some((team) => isOwnedByViewer(team.managers)),
  );

  const myTeam = myMatchup?.teams.find((team) => isOwnedByViewer(team.managers));
  const opponent = myMatchup?.teams.find((team) => !isOwnedByViewer(team.managers));

  return c.json({
    linked: true,
    seasonYear: link.seasonYear,
    week,
    leagueName: metadata.name,
    teamCount: metadata.teamCount ?? standings.length,
    playoffStartWeek: metadata.playoffStartWeek ?? null,

    /**
     * Null when Yahoo does not mark any team as the signed-in user's.
     *
     * That is the normal case for a commissioner reading a league they do not play
     * in, and for a member viewing through someone else's connection — so the UI
     * must handle it rather than assume everyone has a team.
     */
    you: myRow
      ? {
          yahooTeamKey: myRow.teamKey,
          name: myRow.name,
          rank: myRow.rank ?? null,
          record: myRow.recordLabel ?? null,
          pointsFor: myRow.pointsFor ?? null,
          pointsAgainst: myRow.pointsAgainst ?? null,
          streak: myRow.streak ?? null,
        }
      : null,

    matchup:
      myMatchup && myTeam
        ? {
            status: myMatchup.status ?? null,
            isTied: myMatchup.isTied ?? false,
            you: { name: myTeam.name ?? myRow?.name ?? 'Your team', points: myTeam.points ?? null },
            opponent: opponent
              ? {
                  name: opponent.name ?? '(unnamed team)',
                  points: opponent.points ?? null,
                  managers: opponent.managers.map((manager) => manager.nickname),
                }
              : null,
            margin:
              myTeam.points !== undefined && opponent?.points !== undefined
                ? Math.round((myTeam.points - opponent.points) * 10) / 10
                : null,
          }
        : null,

    leaders: standings.slice(0, 3).map((row) => ({
      rank: row.rank ?? null,
      name: row.name,
      record: row.recordLabel ?? null,
      isYou: isOwnedByViewer(row.managers),
    })),

    // The week's biggest performances, computed here from the live scoreboard.
    // Not stored: these are Yahoo-derived and expire with the cache.
    highestScore: highestScore(matchups),
    closestMatchup: closestMatchup(matchups),

    fetchedAt: new Date().toISOString(),
  });
});

function highestScore(
  matchups: Array<{ teams: Array<{ name?: string | undefined; points?: number | undefined }> }>,
): { name: string; points: number } | null {
  let best: { name: string; points: number } | null = null;

  for (const matchup of matchups) {
    for (const team of matchup.teams) {
      if (team.points === undefined) continue;
      if (!best || team.points > best.points) {
        best = { name: team.name ?? '(unnamed team)', points: team.points };
      }
    }
  }

  return best;
}

function closestMatchup(
  matchups: Array<{ teams: Array<{ name?: string | undefined; points?: number | undefined }> }>,
): { margin: number; teams: string[] } | null {
  let best: { margin: number; teams: string[] } | null = null;

  for (const matchup of matchups) {
    const [first, second] = matchup.teams;
    if (first?.points === undefined || second?.points === undefined) continue;

    const margin = Math.round(Math.abs(first.points - second.points) * 10) / 10;
    if (!best || margin < best.margin) {
      best = {
        margin,
        teams: [first.name ?? '(unnamed team)', second.name ?? '(unnamed team)'],
      };
    }
  }

  return best;
}

export { isOwnedByViewer };
