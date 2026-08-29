/**
 * What to call a manager, in one place.
 *
 * Two names exist for the same person and they do not always agree. A league
 * member carries `legacyManagerName`, set by the commissioner when the roster was
 * entered or imported. A portal user carries `displayName`, which starts life as
 * their Yahoo nickname and which they can change at any time.
 *
 * The commissioner's name wins.
 *
 * That order is the opposite of what this codebase did in all seven places it
 * made the decision, and the reason for the change is concrete. This league has
 * two men called Kevin. Yahoo knows them as "Kevin" and "Kevyn" — one letter
 * apart — and the league itself has always called them K-Mac and Kevo. With the
 * display name winning, the board showed the pair of near-identical nicknames and
 * one of them was mailed to say he had been credited with the other's
 * championship. Renaming the member records fixes it right up until either man
 * signs in, at which point his Yahoo nickname silently takes the label back.
 *
 * So: a name the commissioner set deliberately, for a board the whole league
 * reads, outranks a nickname its owner can change on a whim. Someone with no
 * commissioner-set name still gets their own, which is the ordinary case for
 * anyone who joined by signing in.
 *
 * The rule lives here rather than being written out at each call site because it
 * was written out at each call site, seven times, and a rule copied seven times
 * is a rule that drifts.
 */

/**
 * The parts of a league member this decision actually reads.
 *
 * Generic over the id type so a branded `InternalId` survives the round trip into
 * the lookup: widening it to `string` here would push the cast out to all seven
 * call sites, which is exactly the sort of friction that gets solved by not using
 * the helper. `userId` is nullable as well as optional because the stored entity
 * writes an explicit null for a member nobody has claimed.
 */
export interface NameableMember<Id extends string = string> {
  userId?: Id | null | undefined;
  legacyManagerName?: string | undefined;
}

/**
 * Resolves a found member's name.
 *
 * Deliberately says nothing about a member that could not be found: callers
 * disagree about whether that is "(former member)", "(unknown manager)" or
 * something else, and each of them is right for its own screen.
 *
 * @param displayNameOf looks up a portal user's self-chosen display name.
 */
export function managerName<Id extends string>(
  member: NameableMember<Id>,
  displayNameOf: (userId: Id) => string | undefined,
): string {
  const commissionerSet = member.legacyManagerName?.trim();
  if (commissionerSet) return commissionerSet;

  const own = member.userId ? displayNameOf(member.userId)?.trim() : undefined;
  if (own) return own;

  return '(unnamed manager)';
}
