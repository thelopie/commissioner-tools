import { AppError, type DraftOrderTieBreaker, type InternalId } from '@dinkel/shared';
import { createSeededRandom } from './random.js';

/**
 * Selection order and draft-slot selection.
 *
 * Two distinct ordered things, deliberately kept apart:
 *
 *   selection order — the sequence in which managers CHOOSE, derived from how far
 *                     their LLWS team advanced (better finish chooses earlier)
 *   draft position  — the fantasy draft slot a manager actually picks when their
 *                     turn opens
 *
 * Conflating them is the obvious bug: the manager whose team won the LLWS gets to
 * pick first, not necessarily to draft first — they might want slot 6.
 *
 * Nothing here writes to Yahoo. No documented Yahoo endpoint sets draft order (see
 * `yahoo-capabilities.json`), so the workflow ends in a printable order the
 * commissioner enters by hand.
 */

export interface SelectionOrderEntry {
  leagueMemberId: InternalId;
  llwsTeamId?: InternalId;
  /** LLWS finish, lower is better. Undefined when the team's run is unresolved. */
  llwsFinishRank?: number;
  /** Prior season's finish, lower is better. Dinkel-owned; used for tiebreaks. */
  priorSeasonFinish?: number;
}

export interface ComputedSelectionOrder {
  /** 1-based, in the order managers choose. */
  order: Array<{
    selectionOrder: number;
    leagueMemberId: InternalId;
    llwsTeamId?: InternalId;
    llwsFinishRank?: number;
    appliedTieBreaker?: DraftOrderTieBreaker;
    explanation: string;
  }>;
  /** Managers who could not be placed, e.g. no recorded LLWS finish. */
  unplaced: Array<{ leagueMemberId: InternalId; reason: string }>;
}

/**
 * Computes selection order from LLWS finishes.
 *
 * @param tieBreakers - Applied in sequence when two teams finished level.
 * @param seed - Required only if `seeded_random` appears in the tiebreakers;
 *   recorded so a coin-flip tiebreak is as auditable as the original draw.
 */
export function computeSelectionOrder(
  entries: readonly SelectionOrderEntry[],
  tieBreakers: readonly DraftOrderTieBreaker[],
  seed?: string,
): ComputedSelectionOrder {
  const placeable = entries.filter((entry) => entry.llwsFinishRank !== undefined);
  const unplaced = entries
    .filter((entry) => entry.llwsFinishRank === undefined)
    .map((entry) => ({
      leagueMemberId: entry.leagueMemberId,
      reason: entry.llwsTeamId
        ? 'No LLWS finish recorded for the assigned team yet.'
        : 'No LLWS team assigned.',
    }));

  if (tieBreakers.includes('seeded_random') && !seed) {
    throw new AppError('validation_failed', {
      publicMessage:
        'A seed is required when seeded_random is used as a tiebreaker, so the coin flip is auditable.',
    });
  }

  const random = seed ? createSeededRandom(`selection-order:${seed}`) : null;

  // Group by finish so ties are visible rather than resolved by array order.
  const byFinish = new Map<number, SelectionOrderEntry[]>();
  for (const entry of placeable) {
    const rank = entry.llwsFinishRank!;
    const group = byFinish.get(rank) ?? [];
    group.push(entry);
    byFinish.set(rank, group);
  }

  const order: ComputedSelectionOrder['order'] = [];
  let position = 1;

  for (const finishRank of [...byFinish.keys()].sort((a, b) => a - b)) {
    const group = byFinish.get(finishRank)!;

    if (group.length === 1) {
      const entry = group[0]!;
      order.push({
        selectionOrder: position,
        leagueMemberId: entry.leagueMemberId,
        ...(entry.llwsTeamId ? { llwsTeamId: entry.llwsTeamId } : {}),
        llwsFinishRank: finishRank,
        explanation: `LLWS finish ${finishRank}.`,
      });
      position += 1;
      continue;
    }

    const { ordered, appliedTieBreaker } = resolveGroup(group, tieBreakers, random);

    for (const entry of ordered) {
      order.push({
        selectionOrder: position,
        leagueMemberId: entry.leagueMemberId,
        ...(entry.llwsTeamId ? { llwsTeamId: entry.llwsTeamId } : {}),
        llwsFinishRank: finishRank,
        ...(appliedTieBreaker ? { appliedTieBreaker } : {}),
        explanation:
          `LLWS finish ${finishRank}, tied with ${group.length - 1} other(s)` +
          (appliedTieBreaker ? `, separated by ${describe(appliedTieBreaker)}.` : '.'),
      });
      position += 1;
    }
  }

  return { order, unplaced };
}

function resolveGroup(
  group: readonly SelectionOrderEntry[],
  tieBreakers: readonly DraftOrderTieBreaker[],
  random: ReturnType<typeof createSeededRandom> | null,
): { ordered: SelectionOrderEntry[]; appliedTieBreaker?: DraftOrderTieBreaker } {
  for (const tieBreaker of tieBreakers) {
    if (tieBreaker === 'commissioner_decides') {
      // Leave the group in input order and report that a human must decide. The
      // caller surfaces this rather than pretending the order is meaningful.
      return { ordered: [...group], appliedTieBreaker: 'commissioner_decides' };
    }

    if (tieBreaker === 'seeded_random' && random) {
      // Assign a stable random key per member so the result depends on the seed
      // and the member, not on iteration order.
      const keyed = group.map((entry) => ({ entry, key: random.next() }));
      keyed.sort((a, b) => a.key - b.key);
      return { ordered: keyed.map((k) => k.entry), appliedTieBreaker: 'seeded_random' };
    }

    if (tieBreaker === 'worse_prior_season_finish' || tieBreaker === 'better_prior_season_finish') {
      const known = group.filter((entry) => entry.priorSeasonFinish !== undefined);
      if (known.length !== group.length) continue; // Cannot apply; try the next.

      const sorted = [...group].sort((a, b) =>
        tieBreaker === 'worse_prior_season_finish'
          ? b.priorSeasonFinish! - a.priorSeasonFinish!
          : a.priorSeasonFinish! - b.priorSeasonFinish!,
      );
      return { ordered: sorted, appliedTieBreaker: tieBreaker };
    }
  }

  return { ordered: [...group] };
}

function describe(tieBreaker: DraftOrderTieBreaker): string {
  switch (tieBreaker) {
    case 'worse_prior_season_finish':
      return 'worse finish last season';
    case 'better_prior_season_finish':
      return 'better finish last season';
    case 'seeded_random':
      return 'a seeded coin flip';
    case 'commissioner_decides':
      return 'commissioner decision';
  }
}

// --------------------------------------------------------------------------
// Turn management
// --------------------------------------------------------------------------

export interface SelectionState {
  leagueMemberId: InternalId;
  selectionOrder: number;
  chosenDraftPosition: number | null;
  status: 'waiting' | 'open' | 'locked' | 'commissioner_assigned' | 'skipped';
}

/**
 * Which draft slots remain.
 *
 * @param totalPositions - Usually the team count.
 */
export function availablePositions(
  selections: readonly SelectionState[],
  totalPositions: number,
): number[] {
  const taken = new Set(
    selections
      .map((selection) => selection.chosenDraftPosition)
      .filter((position): position is number => position !== null),
  );

  return Array.from({ length: totalPositions }, (_, i) => i + 1).filter(
    (position) => !taken.has(position),
  );
}

/**
 * The next turn to open: the lowest selection order that has not resolved.
 *
 * Skipped turns do not block the queue — otherwise one unresponsive manager stalls
 * the whole draft — but they remain visible for the commissioner to resolve.
 */
export function nextTurn(selections: readonly SelectionState[]): SelectionState | null {
  const outstanding = selections
    .filter((selection) => selection.status === 'waiting' || selection.status === 'open')
    .sort((a, b) => a.selectionOrder - b.selectionOrder);

  return outstanding[0] ?? null;
}

/**
 * Validates a manager's pick.
 *
 * @throws {AppError} `draft_turn_not_open` when it is not their turn, or
 *   `draft_position_taken` when the slot is gone. Both are enforced here and
 *   again by a conditional write in DynamoDB, because a race between two
 *   simultaneous picks must not hand the same slot to two managers.
 */
export function assertCanSelect(
  selections: readonly SelectionState[],
  leagueMemberId: InternalId,
  requestedPosition: number,
  totalPositions: number,
): void {
  const own = selections.find((selection) => selection.leagueMemberId === leagueMemberId);

  if (!own) {
    throw new AppError('not_found', {
      publicMessage: 'You do not have a draft selection turn this season.',
    });
  }

  if (own.status === 'locked' || own.status === 'commissioner_assigned') {
    throw new AppError('conflict', {
      publicMessage: `Your draft slot is already locked at ${own.chosenDraftPosition}.`,
    });
  }

  const current = nextTurn(selections);
  if (!current || current.leagueMemberId !== leagueMemberId) {
    throw new AppError('draft_turn_not_open', {
      publicMessage: current
        ? 'It is not your turn to choose yet.'
        : 'Draft slot selection is not open.',
    });
  }

  if (
    !Number.isInteger(requestedPosition) ||
    requestedPosition < 1 ||
    requestedPosition > totalPositions
  ) {
    throw new AppError('validation_failed', {
      publicMessage: `Choose a draft slot between 1 and ${totalPositions}.`,
    });
  }

  if (!availablePositions(selections, totalPositions).includes(requestedPosition)) {
    throw new AppError('draft_position_taken', {
      publicMessage: `Draft slot ${requestedPosition} is already taken.`,
    });
  }
}

/**
 * The final draft order, for manual entry into Yahoo.
 *
 * Returns slots 1..n with whoever chose each. Gaps are reported rather than
 * filled: an incomplete order handed to a commissioner as if it were complete
 * would produce a wrong draft.
 */
export function finalDraftOrder(
  selections: readonly SelectionState[],
  totalPositions: number,
): {
  complete: boolean;
  order: Array<{ draftPosition: number; leagueMemberId: InternalId | null }>;
  missingPositions: number[];
} {
  const byPosition = new Map<number, InternalId>();
  for (const selection of selections) {
    if (selection.chosenDraftPosition !== null) {
      byPosition.set(selection.chosenDraftPosition, selection.leagueMemberId);
    }
  }

  const order = Array.from({ length: totalPositions }, (_, i) => ({
    draftPosition: i + 1,
    leagueMemberId: byPosition.get(i + 1) ?? null,
  }));

  const missingPositions = order
    .filter((entry) => entry.leagueMemberId === null)
    .map((entry) => entry.draftPosition);

  return { complete: missingPositions.length === 0, order, missingPositions };
}
