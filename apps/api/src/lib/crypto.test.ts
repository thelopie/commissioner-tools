import { describe, expect, it } from 'vitest';
import {
  decryptToken,
  DecryptionError,
  encryptToken,
  generateCsrfToken,
  generateRandomizationSeed,
  generateSessionId,
  safeCompare,
  sha256Hex,
} from './crypto.js';

const KEY = Buffer.alloc(32, 3).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');

describe('token encryption', () => {
  it('round-trips a Yahoo refresh token', () => {
    const token = 'AKcTuMockRefreshTokenValue0123456789';
    expect(decryptToken(encryptToken(token, KEY), KEY)).toBe(token);
  });

  it('produces different ciphertext each time, so equal tokens are not linkable', () => {
    const first = encryptToken('same-token', KEY);
    const second = encryptToken('same-token', KEY);

    expect(first).not.toBe(second);
    expect(decryptToken(first, KEY)).toBe(decryptToken(second, KEY));
  });

  it('never contains the plaintext', () => {
    const envelope = encryptToken('recognizable-secret-value', KEY);
    expect(envelope).not.toContain('recognizable-secret-value');
  });

  it('is self-describing and versioned, so a future key change stays decryptable', () => {
    const parts = encryptToken('x', KEY).split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
  });

  it('rejects a wrong key rather than returning garbage', () => {
    const envelope = encryptToken('secret', KEY);
    expect(() => decryptToken(envelope, OTHER_KEY)).toThrow(DecryptionError);
  });

  it('detects tampering, because GCM authenticates the ciphertext', () => {
    const envelope = encryptToken('transfer commissioner to me', KEY);
    const parts = envelope.split('.');
    const ciphertext = Buffer.from(parts[3]!, 'base64url');
    ciphertext[0] ^= 0xff;
    const tampered = [parts[0], parts[1], parts[2], ciphertext.toString('base64url')].join('.');

    expect(() => decryptToken(tampered, KEY)).toThrow(DecryptionError);
  });

  it('detects a swapped authentication tag', () => {
    const a = encryptToken('token-a', KEY).split('.');
    const b = encryptToken('token-b', KEY).split('.');
    const mixed = [a[0], a[1], b[2], a[3]].join('.');

    expect(() => decryptToken(mixed, KEY)).toThrow(DecryptionError);
  });

  it('rejects a malformed envelope', () => {
    for (const bad of ['', 'garbage', 'v1.only.three', 'v2.a.b.c']) {
      expect(() => decryptToken(bad, KEY)).toThrow(DecryptionError);
    }
  });

  it('rejects a key of the wrong length, with guidance on generating one', () => {
    const shortKey = Buffer.alloc(16, 1).toString('base64');
    expect(() => encryptToken('x', shortKey)).toThrow(/32 bytes/);
    expect(() => encryptToken('x', shortKey)).toThrow(/randomBytes/);
  });

  it('never puts key material or ciphertext in an error message', () => {
    // These messages are logged; a leak here defeats the encryption.
    const envelope = encryptToken('secret', KEY);
    try {
      decryptToken(envelope, OTHER_KEY);
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(OTHER_KEY);
      expect(message).not.toContain(KEY);
      expect(message).not.toContain(envelope.split('.')[3]);
    }
  });

  it('handles an empty string and unicode', () => {
    expect(decryptToken(encryptToken('', KEY), KEY)).toBe('');
    expect(decryptToken(encryptToken('náme — ünïcode 🏈', KEY), KEY)).toBe('náme — ünïcode 🏈');
  });
});

describe('identifier generation', () => {
  it('generates long, URL-safe, non-repeating session ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateSessionId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('generates distinct CSRF tokens', () => {
    expect(generateCsrfToken()).not.toBe(generateCsrfToken());
  });

  it('generates a labelled, unique randomization seed', () => {
    // The label makes a recorded seed self-documenting when audited years later.
    const first = generateRandomizationSeed('llws-2026');
    const second = generateRandomizationSeed('llws-2026');

    expect(first).toMatch(/^llws-2026:[0-9a-f]{32}$/);
    expect(first).not.toBe(second);
  });
});

describe('sha256Hex', () => {
  it('is stable and 64 hex characters', () => {
    const digest = sha256Hex('invite-token');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex('invite-token')).toBe(digest);
  });

  it('differs for different input', () => {
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
  });

  it('accepts a buffer, for CSV file fingerprints', () => {
    expect(sha256Hex(Buffer.from('col-a,col-b\n1,2\n'))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('safeCompare', () => {
  it('matches identical values', () => {
    expect(safeCompare('csrf-token-value', 'csrf-token-value')).toBe(true);
  });

  it('rejects different values and differing lengths without throwing', () => {
    expect(safeCompare('csrf-token-value', 'csrf-token-valuf')).toBe(false);
    expect(safeCompare('short', 'much-longer-value')).toBe(false);
    expect(safeCompare('', 'x')).toBe(false);
    expect(safeCompare('', '')).toBe(true);
  });
});
