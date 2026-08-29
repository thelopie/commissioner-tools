import { Hono } from 'hono';
import { isSettled, seasonYearSchema, type SeasonYear } from '@lopie/shared';
import type { AppEnv } from '../context.js';
import { requireLeagueId } from '../context.js';
import { requireAuthenticated } from '../lib/authorization.js';

/**
 * Where everybody stands across the whole season, and who has won what over the
 * years.
 *
 * The thirteen weekly challenges were thirteen unrelated events. Each had a page,
 * none had a total, and no manager could answer the question they actually care
 * about: am I up or down. Dues had the same problem in reverse — an administrative
 * row nobody looked at, when owing thirty-five dollars is a standing in its own
 * right.
 *
 * This adds nothing new to the model. It is a join across challenge results,
 * payouts and dues that nothing else performed, plus the record books, which fall
 * out of `finalFinishOrder` — best first, so the champion, the runner-up and the
 * Sacko are the first, second and last entries of a list the league already keeps
 * for the draft-order tiebreaker.
 *
 * Deliberately not a second challenges page: no rules, no per-week detail, no
 * calculate button. Totals and history only; the challenges page owns the rest.
 */
export const ledgerRoutes = new Hono<AppEnv>();

interface LedgerEntry {
  leagueMemberId: string;
  name: string;
  challengesWon: number;
  /** Prize money recorded for the season, whether or not it has been handed over. */
  wonCents: number;
  /** Of that, what has actually been settled. */
  paidOutCents: number;
  duesOwedCents: number;
  duesPaidCents: number;
  /** Prizes minus what they are into the league for. The number people check. */
  netCents: number;
}

ledgerRoutes.get('/api/league/ledger/:seasonYear', async (c) => {
  const ctx = c.get('ctx');
  requireAuthenticated(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));

  const [members, users, results, payouts, dues, seasons] = await Promise.all([
    ctx.repositories.leagues.listMembers(leagueId, seasonYear),
    ctx.repositories.users.listByLeague(leagueId),
    ctx.repositories.challenges.listResults(leagueId, seasonYear),
    ctx.repositories.money.listPayouts(leagueId, seasonYear),
    ctx.repositories.money.listDues(leagueId, seasonYear),
    ctx.repositories.leagues.listSeasons(leagueId),
  ]);

  const userById = new Map(users.map((user) => [user.userId, user]));

  const nameOf = (memberId: string, pool = members): string => {
    const member = pool.find((candidate) => candidate.leagueMemberId === memberId);
    if (!member) return '(former member)';
    return (
      (member.userId ? userById.get(member.userId)?.displayName : undefined) ??
      member.legacyManagerName ??
      '(unnamed manager)'
    );
  };

  /*
    A challenge counts once it is somebody's to claim. Provisional results are still
    moving — Yahoo corrects stats for days — so counting them would let a total go
    down again, which is worse than being briefly behind.
  */
  const settledResults = results.filter(
    (result) =>
      result.status === 'finalized' || result.status === 'overridden' || result.status === 'manual',
  );

  const winsByMember = new Map<string, number>();
  for (const result of settledResults) {
    for (const memberId of result.winningLeagueMemberIds) {
      winsByMember.set(memberId, (winsByMember.get(memberId) ?? 0) + 1);
    }
  }

  const duesByMember = new Map(dues.map((record) => [record.leagueMemberId, record]));

  const entries: LedgerEntry[] = members
    .filter((member) => member.isActive)
    .map((member) => {
      const mine = payouts.filter((payout) => payout.leagueMemberId === member.leagueMemberId);
      const wonCents = mine.reduce((total, payout) => total + payout.amount.amountCents, 0);
      const paidOutCents = mine
        .filter((payout) => isSettled(payout.status))
        .reduce((total, payout) => total + payout.amount.amountCents, 0);

      const owed = duesByMember.get(member.leagueMemberId);
      const duesOwedCents = owed?.amountOwed.amountCents ?? 0;
      const duesPaidCents = owed?.amountPaid.amountCents ?? 0;

      return {
        leagueMemberId: member.leagueMemberId,
        name: nameOf(member.leagueMemberId),
        challengesWon: winsByMember.get(member.leagueMemberId) ?? 0,
        wonCents,
        paidOutCents,
        duesOwedCents,
        duesPaidCents,
        // What they are up or down on the season, before anything is handed over.
        netCents: wonCents - duesOwedCents,
      };
    })
    .sort((a, b) => b.netCents - a.netCents || a.name.localeCompare(b.name));

  /*
    The record books.

    `finalFinishOrder` is kept for the draft-order tiebreaker and is best-first, so
    it already holds the three things a league argues about. Members are
    season-scoped, so each year's names are resolved against that year's roster —
    somebody who left in 2021 still has a name on their 2019 title.
  */
  const finished = seasons
    .filter((season) => season.finalFinishOrder.length > 0)
    .sort((a, b) => b.seasonYear - a.seasonYear);

  /*
    Every roster the league has, not just the one matching the season.

    A finish order holds member ids, and a member row is season-scoped — but the two
    do not have to agree about which season. A league recording last year's result
    for the draft tiebreaker naturally references the members it has now, which is
    exactly what happened here: the 2025 order points at rows filed under 2026.
    Looking only in 2025 found nothing and put "(former member)" against every
    champion, runner-up and Sacko in the record books.

    So: prefer the season's own roster, where one exists, and fall back to anyone the
    league has ever had.
  */
  const rosters = await Promise.all(
    finished.map((season) =>
      ctx.repositories.leagues.listMembers(leagueId, season.seasonYear as SeasonYear),
    ),
  );

  const everyone = [...members, ...rosters.flat()];

  const history = finished.map((season, index) => {
    const roster = [...(rosters[index] ?? []), ...everyone];
    const order = season.finalFinishOrder;

    return {
      seasonYear: season.seasonYear,
      champion: nameOf(order[0]!, roster),
      runnerUp: order.length > 1 ? nameOf(order[1]!, roster) : null,
      // Last place. The league calls it the Sacko.
      sacko: order.length > 2 ? nameOf(order[order.length - 1]!, roster) : null,
      teamCount: order.length,
    };
  });

  const totalPotCents = dues.reduce((total, record) => total + record.amountOwed.amountCents, 0);

  return c.json({
    seasonYear,
    entries,
    history,
    pot: {
      totalCents: totalPotCents,
      collectedCents: dues.reduce((total, record) => total + record.amountPaid.amountCents, 0),
      awardedCents: payouts.reduce((total, payout) => total + payout.amount.amountCents, 0),
    },
    /** Bookkeeping only, in case this is ever read as something else. */
    note: 'Money recorded here moved elsewhere. The portal processes no payments.',
  });
});
