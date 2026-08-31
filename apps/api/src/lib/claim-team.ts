import type { InternalId } from '@lopie/shared';
import type { RequestContext } from '../context.js';
import { describeError } from './logger.js';

/**
 * Attaching a person to the team they manage.
 *
 * The league knows which team belongs to which manager — every member row carries
 * a `yahooTeamKey`. What it cannot know is which of those managers is signing in:
 * a sign-in yields a Yahoo GUID, and no member row records one.
 *
 * Only one Yahoo call closes that gap, and it must be made with the VIEWER's own
 * token. Every other read the portal makes goes through the commissioner's
 * connection, where `is_current_login` marks the commissioner's team regardless of
 * who is asking, and other managers' GUIDs come back redacted as `--hidden--`.
 *
 * This lives on its own because it has to run from two places, and running two
 * slightly different versions of it would defeat the point. At sign-in there is a
 * fresh access token in hand. Afterwards there is a stored connection instead —
 * which is what a backfill needs, because anybody who signed in before their
 * roster row existed will never pass back through the sign-in path.
 */

export interface ClaimResult {
  status: 'claimed' | 'already' | 'no-match' | 'conflict' | 'skipped' | 'failed';
  leagueMemberId?: string;
  detail?: string;
}

/** Just enough of the Yahoo client to ask "which teams are mine". */
export interface TeamLister {
  getUserFootballTeams(): Promise<Array<{ teamKey: string; leagueKey: string | undefined }>>;
}

export async function claimTeamWith(
  ctx: RequestContext,
  userId: InternalId,
  lister: TeamLister,
): Promise<ClaimResult> {
  try {
    const leagueId = ctx.leagueId;
    if (!leagueId) return { status: 'skipped', detail: 'no league' };

    const { currentLink } = await import('../routes/yahoo.js');
    const link = await currentLink(ctx as never);
    if (!link) return { status: 'skipped', detail: 'no Yahoo league linked' };

    const members = await ctx.repositories.leagues.listMembers(leagueId, link.seasonYear as never);

    const already = members.find((member) => member.userId === userId);
    if (already) {
      return { status: 'already', leagueMemberId: already.leagueMemberId };
    }

    const teams = await lister.getUserFootballTeams();

    /*
      Matched on the team key, never on position in the list. Yahoo returns every
      football team the account manages and plenty of people play in more than one
      league, so taking the first would attach someone to a stranger's league.
    */
    const mine = members.find((member) =>
      teams.some((team) => team.teamKey === member.yahooTeamKey),
    );

    if (!mine) return { status: 'no-match', detail: `${teams.length} team(s) on the account` };

    if (mine.userId && mine.userId !== userId) {
      /*
        Two accounts on one team is a real conflict rather than something to
        overwrite quietly — a shared Yahoo login, or a team that changed hands. The
        commissioner decides who that row belongs to.
      */
      return { status: 'conflict', leagueMemberId: mine.leagueMemberId };
    }

    const isoNow = new Date().toISOString().replace(/\.\d{3}Z$/, '');
    await ctx.repositories.leagues.saveMember(
      { ...mine, userId, updatedAt: isoNow, updatedBy: userId, version: mine.version + 1 },
      mine.version,
    );

    await ctx.repositories.audit.record({
      leagueId,
      action: 'yahoo.team_claimed',
      actorUserId: userId,
      actorRole: 'manager',
      summary: 'Matched a manager to their own Yahoo team.',
      correlationId: ctx.correlationId,
      targetEntity: 'LeagueMember',
      targetId: mine.leagueMemberId,
    });

    return { status: 'claimed', leagueMemberId: mine.leagueMemberId };
  } catch (error) {
    // Never the reason a sign-in fails.
    ctx.logger.warn('could not claim a team', describeError(error));
    return { status: 'failed', detail: 'Yahoo call failed' };
  }
}
