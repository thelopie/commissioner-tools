import { describe, expect, it, vi } from 'vitest';
import { type AppError } from '@dinkel/shared';
import {
  buildAuthorizeUrl,
  createOAuthState,
  exchangeCodeForTokens,
  generateOAuthState,
  needsRefresh,
  refreshAccessToken,
  timingSafeEqualStrings,
  validateOAuthState,
  YAHOO_AUTHORIZE_URL,
  YAHOO_TOKEN_URL,
  type FetchLike,
  type OAuthState,
} from './oauth.js';

const CREDS = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'https://localhost:5173/auth/yahoo/callback',
};

/** Builds a fetch stub returning one canned response. */
function stubFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): { fetchImpl: FetchLike; calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> } {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      headers: { get: (name) => headers[name] ?? null },
    };
  };
  return { fetchImpl, calls };
}

describe('generateOAuthState', () => {
  it('produces a long, URL-safe, unpredictable value', () => {
    const state = generateOAuthState();
    // 32 bytes base64url â€” no padding, no characters needing escaping.
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('does not repeat across calls', () => {
    const values = new Set(Array.from({ length: 200 }, () => generateOAuthState()));
    expect(values.size).toBe(200);
  });

  it('draws from the injected randomness source', () => {
    const randomBytes = vi.fn((size: number) => new Uint8Array(size).fill(1));
    const state = generateOAuthState(randomBytes);
    expect(randomBytes).toHaveBeenCalledWith(32);
    expect(state).toBe(generateOAuthState(() => new Uint8Array(32).fill(1)));
  });
});

describe('createOAuthState', () => {
  it('expires ten minutes out by default', () => {
    const record = createOAuthState({ nowEpochSeconds: 1_000_000 });
    expect(record.expiresAtEpochSeconds).toBe(1_000_000 + 600);
  });

  it('defaults returnTo to the app root', () => {
    expect(createOAuthState().returnTo).toBe('/');
  });
});

describe('validateOAuthState', () => {
  const now = 1_000_000;
  const stored = (overrides: Partial<OAuthState> = {}): OAuthState => ({
    state: 'stored-state-value',
    expiresAtEpochSeconds: now + 300,
    returnTo: '/dashboard',
    ...overrides,
  });

  it('accepts a matching, unexpired, unused state', () => {
    const record = stored();
    expect(validateOAuthState('stored-state-value', record, now)).toBe(record);
  });

  it('rejects a missing state parameter', () => {
    expect(() => validateOAuthState(null, stored(), now)).toThrow(
      expect.objectContaining({ code: 'oauth_state_missing' }),
    );
  });

  it('rejects a state with no stored record', () => {
    expect(() => validateOAuthState('anything', null, now)).toThrow(
      expect.objectContaining({ code: 'oauth_state_invalid' }),
    );
  });

  it('rejects a mismatched state', () => {
    expect(() => validateOAuthState('different-value', stored(), now)).toThrow(
      expect.objectContaining({ code: 'oauth_state_invalid' }),
    );
  });

  it('rejects an expired state', () => {
    const record = stored({ expiresAtEpochSeconds: now - 1 });
    expect(() => validateOAuthState('stored-state-value', record, now)).toThrow(
      expect.objectContaining({ code: 'oauth_state_expired' }),
    );
  });

  it('rejects a replayed state, so a captured callback URL is useless twice', () => {
    const record = stored({ consumedAt: '2026-07-26T00:00:00' });
    expect(() => validateOAuthState('stored-state-value', record, now)).toThrow(
      expect.objectContaining({ code: 'oauth_state_reused' }),
    );
  });

  it('checks reuse before expiry, so a replay is never reported as a timeout', () => {
    const record = stored({ consumedAt: '2026-07-26T00:00:00', expiresAtEpochSeconds: now - 1 });
    expect(() => validateOAuthState('stored-state-value', record, now)).toThrow(
      expect.objectContaining({ code: 'oauth_state_reused' }),
    );
  });

  it('gives every failure a recoverable, non-technical message', () => {
    for (const [received, record] of [
      [null, stored()],
      ['nope', stored()],
      ['stored-state-value', stored({ expiresAtEpochSeconds: now - 1 })],
    ] as const) {
      try {
        validateOAuthState(received, record, now);
        expect.unreachable();
      } catch (error) {
        expect((error as AppError).publicMessage).toMatch(/again/i);
      }
    }
  });
});

describe('timingSafeEqualStrings', () => {
  it('matches identical strings', () => {
    expect(timingSafeEqualStrings('abc123', 'abc123')).toBe(true);
  });

  it('rejects different strings, including different lengths', () => {
    expect(timingSafeEqualStrings('abc123', 'abc124')).toBe(false);
    expect(timingSafeEqualStrings('abc', 'abcdef')).toBe(false);
    expect(timingSafeEqualStrings('', 'a')).toBe(false);
  });
});

describe('buildAuthorizeUrl', () => {
  it('includes the documented required parameters', () => {
    const url = new URL(buildAuthorizeUrl({ ...CREDS, state: 'state-value', scope: 'fspt-r' }));
    expect(`${url.origin}${url.pathname}`).toBe(YAHOO_AUTHORIZE_URL);
    expect(url.searchParams.get('client_id')).toBe(CREDS.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(CREDS.redirectUri);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state-value');
    expect(url.searchParams.get('scope')).toBe('fspt-r');
  });

  it('never puts the client secret in a browser-visible URL', () => {
    const url = buildAuthorizeUrl({ ...CREDS, state: 's' });
    expect(url).not.toContain(CREDS.clientSecret);
  });
});

describe('exchangeCodeForTokens', () => {
  it('authenticates with HTTP Basic and posts the documented grant', async () => {
    const { fetchImpl, calls } = stubFetch(200, {
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
    });

    const tokens = await exchangeCodeForTokens(
      { ...CREDS, code: 'auth-code', nowEpochSeconds: 1000 },
      fetchImpl,
    );

    expect(calls[0]?.url).toBe(YAHOO_TOKEN_URL);
    const expected = Buffer.from(`${CREDS.clientId}:${CREDS.clientSecret}`).toString('base64');
    expect(calls[0]?.init.headers['Authorization']).toBe(`Basic ${expected}`);
    expect(calls[0]?.init.body).toContain('grant_type=authorization_code');
    expect(calls[0]?.init.body).toContain('code=auth-code');

    expect(tokens).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAtEpochSeconds: 4600,
      refreshTokenRotated: false,
    });
  });

  it('fails when Yahoo returns no refresh token, rather than creating a connection that dies in an hour', async () => {
    const { fetchImpl } = stubFetch(200, { access_token: 'access-1', expires_in: 3600 });

    await expect(exchangeCodeForTokens({ ...CREDS, code: 'auth-code' }, fetchImpl)).rejects.toThrow(
      expect.objectContaining({ code: 'oauth_exchange_failed' }),
    );
  });

  it('maps invalid_grant to a reconnect prompt', async () => {
    const { fetchImpl } = stubFetch(400, { error: 'invalid_grant' });

    await expect(exchangeCodeForTokens({ ...CREDS, code: 'stale' }, fetchImpl)).rejects.toThrow(
      expect.objectContaining({ code: 'yahoo_needs_reconnect' }),
    );
  });

  it('maps a 429 to rate limiting', async () => {
    const { fetchImpl } = stubFetch(429, 'slow down');

    await expect(exchangeCodeForTokens({ ...CREDS, code: 'x' }, fetchImpl)).rejects.toThrow(
      expect.objectContaining({ code: 'yahoo_rate_limited' }),
    );
  });

  it('never leaks the client secret or Yahoo error body into the user-facing message', async () => {
    const { fetchImpl } = stubFetch(500, `internal failure for ${CREDS.clientSecret}`);

    try {
      await exchangeCodeForTokens({ ...CREDS, code: 'x' }, fetchImpl);
      expect.unreachable();
    } catch (error) {
      const appError = error as AppError;
      expect(appError.publicMessage).not.toContain(CREDS.clientSecret);
      expect(appError.publicMessage).not.toContain('internal failure');
      expect(JSON.stringify(appError.toResponseBody())).not.toContain(CREDS.clientSecret);
    }
  });

  it('rejects a non-JSON response', async () => {
    const { fetchImpl } = stubFetch(200, '<html>maintenance</html>');

    await expect(exchangeCodeForTokens({ ...CREDS, code: 'x' }, fetchImpl)).rejects.toThrow(
      expect.objectContaining({ code: 'yahoo_unexpected_response' }),
    );
  });

  it('rejects a response missing required fields', async () => {
    const { fetchImpl } = stubFetch(200, { access_token: 'a', refresh_token: 'r' });

    await expect(exchangeCodeForTokens({ ...CREDS, code: 'x' }, fetchImpl)).rejects.toThrow(
      expect.objectContaining({ code: 'yahoo_unexpected_response' }),
    );
  });

  it('surfaces a network failure as Yahoo being unreachable', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('ECONNRESET');
    };

    await expect(exchangeCodeForTokens({ ...CREDS, code: 'x' }, fetchImpl)).rejects.toThrow(
      expect.objectContaining({ code: 'yahoo_unavailable' }),
    );
  });
});

describe('refreshAccessToken', () => {
  it('detects rotation when Yahoo issues a new refresh token', async () => {
    const { fetchImpl, calls } = stubFetch(200, {
      access_token: 'access-2',
      refresh_token: 'refresh-2',
      expires_in: 3600,
    });

    const tokens = await refreshAccessToken(
      { ...CREDS, refreshToken: 'refresh-1', nowEpochSeconds: 5000 },
      fetchImpl,
    );

    expect(calls[0]?.init.body).toContain('grant_type=refresh_token');
    expect(tokens.refreshToken).toBe('refresh-2');
    expect(tokens.refreshTokenRotated).toBe(true);
    expect(tokens.expiresAtEpochSeconds).toBe(8600);
  });

  it('keeps the existing refresh token when Yahoo omits one', async () => {
    // Yahoo documents rotation as optional. Treating an omission as revocation
    // would sign the user out for no reason.
    const { fetchImpl } = stubFetch(200, { access_token: 'access-2', expires_in: 3600 });

    const tokens = await refreshAccessToken({ ...CREDS, refreshToken: 'refresh-1' }, fetchImpl);

    expect(tokens.refreshToken).toBe('refresh-1');
    expect(tokens.refreshTokenRotated).toBe(false);
  });

  it('does not report rotation when Yahoo echoes the same refresh token', async () => {
    const { fetchImpl } = stubFetch(200, {
      access_token: 'access-2',
      refresh_token: 'refresh-1',
      expires_in: 3600,
    });

    const tokens = await refreshAccessToken({ ...CREDS, refreshToken: 'refresh-1' }, fetchImpl);
    expect(tokens.refreshTokenRotated).toBe(false);
  });

  it('asks the user to reconnect when the refresh token is dead', async () => {
    const { fetchImpl } = stubFetch(400, { error: 'invalid_grant' });

    await expect(
      refreshAccessToken({ ...CREDS, refreshToken: 'expired' }, fetchImpl),
    ).rejects.toThrow(expect.objectContaining({ code: 'yahoo_needs_reconnect' }));
  });
});

describe('needsRefresh', () => {
  it('refreshes early, before the token actually expires', () => {
    const now = 1000;
    // Expires in 4 minutes, inside the 5-minute skew: refresh now rather than
    // risk expiry mid-request.
    expect(needsRefresh(now + 240, now)).toBe(true);
    // Expires in 10 minutes: still good.
    expect(needsRefresh(now + 600, now)).toBe(false);
  });

  it('treats an already-expired token as needing refresh', () => {
    expect(needsRefresh(500, 1000)).toBe(true);
  });
});
