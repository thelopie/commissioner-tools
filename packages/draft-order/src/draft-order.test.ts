import { describe, expect, it } from 'vitest';
import type { DraftOrderTieBreaker, InternalId } from '@dinkel/shared';
import {
  assertAssignmentsUnique,
  assertCanSelect,
  availablePositions,
  computeSelectionOrder,
  createSeededRandom,
  drawAssignments,
  finalDraftOrder,
  nextTurn,
  shuffle,
  verifyDraw,
  type SelectionState,
} from './index.js';

const id = (value: string): InternalId => value as InternalId;
const members = (count: number): InternalId[] =>
  Array.from({ length: count }, (_, i) => id(`M${i + 1}`));
const teams = (count: number): InternalId[] =>
  Array.from({ length: count }, (_, i) => id(`T${i + 1}`));

describe('seeded randomness', () => {
  it('produces the same sequence for the same seed', () => {
    const first = Array.from({ length: 10 }, () => createSeededRandom('llws-2026:abc').next());
    const second = Array.from({ length: 10 }, () => createSeededRandom('llws-2026:abc').next());
    expect(first).toEqual(second);
  });

  it('produces different sequences for seeds differing by one character', () => {
    // A naive hash would leave near-identical seeds correlated, making the draw
    // look rigged to anyone who checked.
    const a = createSeededRandom('llws-2026:aaa');
    const b = createSeededRandom('llws-2026:aab');
    expect(a.next()).not.toBe(b.next());
  });

  it('stays within [0, 1)', () => {
    const random = createSeededRandom('seed');
    for (let i = 0; i < 1000; i += 1) {
      const value = random.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('shuffles without losing or duplicating items', () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    const shuffled = shuffle(items, createSeededRandom('seed'));

    expect(shuffled).toHaveLength(12);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(items);
  });

  it('actually reorders, rather than returning the input', () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    expect(shuffle(items, createSeededRandom('seed-xyz'))).not.toEqual(items);
  });

  it('distributes first position roughly evenly across seeds', () => {
    // A biased shuffle would systematically favour some managers. Fisher-Yates is
    // used specifically to avoid the sort-based shuffle's measurable bias.
    const counts = new Map<number, number>();
    for (let i = 0; i < 2400; i += 1) {
      const first = shuffle([0, 1, 2, 3], createSeededRandom(`seed-${i}`))[0]!;
      counts.set(first, (counts.get(first) ?? 0) + 1);
    }

    for (const position of [0, 1, 2, 3]) {
      const count = counts.get(position) ?? 0;
      // Expected 600 each; allow generous slack while still catching real bias.
      expect(count).toBeGreaterThan(450);
      expect(count).toBeLessThan(750);
    }
  });
});

describe('drawAssignments', () => {
  it('assigns each manager exactly one team', () => {
    const draw = drawAssignments({
      leagueMemberIds: members(12),
      llwsTeamIds: teams(12),
      seed: 'llws-2026:test',
    });

    expect(draw.assignments).toHaveLength(12);
    expect(new Set(draw.assignments.map((a) => a.leagueMemberId)).size).toBe(12);
    expect(new Set(draw.assignments.map((a) => a.llwsTeamId)).size).toBe(12);
  });

  it('is reproducible from the recorded seed', () => {
    // This is the whole point of recording the seed: the draw can be audited.
    const input = { leagueMemberIds: members(12), llwsTeamIds: teams(12), seed: 'llws-2026:audit' };
    expect(drawAssignments(input).assignments).toEqual(drawAssignments(input).assignments);
  });

  it('produces a different draw for a different seed', () => {
    const a = drawAssignments({ leagueMemberIds: members(12), llwsTeamIds: teams(12), seed: 'a' });
    const b = drawAssignments({ leagueMemberIds: members(12), llwsTeamIds: teams(12), seed: 'b' });
    expect(a.assignments).not.toEqual(b.assignments);
  });

  it('reports leftover teams when the LLWS field is larger than the league', () => {
    // The LLWS field usually is larger, so this is the normal case.
    const draw = drawAssignments({
      leagueMemberIds: members(12),
      llwsTeamIds: teams(20),
      seed: 'seed',
    });

    expect(draw.assignments).toHaveLength(12);
    expect(draw.unassignedLlwsTeamIds).toHaveLength(8);
    expect(draw.unassignedLeagueMemberIds).toHaveLength(0);
  });

  it('reports unassigned managers rather than silently leaving them out', () => {
    const draw = drawAssignments({
      leagueMemberIds: members(12),
      llwsTeamIds: teams(8),
      seed: 'seed',
    });

    expect(draw.assignments).toHaveLength(8);
    expect(draw.unassignedLeagueMemberIds).toHaveLength(4);
  });

  it('does not depend on the order managers were listed in', () => {
    // Shuffling only the teams would make the outcome depend on list order,
    // which is not obviously fair.
    const forward = drawAssignments({
      leagueMemberIds: members(6),
      llwsTeamIds: teams(6),
      seed: 'seed',
    });
    const reversed = drawAssignments({
      leagueMemberIds: [...members(6)].reverse(),
      llwsTeamIds: teams(6),
      seed: 'seed',
    });

    const forwardMap = new Map(forward.assignments.map((a) => [a.leagueMemberId, a.llwsTeamId]));
    const reversedMap = new Map(reversed.assignments.map((a) => [a.leagueMemberId, a.llwsTeamId]));
    expect(forwardMap).not.toEqual(reversedMap);
  });

  it('rejects a duplicate manager or team in the input', () => {
    expect(() =>
      drawAssignments({
        leagueMemberIds: [id('M1'), id('M1')],
        llwsTeamIds: teams(2),
        seed: 'seed',
      }),
    ).toThrow(expect.objectContaining({ code: 'duplicate' }));

    expect(() =>
      drawAssignments({
        leagueMemberIds: members(2),
        llwsTeamIds: [id('T1'), id('T1')],
        seed: 'seed',
      }),
    ).toThrow(expect.objectContaining({ code: 'duplicate' }));
  });

  it('requires a seed, so an unauditable draw is impossible', () => {
    expect(() =>
      drawAssignments({ leagueMemberIds: members(2), llwsTeamIds: teams(2), seed: '  ' }),
    ).toThrow(/audited/);
  });
});

describe('assignment uniqueness', () => {
  it('accepts a valid one-to-one mapping', () => {
    expect(() =>
      assertAssignmentsUnique([
        { leagueMemberId: id('M1'), llwsTeamId: id('T1') },
        { leagueMemberId: id('M2'), llwsTeamId: id('T2') },
      ]),
    ).not.toThrow();
  });

  it('rejects one team held by two managers', () => {
    // Two managers claiming the same LLWS finish silently corrupts draft order.
    expect(() =>
      assertAssignmentsUnique([
        { leagueMemberId: id('M1'), llwsTeamId: id('T1') },
        { leagueMemberId: id('M2'), llwsTeamId: id('T1') },
      ]),
    ).toThrow(expect.objectContaining({ code: 'llws_team_already_assigned' }));
  });

  it('rejects one manager holding two teams', () => {
    expect(() =>
      assertAssignmentsUnique([
        { leagueMemberId: id('M1'), llwsTeamId: id('T1') },
        { leagueMemberId: id('M1'), llwsTeamId: id('T2') },
      ]),
    ).toThrow(expect.objectContaining({ code: 'conflict' }));
  });
});

describe('verifyDraw', () => {
  const input = { leagueMemberIds: members(6), llwsTeamIds: teams(6), seed: 'llws-2026:verify' };

  it('confirms an untouched draw reproduces from its seed', () => {
    const draw = drawAssignments(input);
    expect(verifyDraw(draw.assignments, input).reproduces).toBe(true);
  });

  it('detects an assignment edited after the draw', () => {
    const draw = drawAssignments(input);
    const tampered = draw.assignments.map((assignment, index) =>
      index === 0 ? { ...assignment, llwsTeamId: id('T99') } : assignment,
    );

    const verification = verifyDraw(tampered, input);
    expect(verification.reproduces).toBe(false);
    expect(verification.mismatches).toHaveLength(1);
  });
});

describe('computeSelectionOrder', () => {
  it('orders by LLWS finish, best first', () => {
    const computed = computeSelectionOrder(
      [
        { leagueMemberId: id('M1'), llwsTeamId: id('T1'), llwsFinishRank: 4 },
        { leagueMemberId: id('M2'), llwsTeamId: id('T2'), llwsFinishRank: 1 },
        { leagueMemberId: id('M3'), llwsTeamId: id('T3'), llwsFinishRank: 2 },
      ],
      ['commissioner_decides'],
    );

    expect(computed.order.map((entry) => entry.leagueMemberId)).toEqual([
      id('M2'),
      id('M3'),
      id('M1'),
    ]);
    expect(computed.order.map((entry) => entry.selectionOrder)).toEqual([1, 2, 3]);
  });

  it('reports managers with no recorded finish rather than placing them arbitrarily', () => {
    const computed = computeSelectionOrder(
      [
        { leagueMemberId: id('M1'), llwsTeamId: id('T1'), llwsFinishRank: 1 },
        { leagueMemberId: id('M2'), llwsTeamId: id('T2') },
        { leagueMemberId: id('M3') },
      ],
      ['commissioner_decides'],
    );

    expect(computed.order).toHaveLength(1);
    expect(computed.unplaced).toHaveLength(2);
    expect(computed.unplaced[0]?.reason).toContain('No LLWS finish');
    expect(computed.unplaced[1]?.reason).toContain('No LLWS team');
  });

  it('breaks a finish tie by worse prior-season finish', () => {
    const computed = computeSelectionOrder(
      [
        { leagueMemberId: id('M1'), llwsFinishRank: 3, priorSeasonFinish: 2 },
        { leagueMemberId: id('M2'), llwsFinishRank: 3, priorSeasonFinish: 11 },
      ],
      ['worse_prior_season_finish'],
    );

    // Finished 11th last year, so picks first among the tied pair.
    expect(computed.order[0]?.leagueMemberId).toBe(id('M2'));
    expect(computed.order[0]?.appliedTieBreaker).toBe('worse_prior_season_finish');
  });

  it('falls through to the next tiebreaker when prior finishes are unknown', () => {
    const computed = computeSelectionOrder(
      [
        { leagueMemberId: id('M1'), llwsFinishRank: 3 },
        { leagueMemberId: id('M2'), llwsFinishRank: 3 },
      ],
      ['worse_prior_season_finish', 'seeded_random'],
      'tie-seed',
    );

    expect(computed.order[0]?.appliedTieBreaker).toBe('seeded_random');
  });

  it('resolves a tie reproducibly with a seeded coin flip', () => {
    const entries = [
      { leagueMemberId: id('M1'), llwsFinishRank: 3 },
      { leagueMemberId: id('M2'), llwsFinishRank: 3 },
    ];
    const tieBreakers: DraftOrderTieBreaker[] = ['seeded_random'];

    const first = computeSelectionOrder(entries, tieBreakers, 'coin-1');
    const again = computeSelectionOrder(entries, tieBreakers, 'coin-1');
    expect(first.order).toEqual(again.order);
  });

  it('requires a seed when a seeded coin flip is configured', () => {
    expect(() =>
      computeSelectionOrder([{ leagueMemberId: id('M1'), llwsFinishRank: 1 }], ['seeded_random']),
    ).toThrow(/auditable/);
  });

  it('flags a tie left to the commissioner instead of pretending it is ordered', () => {
    const computed = computeSelectionOrder(
      [
        { leagueMemberId: id('M1'), llwsFinishRank: 3 },
        { leagueMemberId: id('M2'), llwsFinishRank: 3 },
      ],
      ['commissioner_decides'],
    );

    expect(
      computed.order.every((entry) => entry.appliedTieBreaker === 'commissioner_decides'),
    ).toBe(true);
    expect(computed.order[0]?.explanation).toContain('tied with');
  });

  it('explains how each place was earned', () => {
    const computed = computeSelectionOrder(
      [{ leagueMemberId: id('M1'), llwsFinishRank: 2 }],
      ['commissioner_decides'],
    );
    expect(computed.order[0]?.explanation).toBe('LLWS finish 2.');
  });
});

describe('draft slot selection', () => {
  const selections = (overrides: Partial<SelectionState>[] = []): SelectionState[] =>
    [
      { leagueMemberId: id('M1'), selectionOrder: 1, chosenDraftPosition: null, status: 'open' },
      { leagueMemberId: id('M2'), selectionOrder: 2, chosenDraftPosition: null, status: 'waiting' },
      { leagueMemberId: id('M3'), selectionOrder: 3, chosenDraftPosition: null, status: 'waiting' },
    ].map((base, index) => ({ ...base, ...overrides[index] }) as SelectionState);

  it('lists remaining slots', () => {
    const state = selections([{ chosenDraftPosition: 3, status: 'locked' }]);
    expect(availablePositions(state, 3)).toEqual([1, 2]);
  });

  it('identifies whose turn is next by selection order', () => {
    const state = selections([{ status: 'locked', chosenDraftPosition: 2 }]);
    expect(nextTurn(state)?.leagueMemberId).toBe(id('M2'));
  });

  it('does not let one unresponsive manager stall the queue', () => {
    const state = selections([{ status: 'skipped' }]);
    // A skipped turn stays visible for the commissioner but does not block.
    expect(nextTurn(state)?.leagueMemberId).toBe(id('M2'));
  });

  it('returns null when every turn is resolved', () => {
    const state = selections([
      { status: 'locked', chosenDraftPosition: 1 },
      { status: 'locked', chosenDraftPosition: 2 },
      { status: 'commissioner_assigned', chosenDraftPosition: 3 },
    ]);
    expect(nextTurn(state)).toBeNull();
  });

  it('accepts a pick from the manager whose turn is open', () => {
    expect(() => assertCanSelect(selections(), id('M1'), 4, 12)).not.toThrow();
  });

  it('rejects a pick from someone whose turn has not come', () => {
    expect(() => assertCanSelect(selections(), id('M2'), 4, 12)).toThrow(
      expect.objectContaining({ code: 'draft_turn_not_open' }),
    );
  });

  it('rejects a slot already taken', () => {
    const withTaken: SelectionState[] = [
      { leagueMemberId: id('M1'), selectionOrder: 1, chosenDraftPosition: null, status: 'open' },
      { leagueMemberId: id('M2'), selectionOrder: 2, chosenDraftPosition: 4, status: 'locked' },
    ];

    expect(() => assertCanSelect(withTaken, id('M1'), 4, 12)).toThrow(
      expect.objectContaining({ code: 'draft_position_taken' }),
    );
  });

  it('rejects a slot outside the range', () => {
    for (const position of [0, 13, 1.5]) {
      expect(() => assertCanSelect(selections(), id('M1'), position, 12)).toThrow(
        expect.objectContaining({ code: 'validation_failed' }),
      );
    }
  });

  it('rejects a second pick from a manager already locked', () => {
    const state: SelectionState[] = [
      { leagueMemberId: id('M1'), selectionOrder: 1, chosenDraftPosition: 6, status: 'locked' },
    ];
    expect(() => assertCanSelect(state, id('M1'), 7, 12)).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
  });

  it('rejects a pick from someone with no turn at all', () => {
    expect(() => assertCanSelect(selections(), id('STRANGER'), 1, 12)).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });
});

describe('finalDraftOrder', () => {
  it('produces slots 1..n with who chose each', () => {
    const result = finalDraftOrder(
      [
        { leagueMemberId: id('M1'), selectionOrder: 1, chosenDraftPosition: 3, status: 'locked' },
        { leagueMemberId: id('M2'), selectionOrder: 2, chosenDraftPosition: 1, status: 'locked' },
        { leagueMemberId: id('M3'), selectionOrder: 3, chosenDraftPosition: 2, status: 'locked' },
      ],
      3,
    );

    expect(result.complete).toBe(true);
    expect(result.order).toEqual([
      { draftPosition: 1, leagueMemberId: id('M2') },
      { draftPosition: 2, leagueMemberId: id('M3') },
      { draftPosition: 3, leagueMemberId: id('M1') },
    ]);
  });

  it('separates choosing first from drafting first', () => {
    // The manager who chose first took slot 3, so they do not draft first.
    const result = finalDraftOrder(
      [{ leagueMemberId: id('M1'), selectionOrder: 1, chosenDraftPosition: 3, status: 'locked' }],
      3,
    );
    expect(result.order[2]?.leagueMemberId).toBe(id('M1'));
    expect(result.order[0]?.leagueMemberId).toBeNull();
  });

  it('reports gaps rather than presenting an incomplete order as final', () => {
    // Handing a commissioner a partial order as if complete produces a wrong draft.
    const result = finalDraftOrder(
      [{ leagueMemberId: id('M1'), selectionOrder: 1, chosenDraftPosition: 2, status: 'locked' }],
      3,
    );

    expect(result.complete).toBe(false);
    expect(result.missingPositions).toEqual([1, 3]);
  });
});
