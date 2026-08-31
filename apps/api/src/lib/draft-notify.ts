import type { InternalId } from '@lopie/shared';
import type { RequestContext } from '../context.js';

/**
 * Telling the next manager it is their turn.
 *
 * The draft order is a queue that only moves when somebody acts, and nothing about
 * the site pushes. Without this, whoever is up has no idea until they happen to
 * open the page — which on a twelve-person queue means it stalls on whoever checks
 * least often.
 *
 * Address resolution goes through the portal user, not the member row: an email is
 * something the person gave this application when they signed in, rather than
 * something scraped out of Yahoo and kept. Someone who has never signed in has no
 * address here, and also cannot pick, so there is nothing to tell them yet.
 */

export async function notifyTurnOpened(
  ctx: RequestContext,
  leagueMemberId: InternalId,
  seasonYear: number,
): Promise<boolean> {
  try {
    const leagueId = ctx.leagueId;
    if (!leagueId) return false;

    const members = await ctx.repositories.leagues.listMembers(leagueId, seasonYear as never);
    const member = members.find((candidate) => candidate.leagueMemberId === leagueMemberId);
    if (!member?.userId) return false;

    const user = await ctx.repositories.users.findById(member.userId);
    if (!user?.email) return false;

    const selections = await ctx.repositories.llws.listSelections(leagueId, seasonYear as never);
    const mine = selections.find((s) => s.leagueMemberId === leagueMemberId);
    const taken = selections
      .filter((s) => s.chosenDraftPosition !== null)
      .sort((a, b) => (a.chosenDraftPosition ?? 0) - (b.chosenDraftPosition ?? 0))
      .map((s) => s.chosenDraftPosition);

    const url = `${ctx.config.env.APP_BASE_URL}/draft`;

    const text = [
      `You're up. It's your turn to choose your draft slot.`,
      '',
      `Pick here: ${url}`,
      '',
      mine ? `You're number ${mine.selectionOrder} in the order of choosing.` : '',
      taken.length > 0 ? `Slots already taken: ${taken.join(', ')}.` : 'No slots taken yet.',
      '',
      `Your pick locks as soon as you make it, so choose the slot you actually want.`,
      '',
      '— La Liga de Lopie',
    ]
      .filter((line) => line !== '')
      .join('\n');

    return await ctx.mailer.send({
      to: user.email,
      subject: `Your turn to pick a draft slot`,
      text,
    });
  } catch {
    // Never the reason a pick fails.
    ctx.logger.warn('could not send the turn notification');
    return false;
  }
}
