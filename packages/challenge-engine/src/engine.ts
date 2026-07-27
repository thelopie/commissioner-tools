import {
  AppError,
  type ChallengeStanding,
  type InternalId,
  type TieBreaker,
  type WeeklyChallengeDefinition,
  type WeeklyChallengeResult,
  type YahooCapabilityKey,
} from '@dinkel/shared';
import { calculatorFor, type CalculatorResult } from './calculators.js';
import { formatValue, type TeamWeek, type WeekInput } from './inputs.js';

/**
 * The weekly challenge engine.
 *
 * Responsibilities, in order: decide who is eligible, compute each competitor's
 * value, rank them, break ties deterministically, and explain the outcome. It
 * does not fetch, store, or notify — those belong to the API — and it never
 * consults a language model.
 */

export interface CalculationOutcome {
  /** Absent when the challenge could not be calculated at all. */
  winningLeagueMemberIds: InternalId[];
  winningValue?: number;
  /** Ordered board. Transient: displayed and discarded, never persisted. */
  standings: ChallengeStanding[];
  explanation: string;
  wasTied: boolean;
  appliedTieBreaker?: TieBreaker;
  /** Set when nothing could be computed. */
  notCalculableReason?: string;
}

/** Reports why a challenge cannot run, without attempting the math. */
export interface BlockedOutcome {
  blocked: true;
  reason: string;
  missingCapabilities: YahooCapabilityKey[];
}

export type CalculationResult = ({ blocked: false } & CalculationOutcome) | BlockedOutcome;

export interface EngineOptions {
  /**
   * Reports whether a Yahoo capability has been verified against a real league.
   *
   * Injected rather than imported so the engine stays pure and so a test can
   * describe any verification state. In production this reads
   * `yahoo-capabilities.json`.
   */
  isCapabilityVerified: (capability: YahooCapabilityKey) => boolean;
}

/**
 * Calculates a challenge for one week.
 *
 * Refuses to compute when a required Yahoo capability is unverified, or when the
 * definition is not active — returning a blocked outcome rather than a number
 * derived from data nobody has confirmed exists.
 */
export function calculateChallenge(
  definition: WeeklyChallengeDefinition,
  input: WeekInput,
  options: EngineOptions,
): CalculationResult {
  const missingCapabilities = definition.requiredYahooData.filter(
    (capability) => !options.isCapabilityVerified(capability),
  );

  if (missingCapabilities.length > 0) {
    return {
      blocked: true,
      reason:
        `Requires Yahoo data that has not been verified against a real league: ` +
        `${missingCapabilities.join(', ')}.`,
      missingCapabilities,
    };
  }

  if (definition.status === 'blocked') {
    return {
      blocked: true,
      reason: definition.blockedReason ?? 'Challenge is marked blocked.',
      missingCapabilities: [],
    };
  }

  if (definition.status !== 'active') {
    return {
      blocked: true,
      reason: `Challenge status is "${definition.status}", so it is not calculated.`,
      missingCapabilities: [],
    };
  }

  if (definition.weeks.length > 0 && !definition.weeks.includes(input.week)) {
    return {
      blocked: true,
      reason: `Challenge does not run in week ${input.week}.`,
      missingCapabilities: [],
    };
  }

  return { blocked: false, ...rank(definition, input) };
}

function rank(definition: WeeklyChallengeDefinition, input: WeekInput): CalculationOutcome {
  const calculator = calculatorFor(definition.calculation.type);

  const evaluated = input.teams.map((team) => {
    const ineligible = ineligibleReason(team, definition);
    const result: CalculatorResult = ineligible
      ? { explanation: ineligible.explanation, unavailableReason: ineligible.code }
      : calculator(team, definition, { teams: input.teams });

    return { team, result, eligible: !ineligible && result.value !== undefined };
  });

  const ranked = evaluated
    .filter((entry) => entry.eligible && entry.result.value !== undefined)
    .sort((a, b) =>
      definition.objective === 'maximize'
        ? b.result.value! - a.result.value!
        : a.result.value! - b.result.value!,
    );

  if (ranked.length === 0) {
    return {
      winningLeagueMemberIds: [],
      standings: evaluated.map((entry, index) => ({
        leagueMemberId: entry.team.leagueMemberId,
        value: entry.result.value ?? 0,
        explanation: entry.result.explanation,
        rank: index + 1,
        eligible: false,
        ...(entry.result.unavailableReason
          ? { ineligibleReason: entry.result.unavailableReason }
          : {}),
      })),
      explanation: 'No competitor produced a valid value for this challenge.',
      wasTied: false,
      notCalculableReason: 'no_eligible_competitors',
    };
  }

  const bestValue = ranked[0]!.result.value!;
  const leaders = ranked.filter((entry) => entry.result.value === bestValue);

  // Ties share a rank; the next distinct value takes the rank after the group.
  const standings: ChallengeStanding[] = [];
  let currentRank = 0;
  let previousValue: number | undefined;
  ranked.forEach((entry, index) => {
    if (entry.result.value !== previousValue) {
      currentRank = index + 1;
      previousValue = entry.result.value;
    }
    standings.push({
      leagueMemberId: entry.team.leagueMemberId,
      value: entry.result.value!,
      explanation: entry.result.explanation,
      rank: currentRank,
      eligible: true,
    });
  });

  for (const entry of evaluated) {
    if (entry.eligible) continue;
    standings.push({
      leagueMemberId: entry.team.leagueMemberId,
      value: entry.result.value ?? 0,
      explanation: entry.result.explanation,
      rank: ranked.length + 1,
      eligible: false,
      ...(entry.result.unavailableReason
        ? { ineligibleReason: entry.result.unavailableReason }
        : {}),
    });
  }

  if (leaders.length === 1) {
    const winner = leaders[0]!;
    return {
      winningLeagueMemberIds: [winner.team.leagueMemberId],
      winningValue: bestValue,
      standings,
      explanation: winner.result.explanation,
      wasTied: false,
    };
  }

  const resolution = breakTie(
    leaders.map((entry) => entry.team),
    definition,
  );

  return {
    winningLeagueMemberIds: resolution.winners,
    winningValue: bestValue,
    standings,
    explanation:
      `${leaders.length} tied at ${formatValue(bestValue)}. ${resolution.explanation} ` +
      `Winning line: ${leaders[0]!.result.explanation}`,
    wasTied: true,
    ...(resolution.appliedTieBreaker ? { appliedTieBreaker: resolution.appliedTieBreaker } : {}),
  };
}

interface Ineligible {
  code: string;
  explanation: string;
}

function ineligibleReason(
  team: TeamWeek,
  definition: WeeklyChallengeDefinition,
): Ineligible | null {
  const { eligibility } = definition;

  if (
    eligibility.limitedToLeagueMemberIds.length > 0 &&
    !eligibility.limitedToLeagueMemberIds.includes(team.leagueMemberId)
  ) {
    return { code: 'not_in_eligible_list', explanation: 'Not eligible for this challenge.' };
  }

  if (eligibility.requiresDuesPaid && team.duesPaid === false) {
    return { code: 'dues_unpaid', explanation: 'Ineligible: dues unpaid.' };
  }

  if (
    eligibility.maxWinsPerSeason > 0 &&
    (team.priorWinsOfThisChallenge ?? 0) >= eligibility.maxWinsPerSeason
  ) {
    return {
      code: 'season_win_cap_reached',
      explanation:
        `Already won this challenge ${team.priorWinsOfThisChallenge} time(s) this season ` +
        `(cap ${eligibility.maxWinsPerSeason}).`,
    };
  }

  return null;
}

interface TieResolution {
  winners: InternalId[];
  explanation: string;
  appliedTieBreaker?: TieBreaker;
}

/**
 * Applies tiebreakers in order until one separates the leaders.
 *
 * If none does, the winners are left as the full tied group and the caller sees
 * `commissioner_decides` — the engine does not invent a winner, and it does not
 * fall back to something arbitrary like alphabetical order, which would look
 * decisive while being meaningless.
 */
function breakTie(
  leaders: readonly TeamWeek[],
  definition: WeeklyChallengeDefinition,
): TieResolution {
  let remaining = [...leaders];

  for (const tieBreaker of definition.tieBreakers) {
    if (remaining.length === 1) break;

    if (tieBreaker === 'split_prize') {
      return {
        winners: remaining.map((team) => team.leagueMemberId),
        explanation: `Prize split ${remaining.length} ways.`,
        appliedTieBreaker: 'split_prize',
      };
    }

    if (tieBreaker === 'commissioner_decides') {
      return {
        winners: remaining.map((team) => team.leagueMemberId),
        explanation: 'Unresolved by tiebreakers — commissioner decides.',
        appliedTieBreaker: 'commissioner_decides',
      };
    }

    const narrowed = applyTieBreaker(remaining, tieBreaker);
    if (narrowed.length > 0 && narrowed.length < remaining.length) {
      remaining = narrowed;
      if (remaining.length === 1) {
        return {
          winners: [remaining[0]!.leagueMemberId],
          explanation: `Tie broken by ${describeTieBreaker(tieBreaker)}.`,
          appliedTieBreaker: tieBreaker,
        };
      }
    }
  }

  if (remaining.length === 1) {
    return { winners: [remaining[0]!.leagueMemberId], explanation: 'Tie resolved.' };
  }

  return {
    winners: remaining.map((team) => team.leagueMemberId),
    explanation: 'Tiebreakers did not separate the leaders — commissioner decides.',
    appliedTieBreaker: 'commissioner_decides',
  };
}

function applyTieBreaker(teams: readonly TeamWeek[], tieBreaker: TieBreaker): TeamWeek[] {
  const score = (team: TeamWeek): number | undefined => {
    switch (tieBreaker) {
      case 'worse_record':
        // Fewer wins is "better" for this tiebreaker, so negate.
        return team.priorWins === undefined ? undefined : -team.priorWins;
      case 'higher_team_points':
        return team.teamPoints;
      case 'lower_team_points':
        return team.teamPoints === undefined ? undefined : -team.teamPoints;
      case 'fewer_prior_wins_this_season':
        return -(team.priorWinsOfThisChallenge ?? 0);
      default:
        return undefined;
    }
  };

  const scored = teams
    .map((team) => ({ team, value: score(team) }))
    .filter((entry): entry is { team: TeamWeek; value: number } => entry.value !== undefined);

  if (scored.length === 0) return [];

  const best = Math.max(...scored.map((entry) => entry.value));
  return scored.filter((entry) => entry.value === best).map((entry) => entry.team);
}

function describeTieBreaker(tieBreaker: TieBreaker): string {
  switch (tieBreaker) {
    case 'worse_record':
      return 'worse season record';
    case 'higher_team_points':
      return 'higher team score';
    case 'lower_team_points':
      return 'lower team score';
    case 'fewer_prior_wins_this_season':
      return 'fewer prior wins of this challenge';
    case 'split_prize':
      return 'splitting the prize';
    case 'commissioner_decides':
      return 'commissioner decision';
  }
}

// --------------------------------------------------------------------------
// Recalculation and finalization
// --------------------------------------------------------------------------

export interface RecalculationDecision {
  /** Whether the stored result should be updated. */
  shouldUpdate: boolean;
  /** True when the winner or value actually changed. */
  changed: boolean;
  /**
   * True when the change was refused because money already moved. The
   * commissioner must decide explicitly; nothing is rewritten silently.
   */
  blockedBySettledPayout: boolean;
  summary: string;
}

/**
 * Decides what to do when a recalculation produces a different answer.
 *
 * Yahoo issues stat corrections days after games, which can genuinely change a
 * winner. Three cases:
 *
 *  - Nothing changed: leave the record alone.
 *  - Changed while provisional: update it, that is the point of provisional.
 *  - Changed after a payout settled: refuse and surface a conflict. Quietly
 *    rewriting a paid result would leave the portal claiming someone won money
 *    they never received.
 */
export function decideRecalculation(
  existing: Pick<
    WeeklyChallengeResult,
    'status' | 'winningLeagueMemberIds' | 'winningValue' | 'payoutSettled'
  >,
  next: CalculationOutcome,
): RecalculationDecision {
  const sameWinners =
    existing.winningLeagueMemberIds.length === next.winningLeagueMemberIds.length &&
    existing.winningLeagueMemberIds.every((id) => next.winningLeagueMemberIds.includes(id));
  const sameValue = existing.winningValue === next.winningValue;

  if (sameWinners && sameValue) {
    return {
      shouldUpdate: false,
      changed: false,
      blockedBySettledPayout: false,
      summary: 'Recalculation produced the same winner and value.',
    };
  }

  if (existing.payoutSettled) {
    return {
      shouldUpdate: false,
      changed: true,
      blockedBySettledPayout: true,
      summary:
        'Recalculation changed the outcome, but the payout has already settled. ' +
        'A commissioner override is required to change a paid result.',
    };
  }

  if (existing.status === 'overridden') {
    return {
      shouldUpdate: false,
      changed: true,
      blockedBySettledPayout: false,
      summary:
        'Recalculation differs from the stored result, which a commissioner overrode. ' +
        'The override stands until a commissioner changes it.',
    };
  }

  return {
    shouldUpdate: true,
    changed: true,
    blockedBySettledPayout: false,
    summary: 'Recalculation changed the outcome; the provisional result was updated.',
  };
}

/**
 * Validates a finalization request.
 *
 * @throws {AppError} when the result cannot be finalized as asked.
 */
export function assertCanFinalize(
  result: Pick<WeeklyChallengeResult, 'status' | 'winningLeagueMemberIds'>,
): void {
  if (result.status === 'finalized') {
    throw new AppError('challenge_already_finalized', {
      publicMessage: 'This challenge result is already finalized.',
    });
  }

  if (result.status === 'not_calculable') {
    throw new AppError('challenge_blocked', {
      publicMessage: 'This result could not be calculated, so there is nothing to finalize.',
    });
  }

  if (result.winningLeagueMemberIds.length === 0) {
    throw new AppError('precondition_failed', {
      publicMessage:
        'There is no winner to finalize. Resolve the tie or override the result first.',
    });
  }

  if (result.winningLeagueMemberIds.length > 1) {
    throw new AppError('precondition_failed', {
      publicMessage:
        'This result is still tied. Split the prize or override with a single winner before finalizing.',
    });
  }
}

/**
 * Validates an override request.
 *
 * @throws {AppError} `override_reason_required` when no reason is given, or
 *   `forbidden` when the definition disallows overrides.
 */
export function assertCanOverride(
  definition: Pick<WeeklyChallengeDefinition, 'overridePolicy'>,
  result: Pick<WeeklyChallengeResult, 'status'>,
  reason: string,
): void {
  if (reason.trim().length === 0) {
    throw new AppError('override_reason_required', {
      publicMessage: 'An override needs a recorded reason.',
    });
  }

  if (definition.overridePolicy === 'never') {
    throw new AppError('forbidden', {
      publicMessage: 'This challenge does not permit overrides.',
    });
  }

  if (definition.overridePolicy === 'before_finalization' && result.status === 'finalized') {
    throw new AppError('challenge_already_finalized', {
      publicMessage:
        'This challenge only allows overrides before finalization, and it is already finalized.',
    });
  }
}
