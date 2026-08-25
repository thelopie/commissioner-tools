import { AppError } from '@lopie/shared';

/**
 * Where each manager stands while the tournament is still being played.
 *
 * The league wants to know this the whole way through August, not only at the end,
 * and the answer is derivable rather than guessed at. One fact does all the work:
 *
 *   a team still in the tournament finishes above every team already out of it.
 *
 * So an eliminated team's position is settled the moment it goes out — everyone
 * still playing will finish above it, and the eliminated teams below it are already
 * ordered. And a team still playing can finish anywhere from first down to last
 * among the teams still playing, a range that narrows by itself every time somebody
 * else is knocked out. When one team is left, its range is a single position.
 *
 * Positions are counted among the managers who drew a team, not among all twenty:
 * eight of the LLWS field went undrawn, and they take no part in the draft order.
 */

export interface StandingInput {
  leagueMemberId: string;
  /** Set once the team is out. Absent means still playing. */
  finishRank?: number | undefined;
}

export interface Standing {
  leagueMemberId: string;
  /** True only when the position is a single number that cannot move. */
  locked: boolean;
  /** Best position still reachable. Equals `worst` when locked. */
  best: number;
  /** Worst position still possible. Equals `best` when locked. */
  worst: number;
  /**
   * Why the position is still a range.
   *
   * `playing` narrows as other teams are knocked out. `tied` will not narrow at all
   * — those teams went out together, and which of them picks first is settled by the
   * league's tiebreakers rather than by anything else happening on the field.
   */
  pending: 'playing' | 'tied' | null;
}

/**
 * @throws {AppError} on a duplicate member, which would corrupt every position.
 */
export function currentStandings(teams: StandingInput[]): Standing[] {
  const seen = new Set<string>();
  for (const team of teams) {
    if (seen.has(team.leagueMemberId)) {
      throw new AppError('validation_failed', {
        publicMessage: 'A manager appears twice in the LLWS standings.',
      });
    }
    seen.add(team.leagueMemberId);
  }

  const stillPlaying = teams.filter((team) => team.finishRank === undefined);
  const out = teams.filter((team) => team.finishRank !== undefined);

  // Best finish first, so counting how many finished above a team is a prefix count.
  const outSorted = [...out].sort((a, b) => a.finishRank! - b.finishRank!);

  const standings: Standing[] = stillPlaying.map((team) => ({
    leagueMemberId: team.leagueMemberId,
    // A single team left has nowhere to move, so it is locked at first.
    locked: stillPlaying.length === 1,
    best: 1,
    worst: stillPlaying.length,
    pending: stillPlaying.length === 1 ? null : 'playing',
  }));

  /*
    Teams knocked out in the same round share a finish rank, and therefore share a
    band of positions rather than being ordered by whatever sequence somebody
    recorded them in. Which of them picks first is decided by the league's
    tiebreakers — prior-season finish, then the recorded seed — and pretending
    otherwise would let the order of a few button presses choose draft slots.
  */
  const groups = new Map<number, StandingInput[]>();
  for (const team of outSorted) {
    groups.set(team.finishRank!, [...(groups.get(team.finishRank!) ?? []), team]);
  }

  let position = stillPlaying.length + 1;

  for (const rank of [...groups.keys()].sort((a, b) => a - b)) {
    const group = groups.get(rank)!;
    const best = position;
    const worst = position + group.length - 1;

    for (const team of group) {
      standings.push({
        leagueMemberId: team.leagueMemberId,
        locked: group.length === 1,
        best,
        worst,
        pending: group.length === 1 ? null : 'tied',
      });
    }

    position = worst + 1;
  }

  return standings;
}

/**
 * The rank to give a group of teams knocked out together.
 *
 * Every team in the group gets the same rank, because they got equally far. Five
 * teams going out of a field of twenty in the same round are jointly sixteenth, not
 * sixteenth through twentieth in the order somebody clicked them — that ordering
 * would be invented here and would silently decide draft slots, which is exactly
 * what the league's tiebreakers exist to decide instead.
 *
 * Ranks fill from the bottom as rounds conclude, which is the order the news
 * arrives in.
 */
export function eliminationRankForGroup(
  totalTeams: number,
  alreadyEliminated: number,
  groupSize: number,
): number {
  if (groupSize < 1) {
    throw new AppError('validation_failed', { publicMessage: 'No teams to mark out.' });
  }

  if (alreadyEliminated + groupSize > totalTeams) {
    throw new AppError('precondition_failed', {
      publicMessage: 'That is more teams than are left in the field.',
    });
  }

  return totalTeams - alreadyEliminated - (groupSize - 1);
}
