import type { Calculation, WeeklyChallengeDefinition } from '@dinkel/shared';
import {
  bench,
  formatValue,
  isStarter,
  roundValue,
  starters,
  sumPoints,
  type PlayerWeek,
  type TeamWeek,
} from './inputs.js';

/**
 * The calculators.
 *
 * Each returns one comparable number per competitor plus a sentence explaining
 * how that number was reached. The explanation is not decoration: it is the
 * limited derived value stored on a finalized result, and it is what lets a
 * commissioner defend a payout in 2031 without any Yahoo data retained.
 *
 * A language model is never involved in producing these numbers.
 */

export interface CalculatorResult {
  /** The comparable value, or undefined when this competitor has no valid value. */
  value?: number;
  explanation: string;
  /** Set when the competitor cannot be ranked, e.g. required data is missing. */
  unavailableReason?: string;
}

export type Calculator = (
  team: TeamWeek,
  definition: WeeklyChallengeDefinition,
  context: { teams: readonly TeamWeek[] },
) => CalculatorResult;

const flags = (definition: WeeklyChallengeDefinition) => ({
  negativesCount: definition.negativesCount,
  decimalsCount: definition.decimalsCount,
});

/** Players eligible under the definition's bench rule. */
function scoringPlayers(team: TeamWeek, definition: WeeklyChallengeDefinition): PlayerWeek[] {
  return definition.benchCounts ? team.players : starters(team);
}

function highestScorer(
  players: readonly PlayerWeek[],
  definition: WeeklyChallengeDefinition,
): { player: PlayerWeek; points: number } | null {
  let best: { player: PlayerWeek; points: number } | null = null;

  for (const player of players) {
    if (player.points === undefined) continue;
    if (!definition.negativesCount && player.points < 0) continue;

    const points = roundValue(player.points, definition.decimalsCount);
    if (!best || points > best.points) best = { player, points };
  }

  return best;
}

const CALCULATORS: Record<Calculation['type'], Calculator> = {
  /** One Man Army — the single biggest individual performance. */
  highest_single_starter_score: (team, definition) => {
    const pool = scoringPlayers(team, definition);
    const best = highestScorer(pool, definition);

    if (!best) {
      return { explanation: 'No player recorded points.', unavailableReason: 'no_player_points' };
    }

    const scope = definition.benchCounts ? 'any rostered player' : 'starter';
    return {
      value: best.points,
      explanation: `Top ${scope}: ${best.player.playerName} scored ${formatValue(best.points)}.`,
    };
  },

  /**
   * Photo Finish — the narrowest margin.
   *
   * Computed from the margin of the competitor's own matchup, so both teams in
   * the closest game tie on the value and the definition's tiebreakers decide.
   * Whether the winner or the loser takes it is a league policy question, and
   * making both eligible keeps that decision in the tiebreaker configuration
   * rather than buried here.
   */
  smallest_margin_of_victory: (team, definition) => {
    if (team.teamPoints === undefined || team.opponentPoints === undefined) {
      return { explanation: 'No matchup result available.', unavailableReason: 'no_matchup' };
    }

    const margin = roundValue(
      Math.abs(team.teamPoints - team.opponentPoints),
      definition.decimalsCount,
    );

    return {
      value: margin,
      explanation:
        `Matchup decided by ${formatValue(margin)} ` +
        `(${formatValue(team.teamPoints)} to ${formatValue(team.opponentPoints)}).`,
    };
  },

  /** Bench Mob — most points left on the bench. */
  highest_bench_total: (team, definition) => {
    const benched = bench(team);
    if (benched.length === 0) {
      return { explanation: 'No bench players.', unavailableReason: 'no_bench' };
    }

    const total = sumPoints(benched, flags(definition));
    const contributors = benched
      .filter((player) => player.points !== undefined)
      .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
      .slice(0, 3)
      .map((player) => `${player.playerName} ${formatValue(player.points ?? 0)}`);

    return {
      value: total,
      explanation:
        `Bench totalled ${formatValue(total)} across ${benched.length} players` +
        (contributors.length > 0 ? ` (top: ${contributors.join(', ')}).` : '.'),
    };
  },

  /**
   * Ground and Pound / Tight End Day / Air Raid / Defense Wins Championships —
   * most points from a position group.
   */
  highest_position_group_total: (team, definition) => {
    if (definition.calculation.type !== 'highest_position_group_total') {
      return { explanation: '', unavailableReason: 'calculator_mismatch' };
    }

    const wanted = new Set(definition.calculation.positions.map((p) => p.toUpperCase()));
    const pool = scoringPlayers(team, definition).filter((player) =>
      wanted.has(player.position.toUpperCase()),
    );

    if (pool.length === 0) {
      return {
        explanation: `No ${[...wanted].join('/')} players counted.`,
        unavailableReason: 'no_players_at_position',
      };
    }

    const total = sumPoints(pool, flags(definition));
    const names = pool
      .filter((player) => player.points !== undefined)
      .map((player) => `${player.playerName} ${formatValue(player.points ?? 0)}`);

    return {
      value: total,
      explanation: `${[...wanted].join('/')} totalled ${formatValue(total)}: ${names.join(' + ')}.`,
    };
  },

  /** Bad Beat — the highest score that still lost. */
  highest_score_in_loss: (team, definition) => {
    if (team.teamPoints === undefined || team.outcome === undefined) {
      return { explanation: 'No matchup result available.', unavailableReason: 'no_matchup' };
    }

    if (team.outcome !== 'loss') {
      return {
        explanation: 'Did not lose this week.',
        unavailableReason: 'did_not_lose',
      };
    }

    const points = roundValue(team.teamPoints, definition.decimalsCount);
    const opponent =
      team.opponentPoints === undefined ? '' : ` to ${formatValue(team.opponentPoints)}`;

    return {
      value: points,
      explanation: `Lost with ${formatValue(points)}${opponent}.`,
    };
  },

  /**
   * Overachiever — biggest overperformance against projection.
   *
   * Requires projected points, which no current Yahoo documentation describes as
   * an API field. The challenge stays BLOCKED, so this path only executes if a
   * real league proves projections are available.
   */
  largest_projection_overperformance: (team, definition) => {
    if (team.teamPoints === undefined || team.projectedTeamPoints === undefined) {
      return {
        explanation: 'No projection available for this week.',
        unavailableReason: 'no_projection',
      };
    }

    const delta = roundValue(team.teamPoints - team.projectedTeamPoints, definition.decimalsCount);
    return {
      value: delta,
      explanation:
        `Scored ${formatValue(team.teamPoints)} against a projection of ` +
        `${formatValue(team.projectedTeamPoints)} (${delta >= 0 ? '+' : ''}${formatValue(delta)}).`,
    };
  },

  /**
   * Blackjack — closest to a target without going over.
   *
   * Going over is disqualifying, not merely penalized: that is what makes it
   * blackjack rather than "closest to 21". The value is the distance below the
   * target, so a lower value is better and the definition uses `minimize`.
   */
  closest_to_target_without_exceeding: (team, definition) => {
    if (definition.calculation.type !== 'closest_to_target_without_exceeding') {
      return { explanation: '', unavailableReason: 'calculator_mismatch' };
    }

    const { target, subject } = definition.calculation;

    if (subject === 'team') {
      if (team.teamPoints === undefined) {
        return { explanation: 'No team score available.', unavailableReason: 'no_team_points' };
      }
      const points = roundValue(team.teamPoints, definition.decimalsCount);
      if (points > target) {
        return {
          explanation: `Busted: ${formatValue(points)} exceeds ${formatValue(target)}.`,
          unavailableReason: 'busted',
        };
      }
      return {
        value: roundValue(target - points, definition.decimalsCount),
        explanation: `Scored ${formatValue(points)}, ${formatValue(target - points)} under ${formatValue(target)}.`,
      };
    }

    // Per-starter: the best qualifying player represents the team.
    const pool = scoringPlayers(team, definition).filter(
      (player) => player.points !== undefined && player.points <= target,
    );

    if (pool.length === 0) {
      return {
        explanation: `No player scored at or under ${formatValue(target)}.`,
        unavailableReason: 'busted',
      };
    }

    let best = pool[0]!;
    for (const player of pool) {
      if ((player.points ?? 0) > (best.points ?? 0)) best = player;
    }

    const points = roundValue(best.points ?? 0, definition.decimalsCount);
    return {
      value: roundValue(target - points, definition.decimalsCount),
      explanation:
        `${best.playerName} scored ${formatValue(points)}, closest to ${formatValue(target)} ` +
        `without exceeding it.`,
    };
  },

  /** Bullseye — closest to a target in either direction. */
  closest_to_target: (team, definition) => {
    if (definition.calculation.type !== 'closest_to_target') {
      return { explanation: '', unavailableReason: 'calculator_mismatch' };
    }

    const { targetIsTeamProjection, subject } = definition.calculation;

    const target = targetIsTeamProjection
      ? team.projectedTeamPoints
      : definition.calculation.target;

    if (target === undefined) {
      return {
        explanation: targetIsTeamProjection
          ? 'No projection available to aim at.'
          : 'No target configured.',
        unavailableReason: targetIsTeamProjection ? 'no_projection' : 'no_target',
      };
    }

    const actual =
      subject === 'team'
        ? team.teamPoints
        : highestScorer(scoringPlayers(team, definition), definition)?.points;

    if (actual === undefined) {
      return { explanation: 'No score available.', unavailableReason: 'no_score' };
    }

    const distance = roundValue(Math.abs(actual - target), definition.decimalsCount);
    return {
      value: distance,
      explanation:
        `Scored ${formatValue(actual)} against a target of ${formatValue(target)} ` +
        `(off by ${formatValue(distance)}).`,
    };
  },

  /**
   * Catch Everything — most of one raw stat.
   *
   * Requires per-stat values by Yahoo stat id. No current official documentation
   * publishes the stat-id mapping, so challenges using this stay BLOCKED.
   */
  highest_stat_total: (team, definition) => {
    if (definition.calculation.type !== 'highest_stat_total') {
      return { explanation: '', unavailableReason: 'calculator_mismatch' };
    }

    const { yahooStatId, statLabel } = definition.calculation;
    const pool = scoringPlayers(team, definition);

    let total = 0;
    let counted = 0;
    for (const player of pool) {
      const value = player.statsByYahooId?.[yahooStatId];
      if (value === undefined) continue;
      if (!definition.negativesCount && value < 0) continue;
      total += value;
      counted += 1;
    }

    if (counted === 0) {
      return {
        explanation: `No ${statLabel} data available.`,
        unavailableReason: 'no_stat_data',
      };
    }

    const value = roundValue(total, definition.decimalsCount);
    return {
      value,
      explanation: `${formatValue(value)} ${statLabel} across ${counted} players.`,
    };
  },

  /**
   * Touchdown Dependency — share of points that came from one stat.
   *
   * A ratio needs a guard: a team that scored 3 points, all from a touchdown,
   * would otherwise post a perfect share and beat a team that scored 140. The
   * definition's `minimumTeamPoints` sets the floor.
   */
  highest_stat_share_of_points: (team, definition) => {
    if (definition.calculation.type !== 'highest_stat_share_of_points') {
      return { explanation: '', unavailableReason: 'calculator_mismatch' };
    }

    const { yahooStatIds, statLabel, pointsPerUnit, minimumTeamPoints } = definition.calculation;
    const pool = scoringPlayers(team, definition);

    let units = 0;
    let sawData = false;
    for (const player of pool) {
      for (const statId of yahooStatIds) {
        const value = player.statsByYahooId?.[statId];
        if (value === undefined) continue;
        sawData = true;
        units += value;
      }
    }

    if (!sawData) {
      return { explanation: `No ${statLabel} data available.`, unavailableReason: 'no_stat_data' };
    }

    const totalPoints = team.teamPoints ?? sumPoints(pool, flags(definition));
    if (totalPoints < minimumTeamPoints) {
      return {
        explanation:
          `Scored ${formatValue(totalPoints)}, below the ${formatValue(minimumTeamPoints)} ` +
          `minimum for a meaningful share.`,
        unavailableReason: 'below_minimum_points',
      };
    }
    if (totalPoints <= 0) {
      return {
        explanation: 'No positive team points to compute a share from.',
        unavailableReason: 'no_team_points',
      };
    }

    const statPoints = units * pointsPerUnit;
    const share = roundValue((statPoints / totalPoints) * 100, definition.decimalsCount);

    return {
      value: share,
      explanation:
        `${formatValue(units)} ${statLabel} worth ${formatValue(statPoints)} of ` +
        `${formatValue(totalPoints)} points (${formatValue(share)}%).`,
    };
  },
};

export function calculatorFor(type: Calculation['type']): Calculator {
  return CALCULATORS[type];
}

/** Exported for the test that asserts every calculation type has a calculator. */
export const CALCULATOR_TYPES = Object.keys(CALCULATORS) as Array<Calculation['type']>;

export { isStarter };
