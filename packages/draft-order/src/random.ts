/**
 * Seeded, reproducible randomness for the LLWS draw.
 *
 * The draw decides draft order, which is the most consequential random event in
 * the league's year. "Trust me, I shuffled it" is not good enough: the seed is
 * recorded with the assignments so any manager can re-run the same draw and
 * confirm nobody's team was quietly swapped afterwards.
 *
 * That requires a deterministic PRNG rather than `Math.random`, which cannot be
 * seeded and therefore cannot be audited.
 */

/**
 * xmur3 string hash, producing a well-distributed 32-bit seed.
 *
 * Necessary because a naive hash of a seed string leaves the PRNG correlated
 * across similar seeds — `llws-2026:aaa` and `llws-2026:aab` would produce
 * suspiciously similar draws.
 */
function xmur3(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }

  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/**
 * mulberry32: small, fast, and good enough for a fantasy football draw.
 *
 * Not cryptographically secure, and it does not need to be — the seed is public
 * by design. What matters is that the same seed always yields the same draw.
 */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SeededRandom {
  /** Next float in [0, 1). */
  next(): number;
  /** Next integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number;
}

export function createSeededRandom(seed: string): SeededRandom {
  const next = mulberry32(xmur3(seed)());
  return {
    next,
    nextInt: (maxExclusive: number) => Math.floor(next() * maxExclusive),
  };
}

/**
 * Fisher-Yates shuffle, returning a new array.
 *
 * Fisher-Yates specifically, not `sort(() => random() - 0.5)`: the sort-based
 * trick produces a measurably biased permutation, which for a draft-order draw
 * means some managers are systematically favoured.
 */
export function shuffle<T>(items: readonly T[], random: SeededRandom): T[] {
  const output = [...items];
  for (let i = output.length - 1; i > 0; i -= 1) {
    const j = random.nextInt(i + 1);
    const a = output[i]!;
    const b = output[j]!;
    output[i] = b;
    output[j] = a;
  }
  return output;
}
