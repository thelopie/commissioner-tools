import { describe, expect, it } from 'vitest';
import { CHALLENGE_PROPOSALS, proposalToDefinition } from './proposals.js';

describe('the weekly schedule', () => {
  it('runs one challenge a week, weeks 1 to 13, with no gaps or repeats', () => {
    /*
      The league's own calendar, so it belongs in the rule rather than being set per
      season. A duplicate would mean two challenges in one week and a gap would mean
      a week with none, and either is far easier to catch here than in September.
    */
    const weeks = CHALLENGE_PROPOSALS.map((proposal) => proposal.week).sort((a, b) => a - b);

    expect(weeks).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it('puts each challenge in the week the league runs it', () => {
    const bySlug = new Map(CHALLENGE_PROPOSALS.map((p) => [p.slug, p.week]));

    expect(bySlug.get('one-man-army')).toBe(1);
    expect(bySlug.get('bad-beat')).toBe(5);
    expect(bySlug.get('air-raid')).toBe(7);
    expect(bySlug.get('blackjack')).toBe(12);
    expect(bySlug.get('touchdown-dependency')).toBe(13);
  });

  it('carries the week onto the seeded definition, so the calendar is laid out', () => {
    const definition = proposalToDefinition(
      CHALLENGE_PROPOSALS.find((p) => p.slug === 'bench-mob')!,
      { isCapabilityVerified: () => true },
    );

    expect(definition.weeks).toEqual([3]);
  });
});
