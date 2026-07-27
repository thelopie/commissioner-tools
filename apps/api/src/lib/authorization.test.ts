import { describe, expect, it } from 'vitest';
import type { PortalRole } from '@dinkel/shared';
import {
  requireAuthenticated,
  requireCommissioner,
  requireLeague,
  requirePrimaryCommissioner,
  requireRole,
  requireSelfOrCommissioner,
  type Principal,
} from './authorization.js';
import {
  assertCsrf,
  buildClearCookies,
  buildCsrfCookie,
  buildSessionCookie,
  CSRF_COOKIE,
  parseCookies,
  SESSION_COOKIE,
} from './cookies.js';

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  userId: 'U1',
  role: 'manager',
  isPrimaryCommissioner: false,
  leagueId: 'L1',
  sessionId: 'S1',
  ...overrides,
});

describe('requireAuthenticated', () => {
  it('accepts a resolved principal', () => {
    const user = principal();
    expect(requireAuthenticated(user)).toBe(user);
  });

  it('rejects an absent principal', () => {
    expect(() => requireAuthenticated(null)).toThrow(
      expect.objectContaining({ code: 'unauthenticated', status: 401 }),
    );
  });
});

describe('requireRole', () => {
  const cases: Array<{ actual: PortalRole; required: PortalRole; allowed: boolean }> = [
    { actual: 'commissioner', required: 'commissioner', allowed: true },
    { actual: 'commissioner', required: 'manager', allowed: true },
    { actual: 'commissioner', required: 'readonly', allowed: true },
    { actual: 'manager', required: 'commissioner', allowed: false },
    { actual: 'manager', required: 'manager', allowed: true },
    { actual: 'manager', required: 'readonly', allowed: true },
    { actual: 'readonly', required: 'commissioner', allowed: false },
    { actual: 'readonly', required: 'manager', allowed: false },
    { actual: 'readonly', required: 'readonly', allowed: true },
  ];

  for (const { actual, required, allowed } of cases) {
    it(`${allowed ? 'allows' : 'refuses'} ${actual} where ${required} is required`, () => {
      const user = principal({ role: actual });
      if (allowed) {
        expect(requireRole(user, required)).toBe(user);
      } else {
        expect(() => requireRole(user, required)).toThrow(expect.objectContaining({ status: 403 }));
      }
    });
  }

  it('reports commissioner_required specifically, so the UI can explain it', () => {
    expect(() => requireCommissioner(principal({ role: 'manager' }))).toThrow(
      expect.objectContaining({ code: 'commissioner_required' }),
    );
  });

  it('rejects an unauthenticated request before checking the role', () => {
    expect(() => requireCommissioner(null)).toThrow(
      expect.objectContaining({ code: 'unauthenticated' }),
    );
  });

  it('does not leak the role requirement into the user-facing message', () => {
    try {
      requireCommissioner(principal({ role: 'readonly' }));
      expect.unreachable();
    } catch (error) {
      expect((error as { publicMessage: string }).publicMessage).toBe(
        'This action requires commissioner access.',
      );
    }
  });
});

describe('requirePrimaryCommissioner', () => {
  it('accepts the primary commissioner', () => {
    const user = principal({ role: 'commissioner', isPrimaryCommissioner: true });
    expect(requirePrimaryCommissioner(user)).toBe(user);
  });

  it('refuses a secondary commissioner', () => {
    // Otherwise two commissioners could revoke each other and lock the league out.
    expect(() =>
      requirePrimaryCommissioner(principal({ role: 'commissioner', isPrimaryCommissioner: false })),
    ).toThrow(expect.objectContaining({ code: 'forbidden' }));
  });

  it('refuses a manager who somehow carries the primary flag', () => {
    // Defends against a corrupted record: the role check runs first.
    expect(() =>
      requirePrimaryCommissioner(principal({ role: 'manager', isPrimaryCommissioner: true })),
    ).toThrow(expect.objectContaining({ code: 'commissioner_required' }));
  });
});

describe('requireSelfOrCommissioner', () => {
  it('lets a manager act on their own record', () => {
    expect(requireSelfOrCommissioner(principal({ userId: 'U1' }), 'U1')).toBeTruthy();
  });

  it('stops a manager acting on someone else', () => {
    expect(() => requireSelfOrCommissioner(principal({ userId: 'U1' }), 'U2')).toThrow(
      expect.objectContaining({ code: 'commissioner_required' }),
    );
  });

  it('lets a commissioner act on anyone', () => {
    expect(
      requireSelfOrCommissioner(principal({ userId: 'U1', role: 'commissioner' }), 'U2'),
    ).toBeTruthy();
  });
});

describe('requireLeague', () => {
  it('accepts a matching league', () => {
    expect(requireLeague(principal({ leagueId: 'L1' }), 'L1')).toBeTruthy();
  });

  it('refuses a different league, even for a commissioner', () => {
    // A commissioner of one league is not a commissioner of another.
    expect(() => requireLeague(principal({ leagueId: 'L1', role: 'commissioner' }), 'L2')).toThrow(
      expect.objectContaining({ code: 'forbidden' }),
    );
  });
});

describe('session cookies', () => {
  it('marks the session cookie HttpOnly, Secure, and SameSite=Lax', () => {
    const cookie = buildSessionCookie('session-value', { secure: true, maxAgeSeconds: 3600 });

    expect(cookie).toContain(`${SESSION_COOKIE}=session-value`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    // Lax, not Strict: the OAuth callback is a cross-site top-level navigation
    // back from Yahoo and must carry the session.
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=3600');
  });

  it('omits Secure only when explicitly insecure, for local HTTP', () => {
    expect(buildSessionCookie('v', { secure: false, maxAgeSeconds: 60 })).not.toContain('Secure');
  });

  it('leaves the CSRF cookie readable by script, since the frontend must echo it', () => {
    const cookie = buildCsrfCookie('csrf-value', { secure: true, maxAgeSeconds: 3600 });
    expect(cookie).not.toContain('HttpOnly');
    expect(cookie).toContain('Secure');
  });

  it('clears both cookies on sign-out', () => {
    const cleared = buildClearCookies(true);
    expect(cleared).toHaveLength(2);
    for (const cookie of cleared) expect(cookie).toContain('Max-Age=0');
  });
});

describe('parseCookies', () => {
  it('parses multiple cookies', () => {
    expect(parseCookies('a=1; b=2')).toEqual({ a: '1', b: '2' });
  });

  it('decodes percent-encoded values', () => {
    expect(parseCookies('a=hello%20world')).toEqual({ a: 'hello world' });
  });

  it('handles values containing an equals sign, as base64url padding can', () => {
    expect(parseCookies('token=abc=def')).toEqual({ token: 'abc=def' });
  });

  it('tolerates a malformed cookie rather than locking a user out', () => {
    // A stale cookie from another app on localhost must not fail the request.
    expect(parseCookies('bad=%E0%A4%A; good=1')).toMatchObject({ good: '1' });
  });

  it('returns empty for absent headers', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies('')).toEqual({});
  });
});

describe('assertCsrf', () => {
  it('accepts a matching cookie and header', () => {
    expect(() => assertCsrf(`${CSRF_COOKIE}=token-value`, 'token-value')).not.toThrow();
  });

  it('rejects a mismatch', () => {
    expect(() => assertCsrf(`${CSRF_COOKIE}=token-value`, 'other-value')).toThrow(
      expect.objectContaining({ code: 'forbidden' }),
    );
  });

  it('rejects a missing header, which is the cross-site case', () => {
    // An attacker's page can cause the request but cannot read our cookie to
    // populate the header.
    expect(() => assertCsrf(`${CSRF_COOKIE}=token-value`, null)).toThrow(
      expect.objectContaining({ code: 'forbidden' }),
    );
  });

  it('rejects a missing cookie', () => {
    expect(() => assertCsrf('', 'token-value')).toThrow(
      expect.objectContaining({ code: 'forbidden' }),
    );
  });

  it('gives a recoverable message rather than a technical one', () => {
    try {
      assertCsrf('', null);
      expect.unreachable();
    } catch (error) {
      expect((error as { publicMessage: string }).publicMessage).toMatch(/reload/i);
    }
  });
});
