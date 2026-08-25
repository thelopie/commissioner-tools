import { describe, expect, it } from 'vitest';
import { currentStandings, nextEliminationRank } from './standing.js';

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

describe('nextEliminationRank', () => {
  it('fills ranks from the bottom, which is the order the news arrives in', () => {
    expect(nextEliminationRank(20, 0)).toBe(20);
    expect(nextEliminationRank(20, 1)).toBe(19);
    expect(nextEliminationRank(20, 19)).toBe(1);
  });

  it('refuses once the field is exhausted', () => {
    expect(() => nextEliminationRank(20, 20)).toThrow();
  });
});
