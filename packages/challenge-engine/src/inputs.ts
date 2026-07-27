import type { InternalId, SeasonYear, WeekNumber } from '@dinkel/shared';

/**
 * The engine's input contract.
 *
 * Deliberately decoupled from Yahoo's shapes. The API fetches from Yahoo,
 * translates into this, and throws the Yahoo response away — so the engine is
 * pure arithmetic over plain numbers, testable without a network or a fixture of
 * somebody's real league.
 *
 * Everything here is transient. Nothing in this file is persisted.
 */

/** One player on one roster for one week. */
export interface PlayerWeek {
  playerKey: string;
  /** Display text for the explanation string only. Never stored. */
  playerName: string;
  /**
   * Yahoo's roster slot code. `BN` is bench, `IR` is injured reserve.
   *
   * Recorded verbatim rather than normalized to a boolean: the bench code is an
   * unverified convention (see `yahoo-capabilities.json`), and collapsing it here
   * would hide a surprise value inside a calculation.
   */
  selectedPosition: string;
  /** The player's actual position, e.g. RB. Used by position-group challenges. */
  position: string;
  /**
   * Fantasy points under this league's scoring.
   *
   * Undefined means Yahoo reported no value — a player who did not play. That is
   * distinct from 0, which is a real score, and the difference decides some
   * challenges.
   */
  points?: number;
  /** Projected points. Usually undefined: see the projection capability gap. */
  projectedPoints?: number;
  /** Raw stat values by Yahoo stat id, when the caller fetched them. */
  statsByYahooId?: Record<number, number>;
}

/** One competitor's week: their roster, their score, and their matchup outcome. */
export interface TeamWeek {
  /** Dinkel's identifier. The engine never sees a Yahoo team key. */
  leagueMemberId: InternalId;
  /** Total points for the week. */
  teamPoints?: number;
  projectedTeamPoints?: number;
  /** Matchup outcome, when matchup data was fetched. */
  outcome?: 'win' | 'loss' | 'tie';
  /** Points the opponent scored, for margin calculations. */
  opponentPoints?: number;
  opponentLeagueMemberId?: InternalId;
  players: PlayerWeek[];
  /** Season record before this week, for the `worse_record` tiebreaker. */
  priorWins?: number;
  priorLosses?: number;
  /** Whether this member's dues are paid, for eligibility rules. */
  duesPaid?: boolean;
  /** How many times they have already won this challenge this season. */
  priorWinsOfThisChallenge?: number;
}

export interface WeekInput {
  seasonYear: SeasonYear;
  week: WeekNumber;
  teams: TeamWeek[];
}

/** Bench slot codes. `IR` counts as bench for "points left on the bench". */
const BENCH_SLOTS = new Set(['BN', 'IR', 'IR+', 'NA']);

export function isBench(slot: string): boolean {
  return BENCH_SLOTS.has(slot.toUpperCase());
}

export function isStarter(slot: string): boolean {
  return !isBench(slot);
}

export function starters(team: TeamWeek): PlayerWeek[] {
  return team.players.filter((player) => isStarter(player.selectedPosition));
}

export function bench(team: TeamWeek): PlayerWeek[] {
  return team.players.filter((player) => isBench(player.selectedPosition));
}

/**
 * Sums points, honouring the definition's flags.
 *
 * A player with no reported points contributes nothing rather than a zero, and
 * negative values are dropped when the definition excludes them — a defense that
 * scored -3 should not silently reduce a "most points" total if the league says
 * negatives do not count.
 */
export function sumPoints(
  players: readonly PlayerWeek[],
  options: { negativesCount: boolean; decimalsCount: boolean },
): number {
  let total = 0;
  for (const player of players) {
    if (player.points === undefined) continue;
    if (!options.negativesCount && player.points < 0) continue;
    total += player.points;
  }
  return roundValue(total, options.decimalsCount);
}

/**
 * Applies the decimals flag.
 *
 * Rounds to one decimal place when decimals count, because fantasy scoring is
 * quoted to a tenth and floating-point addition of tenths otherwise produces
 * 28.400000000000002, which then loses a tie comparison it should have won.
 */
export function roundValue(value: number, decimalsCount: boolean): number {
  if (!decimalsCount) return Math.round(value);
  return Math.round(value * 10) / 10;
}

/** Formats a number for an explanation string. */
export function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
