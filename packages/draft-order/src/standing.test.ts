import { describe, expect, it } from 'vitest';
import { currentStandings, eliminationRankForGroup } from './standing.js';

const alive = (id: string) => ({ leagueMemberId: id });
const out = (id: string, finishRank: number) => ({ leagueMemberId: id, finishRank });

describe('currentStandings', () => {
  it('gives every team a full range before anybody is out', () => {
    const standings = currentStandings([alive('a'), alive('b'), alive('c')]);

    expect(standings).toHaveLength(3);
    for (const standing of standings) {
      expect(standing).toMatchObject({ locked: false, best: 1, worst: 3 });
    }
  });

  it('locks an eliminated team immediately, because everyone still playing beats it', () => {
    /*
      The fact the whole thing rests on. With two still playing, a team going out
      now is third and cannot move, whatever happens next.
    */
    const standings = currentStandings([alive('a'), alive('b'), out('c', 3)]);

    expect(standings.find((s) => s.leagueMemberId === 'c')).toMatchObject({
      locked: true,
      best: 3,
      worst: 3,
    });
  });

  it('narrows the range for those still playing as others go out', () => {
    const standings = currentStandings([alive('a'), alive('b'), out('c', 3), out('d', 4)]);

    expect(standings.find((s) => s.leagueMemberId === 'a')).toMatchObject({
      locked: false,
      best: 1,
      worst: 2,
    });
  });

  it('locks the last team standing at first', () => {
    const standings = currentStandings([alive('a'), out('b', 2), out('c', 3)]);

    expect(standings.find((s) => s.leagueMemberId === 'a')).toMatchObject({
      locked: true,
      best: 1,
      worst: 1,
    });
  });

  it('orders eliminated teams among themselves by how far they got', () => {
    const standings = currentStandings([
      alive('winner'),
      out('secondOut', 2),
      out('thirdOut', 3),
      out('firstOut', 4),
    ]);

    expect(standings.find((s) => s.leagueMemberId === 'secondOut')?.best).toBe(2);
    expect(standings.find((s) => s.leagueMemberId === 'thirdOut')?.best).toBe(3);
    expect(standings.find((s) => s.leagueMemberId === 'firstOut')?.best).toBe(4);
  });

  it('counts positions among managers only, not the whole LLWS field', () => {
    // Eight of the twenty teams went undrawn and take no part in the draft order,
    // so a manager can never be told they are sixteenth of twelve.
    const standings = currentStandings([alive('a'), out('b', 19), out('c', 20)]);

    expect(standings.find((s) => s.leagueMemberId === 'b')?.best).toBe(2);
    expect(standings.find((s) => s.leagueMemberId === 'c')?.best).toBe(3);
  });

  it('handles a finished tournament', () => {
    const standings = currentStandings([out('a', 1), out('b', 2), out('c', 3)]);

    expect(standings.every((s) => s.locked)).toBe(true);
    expect(standings.map((s) => s.best).sort()).toEqual([1, 2, 3]);
  });

  it('refuses a duplicate manager rather than producing nonsense positions', () => {
    expect(() => currentStandings([alive('a'), alive('a')])).toThrow();
  });

  it('is empty for an empty field', () => {
    expect(currentStandings([])).toEqual([]);
  });
});

describe('eliminationRankForGroup', () => {
  it('fills ranks from the bottom, which is the order the news arrives in', () => {
    expect(eliminationRankForGroup(20, 0, 1)).toBe(20);
    expect(eliminationRankForGroup(20, 1, 1)).toBe(19);
    expect(eliminationRankForGroup(20, 19, 1)).toBe(1);
  });

  it('gives a whole round the same rank, not a made-up order within it', () => {
    /*
      Five teams out of twenty in one round are jointly sixteenth. Handing them
      16, 17, 18, 19 and 20 would invent an order here and let it decide five
      managers' draft slots.
    */
    expect(eliminationRankForGroup(20, 0, 5)).toBe(16);
    expect(eliminationRankForGroup(20, 5, 3)).toBe(13);
  });

  it('refuses more teams than are left', () => {
    expect(() => eliminationRankForGroup(20, 19, 2)).toThrow();
    expect(() => eliminationRankForGroup(20, 20, 1)).toThrow();
  });

  it('refuses an empty group', () => {
    expect(() => eliminationRankForGroup(20, 0, 0)).toThrow();
  });
});

describe('currentStandings with tied eliminations', () => {
  it('gives teams knocked out together a shared band, not an invented order', () => {
    // Three out together sit jointly 2nd-4th; the tiebreakers settle the rest.
    const standings = currentStandings([
      alive('winner'),
      out('a', 17),
      out('b', 17),
      out('c', 17),
    ]);

    for (const id of ['a', 'b', 'c']) {
      expect(standings.find((s) => s.leagueMemberId === id)).toMatchObject({
        locked: false,
        best: 2,
        worst: 4,
        pending: 'tied',
      });
    }
  });

  it('distinguishes a range that will narrow from one that will not', () => {
    /*
      Two very different things. A team still playing moves as others go out; a tied
      team never will, and its place is decided by prior-season finish and the seed.
    */
    const standings = currentStandings([alive('a'), alive('b'), out('c', 19), out('d', 19)]);

    expect(standings.find((s) => s.leagueMemberId === 'a')?.pending).toBe('playing');
    expect(standings.find((s) => s.leagueMemberId === 'c')?.pending).toBe('tied');
  });

  it('stacks bands in finish order', () => {
    const standings = currentStandings([
      out('best', 1),
      out('midA', 5),
      out('midB', 5),
      out('worst', 9),
    ]);

    expect(standings.find((s) => s.leagueMemberId === 'best')).toMatchObject({ best: 1, worst: 1 });
    expect(standings.find((s) => s.leagueMemberId === 'midA')).toMatchObject({ best: 2, worst: 3 });
    expect(standings.find((s) => s.leagueMemberId === 'worst')).toMatchObject({ best: 4, worst: 4 });
  });
});
