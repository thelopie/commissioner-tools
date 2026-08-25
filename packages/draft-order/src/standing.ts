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
  /** True once the team is out and the position cannot move. */
  locked: boolean;
  /** Best position still reachable. Equals `worst` when locked. */
  best: number;
  /** Worst position still possible. Equals `best` when locked. */
  worst: number;
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
  }));

  outSorted.forEach((team, index) => {
    /*
      Everyone still playing finishes above this team, and so does every eliminated
      team with a better rank. `index` is exactly that second count, because the
      list is sorted best-first.
    */
    const position = stillPlaying.length + index + 1;
    standings.push({
      leagueMemberId: team.leagueMemberId,
      locked: true,
      best: position,
      worst: position,
    });
  });

  return standings;
}

/**
 * The rank to give a team being knocked out now.
 *
 * Saves the commissioner working out that the fourteenth team to go in a
 * twenty-team field finished seventeenth. Ranks fill from the bottom as teams go
 * out, which is the order the information actually arrives in.
 */
export function nextEliminationRank(totalTeams: number, alreadyEliminated: number): number {
  if (alreadyEliminated >= totalTeams) {
    throw new AppError('precondition_failed', {
      publicMessage: 'Every team in the field is already out.',
    });
  }

  return totalTeams - alreadyEliminated;
}
