import { describe, expect, it } from 'vitest';
import { managerName } from './manager-name.js';

/**
 * The precedence rule, which exists because it was got wrong.
 *
 * These are not tests of a utility function so much as tests of a decision: the
 * name a commissioner set for the board outranks the nickname its owner set for
 * themselves. Everything here is a fabricated stand-in — the real league's names
 * live only in the deployment's database.
 */
describe('managerName', () => {
  const none = (): undefined => undefined;

  it('prefers the name the commissioner set', () => {
    expect(managerName({ userId: 'u1', legacyManagerName: 'K-Mac' }, () => 'Kevin')).toBe('K-Mac');
  });

  it("falls back to the person's own display name when no name was set", () => {
    expect(managerName({ userId: 'u1' }, () => 'Kevin')).toBe('Kevin');
  });

  it('falls back to the display name when the commissioner set only whitespace', () => {
    // A form that submits an empty field should not blank out a manager's name.
    expect(managerName({ userId: 'u1', legacyManagerName: '   ' }, () => 'Kevin')).toBe('Kevin');
  });

  it('handles a member nobody has claimed', () => {
    expect(managerName({ userId: null, legacyManagerName: 'Kevo' }, none)).toBe('Kevo');
    expect(managerName({ userId: null }, none)).toBe('(unnamed manager)');
    expect(managerName({}, none)).toBe('(unnamed manager)');
  });

  it('handles a linked user whose profile has since gone', () => {
    expect(managerName({ userId: 'u-gone' }, none)).toBe('(unnamed manager)');
  });

  /**
   * The case that started it.
   *
   * Two managers whose self-chosen nicknames differ by one letter, and whose
   * commissioner-set names do not. Signing in must not take the distinguishable
   * names away again — that is the whole reason the order was flipped.
   */
  it('keeps two near-identical nicknames apart once names are set', () => {
    const displayNames: Record<string, string> = { a: 'Kevin', b: 'Kevyn' };
    const lookup = (id: string): string | undefined => displayNames[id];

    const first = { userId: 'a', legacyManagerName: 'K-Mac' };
    const second = { userId: 'b', legacyManagerName: 'Kevo' };

    expect(managerName(first, lookup)).toBe('K-Mac');
    expect(managerName(second, lookup)).toBe('Kevo');
    expect(managerName(first, lookup)).not.toBe(managerName(second, lookup));
  });

  it('trims, so a stray space cannot make two names look different', () => {
    expect(managerName({ legacyManagerName: '  Kevo  ' }, none)).toBe('Kevo');
  });
});
