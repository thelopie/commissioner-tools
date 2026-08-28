import { beforeEach, describe, expect, it } from 'vitest';
import { loadServerEnv } from '@lopie/shared';
import { setCapabilityMatrix, type CapabilityMatrix, type FetchLike } from '@lopie/yahoo-client';
import { createApp } from '../app.js';
import type { AppConfig } from '../config.js';
import { InMemoryTable } from '../testing/in-memory-table.js';
import { createLogger } from '../lib/logger.js';
import { handleFantasyRequest, handleTokenRequest } from '../../../mock-yahoo/src/handlers.js';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '../lib/cookies.js';

/**
 * Route-level integration tests.
 *
 * These exercise the real Hono app, the real middleware chain, the real
 * repositories, and the real Yahoo client — against an in-memory table and the
 * mock Yahoo handlers. That covers the parts unit tests cannot: middleware
 * ordering, cookie handling, the OAuth round trip, and backend authorization as
 * an actual HTTP response rather than a thrown error.
 */

const KEY = Buffer.alloc(32, 5).toString('base64');

const MATRIX: CapabilityMatrix = {
  lastReviewedAt: '2026-07-26',
  access: {
    selfService: false,
    approvalRequired: true,
    defaultPermission: 'read-only',
    applicationUrl: 'https://sports.yahoo.com/developer/access/',
  },
  writeOperations: { supported: false },
  commissionerActions: { supported: false },
  retention: { maxRetentionHours: 24, storableIndefinitely: ['yahoo_guid', 'token_value'] },
  resources: [],
  // Empty, matching the shipped state: nothing verified against a real league.
  verifiedCapabilities: [],
};

function config(): AppConfig {
  const env = loadServerEnv({
    NODE_ENV: 'test',
    YAHOO_CLIENT_ID: 'test-client',
    YAHOO_CLIENT_SECRET: 'test-secret',
    YAHOO_REDIRECT_URI: 'https://localhost:5173/auth/yahoo/callback',
    YAHOO_MODE: 'mock',
    APP_BASE_URL: 'https://localhost:5173',
    AWS_REGION: 'us-east-1',
    DYNAMODB_TABLE_NAME: 'test',
    SESSION_SECRET: KEY,
    TOKEN_ENCRYPTION_KEY: KEY,
  });

  return {
    env,
    capabilities: MATRIX,
    yahooApiBaseUrl: 'http://mock.invalid/fantasy/v2',
    yahooOAuthBaseUrl: 'http://mock.invalid',
  };
}

/** Routes Yahoo requests straight into the mock handlers, no socket involved. */
const mockFetch: FetchLike = async (url, init) => {
  const parsed = new URL(url);

  const respond = (status: number, body: unknown) => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  });

  if (parsed.pathname === '/oauth2/get_token') {
    const result = handleTokenRequest(init.body ?? '');
    return respond(result.status, result.body);
  }

  // Identity comes from OpenID Connect rather than the Fantasy API, so sign-in in
  // tests exercises the same endpoint production does.
  if (parsed.pathname === '/openid/v1/userinfo') {
    return respond(200, {
      sub: 'mock-openid-subject',
      nickname: 'mock_commissioner',
      email: 'mock_commissioner@example.invalid',
    });
  }

  if (parsed.pathname.startsWith('/fantasy/v2/')) {
    const result = handleFantasyRequest(parsed.pathname.slice('/fantasy/v2/'.length));
    return respond(result.status, result.body);
  }

  return respond(404, { error: 'no mock route' });
};

let table: InMemoryTable;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  setCapabilityMatrix(MATRIX);
  table = new InMemoryTable();
  app = createApp({
    config: config(),
    table: table.asTable(),
    fetchImpl: mockFetch,
    // Silent sink: these tests assert on responses, and real log output would
    // bury the failures.
    logger: createLogger({ correlationId: 'test', sink: () => {} }),
  });
});

/** Reads Set-Cookie values from a response. */
function cookiesFrom(response: Response): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const index = pair!.indexOf('=');
    jar[pair!.slice(0, index)] = decodeURIComponent(pair!.slice(index + 1));
  }
  return jar;
}

function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('; ');
}

/** Completes the OAuth round trip and returns an authenticated cookie jar. */
async function signIn(): Promise<Record<string, string>> {
  const start = await app.request('/auth/yahoo/start');
  expect(start.status).toBe(302);

  const authorizeUrl = new URL(start.headers.get('Location')!);
  const state = authorizeUrl.searchParams.get('state')!;

  const callback = await app.request(
    `/auth/yahoo/callback?code=mock-authorization-code&state=${encodeURIComponent(state)}`,
  );
  expect(callback.status).toBe(302);

  return cookiesFrom(callback);
}

/** Signs in and bootstraps, producing a primary-commissioner session. */
async function signInAsCommissioner(): Promise<Record<string, string>> {
  const jar = await signIn();

  const response = await app.request('/api/setup/bootstrap', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader(jar),
      [CSRF_HEADER]: jar[CSRF_COOKIE]!,
    },
    body: JSON.stringify({ leagueName: 'Test League' }),
  });
  expect(response.status).toBe(201);

  return jar;
}

describe('health', () => {
  it('responds without touching the database', async () => {
    // Registered before session resolution: a health check that fails when the
    // database is unreachable cannot distinguish a dead process from a dead
    // dependency.
    const response = await app.request('/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, yahooMode: 'mock' });
    expect(table.all()).toHaveLength(0);
  });
});

describe('security headers', () => {
  it('sets restrictive headers on every response', async () => {
    const response = await app.request('/health');

    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    // API responses are per-user and must never be shared by a cache.
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sets them on error responses too', async () => {
    const response = await app.request('/api/audit');
    expect(response.status).toBe(401);
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });
});

describe('CORS', () => {
  it('allows exactly the configured origin', async () => {
    const response = await app.request('/health', {
      headers: { Origin: 'https://localhost:5173' },
    });

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://localhost:5173');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('does not reflect an arbitrary origin', async () => {
    // Reflecting the request origin would defeat the point of having a policy.
    const response = await app.request('/health', {
      headers: { Origin: 'https://attacker.example' },
    });

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('never uses a wildcard, which cannot carry credentials anyway', async () => {
    const response = await app.request('/health', {
      headers: { Origin: 'https://localhost:5173' },
    });
    expect(response.headers.get('Access-Control-Allow-Origin')).not.toBe('*');
  });
});

describe('session endpoint', () => {
  it('reports unauthenticated and needing bootstrap on a fresh install', async () => {
    const response = await app.request('/api/session');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      authenticated: false,
      needsBootstrap: true,
      yahooMode: 'mock',
    });
  });
});

describe('CSRF protection', () => {
  it('rejects a state-changing request with no token', async () => {
    const jar = await signIn();

    const response = await app.request('/api/setup/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) },
      body: JSON.stringify({ leagueName: 'x' }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('rejects a mismatched token', async () => {
    const jar = await signIn();

    const response = await app.request('/api/setup/bootstrap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        [CSRF_HEADER]: 'wrong-value',
      },
      body: JSON.stringify({ leagueName: 'x' }),
    });

    expect(response.status).toBe(403);
  });

  it('does not require a token on GET', async () => {
    expect((await app.request('/api/session')).status).toBe(200);
  });
});

describe('Yahoo OAuth flow', () => {
  it('redirects to the consent screen with the documented parameters', async () => {
    const response = await app.request('/auth/yahoo/start');

    expect(response.status).toBe(302);
    const url = new URL(response.headers.get('Location')!);

    expect(url.searchParams.get('client_id')).toBe('test-client');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://localhost:5173/auth/yahoo/callback');
    // Read-only Fantasy scope. The portal never requests write access.
    /*
      No scope at all. Yahoo's current authorize endpoint rejects `fspt-r` with
      invalid_scope, which broke every sign-in; asserting its absence keeps someone
      from helpfully restoring it after reading the old OAuth 1.0a docs.
    */
    /*
      OpenID Connect scopes only. Identity comes from OIDC, so Fantasy permission
      is not a prerequisite for signing in, and `profile`/`email` are what supply a
      name to prefill. Never `fspt-r`: the live endpoint rejects it with
      invalid_scope, which broke every sign-in.
    */
    // The default: identity plus read-only Fantasy.
    expect(url.searchParams.get('scope')).toBe('openid profile email fspt-r');
    // Read, never write: Yahoo will grant fspt-w and the portal must not ask.
    expect(url.searchParams.get('scope')).not.toContain('fspt-w');
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The client secret must never appear in a browser-visible URL.
    expect(response.headers.get('Location')).not.toContain('test-secret');
  });

  it('stores the state server-side, never in the browser', async () => {
    const response = await app.request('/auth/yahoo/start');

    expect(table.ofEntity('OAuthState')).toHaveLength(1);
    expect(cookiesFrom(response)).toEqual({});
  });

  it('completes the round trip and issues a session', async () => {
    const jar = await signIn();

    expect(jar[SESSION_COOKIE]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(jar[CSRF_COOKIE]).toBeDefined();

    const session = await app.request('/api/session', {
      headers: { Cookie: cookieHeader(jar) },
    });
    const body = await session.json();

    expect(body.authenticated).toBe(true);
    // A brand-new user gets the least privilege; bootstrap is the only path to
    // commissioner.
    expect(body.user.role).toBe('readonly');
    // Prefilled from Yahoo, not yet confirmed by the person.
    expect(body.user.displayNameConfirmed).toBe(false);
  });

  it('never sends the Yahoo refresh token to the browser', async () => {
    const start = await app.request('/auth/yahoo/start');
    const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;

    const callback = await app.request(
      `/auth/yahoo/callback?code=mock-authorization-code&state=${encodeURIComponent(state)}`,
    );

    const exposed = [
      ...callback.headers.getSetCookie(),
      callback.headers.get('Location') ?? '',
      await callback.text(),
    ].join(' ');

    expect(exposed).not.toContain('mock-refresh-token');
  });

  it('encrypts the stored tokens at rest', async () => {
    await signIn();

    const [connection] = table.ofEntity('YahooConnection');
    expect(connection).toBeDefined();

    // Ciphertext, not plaintext: a table export must not hand over live credentials.
    expect(String(connection!['encryptedRefreshToken'])).toMatch(/^v1\./);
    expect(String(connection!['encryptedRefreshToken'])).not.toContain('mock-refresh-token');
    expect(String(connection!['encryptedAccessToken'])).toMatch(/^v1\./);
  });

  it('rejects a replayed callback', async () => {
    const start = await app.request('/auth/yahoo/start');
    const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
    const path = `/auth/yahoo/callback?code=mock-authorization-code&state=${encodeURIComponent(state)}`;

    const first = await app.request(path);
    expect(cookiesFrom(first)[SESSION_COOKIE]).toBeDefined();

    // A captured callback URL must be useless the second time.
    const second = await app.request(path);
    expect(second.status).toBe(302);
    expect(new URL(second.headers.get('Location')!).searchParams.get('yahooError')).toBe(
      'oauth_state_invalid',
    );
    expect(cookiesFrom(second)[SESSION_COOKIE]).toBeUndefined();
  });

  it('rejects an unknown state', async () => {
    const response = await app.request('/auth/yahoo/callback?code=x&state=never-issued');

    expect(new URL(response.headers.get('Location')!).searchParams.get('yahooError')).toBe(
      'oauth_state_invalid',
    );
  });

  it('reports a declined consent screen without alarm', async () => {
    const start = await app.request('/auth/yahoo/start');
    const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;

    const response = await app.request(
      `/auth/yahoo/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    );

    expect(new URL(response.headers.get('Location')!).searchParams.get('yahooError')).toBe(
      'oauth_denied',
    );
  });

  it('restricts returnTo to an internal path', async () => {
    // An attacker-controlled returnTo would turn the OAuth flow into an open
    // redirect on a domain the user is about to trust with credentials.
    for (const attempt of [
      'https://attacker.example',
      '//attacker.example',
      'javascript:alert(1)',
    ]) {
      const start = await app.request(`/auth/yahoo/start?returnTo=${encodeURIComponent(attempt)}`);
      const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;

      const callback = await app.request(
        `/auth/yahoo/callback?code=mock-authorization-code&state=${encodeURIComponent(state)}`,
      );

      const destination = new URL(callback.headers.get('Location')!);
      expect(destination.origin).toBe('https://localhost:5173');
    }
  });
});

describe('identifying a signer-in when OpenID Connect is unavailable', () => {
  /**
   * Yahoo refuses the OIDC scopes together with `fspt-r`, so a deployment that can
   * read the league cannot use OpenID Connect. Identity falls back to the Fantasy
   * API, and the two must agree on who the person is.
   */
  it('refuses the hidden-GUID placeholder rather than sharing one account', async () => {
    /**
     * When a Yahoo profile's privacy withholds the GUID, the Fantasy API answers with
     * the literal string `--hidden--`. Accepting it is worse than failing: it is the
     * same value for every such user, so all of them land on one shared portal
     * account. Production grew exactly one of those before this was caught.
     */
    const hidden: FetchLike = async (url, init) => {
      const parsed = new URL(url);

      if (parsed.pathname === '/oauth2/get_token') {
        const result = handleTokenRequest(init.body ?? '');
        return {
          status: result.status,
          ok: true,
          text: async () => JSON.stringify(result.body),
          headers: { get: () => null },
        };
      }

      if (parsed.pathname === '/openid/v1/userinfo') {
        return { status: 401, ok: false, text: async () => '{}', headers: { get: () => null } };
      }

      // What Yahoo really sends for a private profile.
      return {
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({ fantasy_content: { users: { 0: { user: [{ guid: '--hidden--' }] } } } }),
        headers: { get: () => null },
      };
    };

    const local = createApp({
      config: config(),
      table: table.asTable(),
      fetchImpl: hidden,
      logger: createLogger({ correlationId: 'test', sink: () => {} }),
    });

    const start = await local.request('/auth/yahoo/start');
    const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
    const callback = await local.request(
      `/auth/yahoo/callback?code=mock-authorization-code&state=${encodeURIComponent(state)}`,
    );

    // Refused, and no account created to be shared.
    expect(callback.headers.get('Location')).toContain('yahooError');
    expect(table.ofEntity('PortalUser')).toHaveLength(0);
  });

  it('uses the Fantasy API and lands on the same account', async () => {
    const noOidc: FetchLike = async (url, init) => {
      const parsed = new URL(url);

      if (parsed.pathname === '/oauth2/get_token') {
        const result = handleTokenRequest(init.body ?? '');
        return {
          status: result.status,
          ok: true,
          text: async () => JSON.stringify(result.body),
          headers: { get: () => null },
        };
      }

      // Exactly what a token without the openid scope gets back.
      if (parsed.pathname === '/openid/v1/userinfo') {
        return {
          status: 401,
          ok: false,
          text: async () => JSON.stringify({ error: 'insufficient_scope' }),
          headers: { get: () => null },
        };
      }

      if (parsed.pathname.startsWith('/fantasy/v2/')) {
        const result = handleFantasyRequest(parsed.pathname.slice('/fantasy/v2/'.length));
        return {
          status: result.status,
          ok: result.status < 300,
          text: async () => JSON.stringify(result.body),
          headers: { get: () => null },
        };
      }

      return { status: 404, ok: false, text: async () => '{}', headers: { get: () => null } };
    };

    const local = createApp({
      config: config(),
      table: table.asTable(),
      fetchImpl: noOidc,
      logger: createLogger({ correlationId: 'test', sink: () => {} }),
    });

    const start = await local.request('/auth/yahoo/start');
    const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
    const callback = await local.request(
      `/auth/yahoo/callback?code=mock-authorization-code&state=${encodeURIComponent(state)}`,
    );

    // Signed in, not refused.
    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).not.toContain('yahooError');

    const users = table.ofEntity('PortalUser');
    expect(users).toHaveLength(1);
    // The Fantasy API's GUID, and a name from it rather than "New manager".
    expect(users[0]!['yahooGuid']).toBeTruthy();
    expect(users[0]!['displayName']).not.toBe('New manager');
  });
});

describe('commissioner bootstrap', () => {
  it('makes the first user the primary commissioner', async () => {
    const jar = await signInAsCommissioner();

    const session = await app.request('/api/session', { headers: { Cookie: cookieHeader(jar) } });
    const body = await session.json();

    expect(body.user.role).toBe('commissioner');
    expect(body.user.isPrimaryCommissioner).toBe(true);
    expect(body.needsBootstrap).toBe(false);
  });

  it('refuses a second bootstrap', async () => {
    const jar = await signInAsCommissioner();

    const response = await app.request('/api/setup/bootstrap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        [CSRF_HEADER]: jar[CSRF_COOKIE]!,
      },
      body: JSON.stringify({ leagueName: 'Second League' }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'already_bootstrapped' } });
  });

  it('requires authentication', async () => {
    const response = await app.request('/api/setup/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leagueName: 'x' }),
    });

    // CSRF is checked first, which is also a rejection. Either way it is refused.
    expect([401, 403]).toContain(response.status);
  });

  it('writes an audit record', async () => {
    await signInAsCommissioner();

    const audit = table.ofEntity('AuditLog');
    expect(audit.some((entry) => entry['action'] === 'commissioner.bootstrapped')).toBe(true);
  });

  it('validates the request body', async () => {
    const jar = await signIn();

    const response = await app.request('/api/setup/bootstrap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        [CSRF_HEADER]: jar[CSRF_COOKIE]!,
      },
      body: JSON.stringify({ leagueName: '' }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('validation_failed');
    expect(body.fieldErrors.length).toBeGreaterThan(0);
  });
});

describe('backend authorization', () => {
  it('refuses audit history to an unauthenticated caller', async () => {
    const response = await app.request('/api/audit');

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  });

  it('refuses audit history to a non-commissioner', async () => {
    // Hiding the nav link is presentation. This is the actual boundary.
    await signInAsCommissioner();
    table.clear();
    const jar = await signIn();

    const response = await app.request('/api/audit', { headers: { Cookie: cookieHeader(jar) } });
    expect(response.status).toBe(403);
  });

  it('allows audit history to a commissioner', async () => {
    const jar = await signInAsCommissioner();

    const response = await app.request('/api/audit', { headers: { Cookie: cookieHeader(jar) } });
    expect(response.status).toBe(200);
    expect((await response.json()).entries.length).toBeGreaterThan(0);
  });

  it('refuses league linking to a non-commissioner', async () => {
    const commissionerJar = await signInAsCommissioner();
    void commissionerJar;

    // A second sign-in produces the same user here (one mock Yahoo identity), so
    // demote them to prove the check is on the role rather than on the session.
    const users = table.ofEntity('PortalUser');
    const user = users[0]!;
    await table.put({ ...user, role: 'manager', isPrimaryCommissioner: false });

    const jar = await signIn();
    const response = await app.request('/api/yahoo/league-link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        [CSRF_HEADER]: jar[CSRF_COOKIE]!,
      },
      body: JSON.stringify({
        yahooLeagueKey: '999.l.100001',
        yahooGameKey: '999',
        seasonYear: 2026,
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'commissioner_required' } });
  });
});

describe('Yahoo connection', () => {
  it('reports not connected before sign-in', async () => {
    const jar = await signInAsCommissioner();
    // Remove the connection the sign-in created.
    await app.request('/api/yahoo/connection', {
      method: 'DELETE',
      headers: { Cookie: cookieHeader(jar), [CSRF_HEADER]: jar[CSRF_COOKIE]! },
    });

    const response = await app.request('/api/yahoo/connection', {
      headers: { Cookie: cookieHeader(jar) },
    });

    expect(await response.json()).toMatchObject({ connected: false });
  });

  it('never exposes tokens or the Yahoo GUID in the status response', async () => {
    const jar = await signInAsCommissioner();

    const response = await app.request('/api/yahoo/connection', {
      headers: { Cookie: cookieHeader(jar) },
    });
    const body = await response.json();

    expect(body.connected).toBe(true);
    expect(JSON.stringify(body)).not.toContain('mock-refresh-token');
    expect(JSON.stringify(body)).not.toContain('MOCKGUID');
    expect(body).not.toHaveProperty('encryptedAccessToken');
    expect(body).not.toHaveProperty('yahooGuid');
  });

  it('deletes tokens and cached Yahoo data on disconnect', async () => {
    const jar = await signInAsCommissioner();

    // Populate the cache with a real Yahoo read first.
    await app.request('/api/yahoo/leagues', { headers: { Cookie: cookieHeader(jar) } });
    expect(table.cacheEntries().length).toBeGreaterThan(0);

    const response = await app.request('/api/yahoo/connection', {
      method: 'DELETE',
      headers: { Cookie: cookieHeader(jar), [CSRF_HEADER]: jar[CSRF_COOKIE]! },
    });

    expect(response.status).toBe(200);
    // Disconnecting must actually remove the data, not merely hide it.
    expect(table.ofEntity('YahooConnection')).toHaveLength(0);
    expect(table.cacheEntries()).toHaveLength(0);
  });
});

describe('league discovery and linking', () => {
  it('lists the leagues Yahoo returns, with nothing hardcoded', async () => {
    const jar = await signInAsCommissioner();

    const response = await app.request('/api/yahoo/leagues', {
      headers: { Cookie: cookieHeader(jar) },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.leagues).toHaveLength(2);
    expect(body.leagues[0].yahooLeagueKey).toBe('999.l.100001');
    // A hint for the picker only — it grants nothing in the portal.
    expect(body.leagues[0].isYahooCommissioner).toBe(true);
  });

  it('caches league reads under a TTL well below the 24-hour ceiling', async () => {
    const jar = await signInAsCommissioner();
    await app.request('/api/yahoo/leagues', { headers: { Cookie: cookieHeader(jar) } });

    const now = Math.floor(Date.now() / 1000);
    for (const entry of table.cacheEntries()) {
      expect(entry.expiresAt - now).toBeLessThanOrEqual(24 * 60 * 60);
      expect(entry.expiresAt - now).toBeGreaterThan(0);
    }
  });

  it('links a league and creates the season', async () => {
    const jar = await signInAsCommissioner();

    const response = await app.request('/api/yahoo/league-link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        [CSRF_HEADER]: jar[CSRF_COOKIE]!,
      },
      body: JSON.stringify({
        yahooLeagueKey: '999.l.100001',
        yahooGameKey: '999',
        seasonYear: 2026,
      }),
    });

    expect(response.status).toBe(201);
    expect(table.ofEntity('YahooLeagueLink')).toHaveLength(1);
    expect(table.ofEntity('Season')).toHaveLength(1);

    // Yahoo identifiers are stored separately from the portal's own IDs.
    const [link] = table.ofEntity('YahooLeagueLink');
    expect(link!['yahooLeagueKey']).toBe('999.l.100001');
    expect(link!['yahooGameKey']).toBe('999');
  });

  it('renders the league overview with teams and managers read live', async () => {
    const jar = await signInAsCommissioner();
    await app.request('/api/yahoo/league-link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        [CSRF_HEADER]: jar[CSRF_COOKIE]!,
      },
      body: JSON.stringify({
        yahooLeagueKey: '999.l.100001',
        yahooGameKey: '999',
        seasonYear: 2026,
      }),
    });

    const response = await app.request('/api/league/overview', {
      headers: { Cookie: cookieHeader(jar) },
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.linked).toBe(true);
    expect(body.yahoo.teams).toHaveLength(12);
    expect(body.yahoo.currentWeek).toBe(3);
    expect(body.yahoo.teams[0].managers[0].nickname).toBe('mock_commissioner');
    // Assembled now, not a stored snapshot.
    expect(body.fetchedAt).toBeDefined();
  });

  it('resolves a season year without Yahoo, so the portal-owned pages still work', async () => {
    /**
     * `currentSeasonYear` is only written when a Yahoo league is linked. The draft
     * board, the LLWS field and the challenge pages all key off it, so before Yahoo
     * arrives every one of them rendered empty — including the pages that owe Yahoo
     * nothing at all. The newest season created here stands in.
     */
    const jar = await signInAsCommissioner();

    await app.request('/api/seasons/2026', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        [CSRF_HEADER]: jar[CSRF_COOKIE]!,
      },
      body: JSON.stringify({ status: 'draft_pending' }),
    });

    const response = await app.request('/api/league/overview', {
      headers: { Cookie: cookieHeader(jar) },
    });

    const body = await response.json();
    expect(body.linked).toBe(false);
    expect(body.league.currentSeasonYear).toBe(2026);
  });

  it('does not persist any Yahoo team or manager name', async () => {
    const jar = await signInAsCommissioner();
    await app.request('/api/yahoo/league-link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        [CSRF_HEADER]: jar[CSRF_COOKIE]!,
      },
      body: JSON.stringify({
        yahooLeagueKey: '999.l.100001',
        yahooGameKey: '999',
        seasonYear: 2026,
      }),
    });
    await app.request('/api/league/overview', { headers: { Cookie: cookieHeader(jar) } });

    // Yahoo names may appear only in TTL'd cache entries, never in an entity.
    const durable = table.all().filter((item) => item['entity'] !== 'YahooCacheEntry');
    const serialized = JSON.stringify(durable);

    expect(serialized).not.toContain('Dovetail Dynasty');
    expect(serialized).not.toContain('Mortise & Tenon');
  });

  it('reports not linked on a fresh league rather than erroring', async () => {
    const jar = await signInAsCommissioner();

    const response = await app.request('/api/league/overview', {
      headers: { Cookie: cookieHeader(jar) },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ linked: false, yahoo: null });
  });
});

describe('challenges', () => {
  it('seeds thirteen definitions, all blocked while nothing is verified', async () => {
    const jar = await signInAsCommissioner();

    const seed = await app.request('/api/challenges/2026/seed', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        [CSRF_HEADER]: jar[CSRF_COOKIE]!,
      },
      body: '{}',
    });

    expect(seed.status).toBe(200);
    expect((await seed.json()).seeded).toHaveLength(13);

    const list = await app.request('/api/challenges/2026', {
      headers: { Cookie: cookieHeader(jar) },
    });
    const body = await list.json();

    expect(body.definitions).toHaveLength(13);
    // The shipped state: no capability verified, so nothing calculates.
    expect(body.blockedCount).toBe(13);
  });

  it('refuses to activate a challenge whose Yahoo data is unverified', async () => {
    const jar = await signInAsCommissioner();
    await app.request('/api/challenges/2026/seed', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        [CSRF_HEADER]: jar[CSRF_COOKIE]!,
      },
      body: '{}',
    });

    const response = await app.request('/api/challenges/2026/one-man-army', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        [CSRF_HEADER]: jar[CSRF_COOKIE]!,
      },
      body: JSON.stringify({ status: 'active' }),
    });

    // A commissioner cannot override the capability gate: doing so would let the
    // portal produce a number nobody can defend.
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'yahoo_capability_unverified' },
    });
  });

  it('reports which challenges are blocked and why instead of failing', async () => {
    const jar = await signInAsCommissioner();
    await app.request('/api/challenges/2026/seed', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        [CSRF_HEADER]: jar[CSRF_COOKIE]!,
      },
      body: '{}',
    });

    const response = await app.request('/api/challenges/2026/calculate/3', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        [CSRF_HEADER]: jar[CSRF_COOKIE]!,
      },
      body: '{}',
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.calculated).toEqual([]);
    expect(body.blocked).toHaveLength(13);
    expect(body.blocked[0].reason).toContain('verify:yahoo');
  });

  it('lets a commissioner correct a rule without a code change', async () => {
    const jar = await signInAsCommissioner();
    await app.request('/api/challenges/2026/seed', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        [CSRF_HEADER]: jar[CSRF_COOKIE]!,
      },
      body: '{}',
    });

    const response = await app.request('/api/challenges/2026/one-man-army', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        [CSRF_HEADER]: jar[CSRF_COOKIE]!,
      },
      body: JSON.stringify({ benchCounts: true, description: 'Our actual rule.' }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.definition.benchCounts).toBe(true);
    expect(body.definition.description).toBe('Our actual rule.');
  });
});

describe('capability reporting', () => {
  it('exposes the reviewed matrix, including that Yahoo writes are unsupported', async () => {
    const jar = await signInAsCommissioner();

    const response = await app.request('/api/yahoo/capabilities', {
      headers: { Cookie: cookieHeader(jar) },
    });
    const body = await response.json();

    expect(body.writeOperationsSupported).toBe(false);
    expect(body.commissionerActionsSupported).toBe(false);
    expect(body.access.approvalRequired).toBe(true);
    expect(body.retention.maxRetentionHours).toBe(24);
    expect(body.verifiedCapabilities).toEqual([]);
  });
});

describe('dues and payouts', () => {
  it('records dues and derives status from the amounts', async () => {
    const jar = await signInAsCommissioner();

    const response = await app.request('/api/dues/2026', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        [CSRF_HEADER]: jar[CSRF_COOKIE]!,
      },
      body: JSON.stringify({
        leagueMemberId: '01ABCDEFGHJKMNPQRSTVWXYZ00',
        amountOwed: { amountCents: 5000, currency: 'USD' },
        amountPaid: { amountCents: 2500, currency: 'USD' },
      }),
    });

    expect(response.status).toBe(201);
    // Derived, so status and money cannot drift apart.
    expect((await response.json()).dues.status).toBe('partial');
  });

  it('states plainly that it processes no payments', async () => {
    const jar = await signInAsCommissioner();

    const dues = await app.request('/api/dues/2026', { headers: { Cookie: cookieHeader(jar) } });
    const payouts = await app.request('/api/payouts/2026', {
      headers: { Cookie: cookieHeader(jar) },
    });

    expect((await dues.json()).note).toContain('does not process payments');
    expect((await payouts.json()).note).toContain('does not transfer money');
  });
});

describe('linking a league the API cannot read', () => {
  /**
   * The verification step exists so a broken key is caught once rather than failing
   * on every dashboard load. These cover the single deliberate hole in it, and the
   * fact that it is only that one.
   */
  function appWithFantasy(status: number, body: unknown) {
    const failing: FetchLike = async (url, init) => {
      const parsed = new URL(url);

      if (parsed.pathname === '/oauth2/get_token') {
        const result = handleTokenRequest(init.body ?? '');
        return {
          status: result.status,
          ok: true,
          text: async () => JSON.stringify(result.body),
          headers: { get: () => null },
        };
      }

      if (parsed.pathname === '/openid/v1/userinfo') {
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({ sub: 'mock-openid-subject' }),
          headers: { get: () => null },
        };
      }

      return {
        status,
        ok: false,
        text: async () => JSON.stringify(body),
        headers: { get: () => null },
      };
    };

    return createApp({
      config: config(),
      table: table.asTable(),
      fetchImpl: failing,
      logger: createLogger({ correlationId: 'test', sink: () => {} }),
    });
  }

  const FANTASY_CLOSED = {
    error: {
      lang: 'en-US',
      description: 'Please provide valid credentials. OAuth oauth_problem="additional_authorization_required"',
    },
  };

  async function commissionerJar(local: ReturnType<typeof createApp>) {
    const start = await local.request('/auth/yahoo/start');
    const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
    const callback = await local.request(
      `/auth/yahoo/callback?code=mock-authorization-code&state=${encodeURIComponent(state)}`,
    );

    const jar: Record<string, string> = {};
    for (const header of callback.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const index = pair!.indexOf('=');
      jar[pair!.slice(0, index)] = decodeURIComponent(pair!.slice(index + 1));
    }

    await local.request('/api/setup/bootstrap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        [CSRF_HEADER]: jar[CSRF_COOKIE]!,
      },
      body: JSON.stringify({ leagueName: 'La Liga de Lopie' }),
    });

    return jar;
  }

  it('records the link unverified when the application has no Fantasy access', async () => {
    /*
      With the API closed every key fails identically, so refusing would leave the
      portal unfinishable for as long as Yahoo takes — which is not the
      commissioner's to fix.
    */
    const local = appWithFantasy(401, FANTASY_CLOSED);
    const jar = await commissionerJar(local);

    const response = await local.request('/api/yahoo/league-link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        [CSRF_HEADER]: jar[CSRF_COOKIE]!,
      },
      body: JSON.stringify({
        yahooLeagueKey: 'nfl.l.123456',
        yahooGameKey: 'nfl',
        seasonYear: 2026,
      }),
    });

    expect(response.status).toBe(201);

    const link = table.all().find((item) => item['entity'] === 'YahooLeagueLink');
    // Recorded, and visibly not proven.
    expect(link?.['status']).toBe('pending_verification');
    expect(link?.['yahooLeagueKey']).toBe('nfl.l.123456');
  });

  it('still refuses a key Yahoo says does not exist', async () => {
    // The hole is exactly one failure wide. A typo must not become a stored link.
    const local = appWithFantasy(404, { error: { description: 'League not found' } });
    const jar = await commissionerJar(local);

    const response = await local.request('/api/yahoo/league-link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        [CSRF_HEADER]: jar[CSRF_COOKIE]!,
      },
      body: JSON.stringify({
        yahooLeagueKey: 'nfl.l.999999',
        yahooGameKey: 'nfl',
        seasonYear: 2026,
      }),
    });

    expect(response.status).toBe(404);
    expect(table.all().find((item) => item['entity'] === 'YahooLeagueLink')).toBeUndefined();
  });
});

describe('LLWS draft-order workflow', () => {
  it('produces a reproducible draw and never claims Yahoo can be written', async () => {
    const jar = await signInAsCommissioner();
    const auth = {
      'Content-Type': 'application/json',
      Cookie: cookieHeader(jar),
      [CSRF_HEADER]: jar[CSRF_COOKIE]!,
    };

    await app.request('/api/yahoo/league-link', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        yahooLeagueKey: '999.l.100001',
        yahooGameKey: '999',
        seasonYear: 2026,
      }),
    });

    // Two portal members, mapped by hand as the commissioner would.
    for (const name of ['Alpha Manager', 'Beta Manager']) {
      await app.request('/api/league/members', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ seasonYear: 2026, legacyManagerName: name }),
      });
    }

    await app.request('/api/llws/2026/teams', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        teams: [{ name: 'Region One' }, { name: 'Region Two' }],
      }),
    });

    const draw = await app.request('/api/llws/2026/draw', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ seed: 'llws-2026:fixed-seed' }),
    });

    expect(draw.status).toBe(201);
    const drawBody = await draw.json();
    expect(drawBody.assignments).toHaveLength(2);
    // The seed is recorded so the draw can be audited later.
    expect(drawBody.seed).toBe('llws-2026:fixed-seed');
    expect(drawBody.published).toBe(false);

    const verify = await app.request('/api/llws/2026/verify-draw', {
      headers: { Cookie: cookieHeader(jar) },
    });
    expect((await verify.json()).verified).toBe(true);

    const status = await app.request('/api/draft/2026/status', {
      headers: { Cookie: cookieHeader(jar) },
    });
    const statusBody = await status.json();

    // No documented Yahoo endpoint sets draft order, so the workflow ends in
    // manual entry and says so.
    expect(statusBody.yahooWriteSupported).toBe(false);
    expect(statusBody.note).toContain('manually in Yahoo');
  });

  /**
   * Sets up a complete, computed selection order for `count` managers.
   *
   * Finishes are recorded in reverse, so the LAST team entered wins the tournament.
   * That makes "highest LLWS finish picks first" a real assertion rather than one
   * that would also pass if the code simply preserved entry order.
   */
  async function readyToSelect(count: number): Promise<{
    jar: Record<string, string>;
    auth: Record<string, string>;
    order: Array<{
      leagueMemberId: string;
      selectionOrder: number;
      derivedFrom: { llwsFinishRank?: number };
    }>;
  }> {
    const jar = await signInAsCommissioner();
    const auth = {
      'Content-Type': 'application/json',
      Cookie: cookieHeader(jar),
      [CSRF_HEADER]: jar[CSRF_COOKIE]!,
    };

    await app.request('/api/yahoo/league-link', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        yahooLeagueKey: '999.l.100001',
        yahooGameKey: '999',
        seasonYear: 2026,
      }),
    });

    for (let i = 1; i <= count; i += 1) {
      await app.request('/api/league/members', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ seasonYear: 2026, legacyManagerName: `Manager ${i}` }),
      });
    }

    await app.request('/api/llws/2026/teams', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        teams: Array.from({ length: count }, (_, i) => ({ name: `Region ${i + 1}` })),
      }),
    });

    await app.request('/api/llws/2026/draw', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ seed: 'llws-2026:selection-test' }),
    });

    const teams = await (
      await app.request('/api/llws/2026/teams', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    // Reverse order: the last team entered finishes first.
    for (const [index, team] of [...teams.teams].reverse().entries()) {
      await app.request(`/api/llws/2026/teams/${team.llwsTeamId}/finish`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ finishRank: index + 1 }),
      });
    }

    const computed = await app.request('/api/draft/2026/selection-order', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ tieBreakers: ['seeded_random'], seed: 'tiebreak-seed' }),
    });
    expect(computed.status).toBe(200);

    const status = await (
      await app.request('/api/draft/2026/status', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    return { jar, auth, order: status.selections };
  }

  it('queues the manager whose LLWS team finished highest first', async () => {
    const { jar, order } = await readyToSelect(4);

    const first = [...order].sort((a, b) => a.selectionOrder - b.selectionOrder)[0]!;
    expect(first.derivedFrom.llwsFinishRank).toBe(1);

    const status = await (
      await app.request('/api/draft/2026/status', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    // Only the front of the queue is open; nobody else can act yet.
    expect(status.currentTurn.leagueMemberId).toBe(first.leagueMemberId);
    expect(status.selections.filter((s: { status: string }) => s.status === 'open')).toHaveLength(
      1,
    );
  });

  it('advances the turn when a slot is taken, and keeps the choice', async () => {
    const { jar, auth, order } = await readyToSelect(4);
    const sorted = [...order].sort((a, b) => a.selectionOrder - b.selectionOrder);

    // Selection order 1 takes draft slot 4: choosing first is not drafting first,
    // and the two must not be conflated anywhere in the pipeline.
    const response = await app.request('/api/draft/2026/select', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ draftPosition: 4, leagueMemberId: sorted[0]!.leagueMemberId }),
    });
    expect(response.status).toBe(200);

    const status = await (
      await app.request('/api/draft/2026/status', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    expect(status.currentTurn.leagueMemberId).toBe(sorted[1]!.leagueMemberId);
    expect(status.availablePositions).not.toContain(4);
    expect(
      status.finalOrder.find((e: { draftPosition: number }) => e.draftPosition === 4),
    ).toMatchObject({ leagueMemberId: sorted[0]!.leagueMemberId });
  });

  it('refuses a slot somebody already took', async () => {
    const { auth, order } = await readyToSelect(4);
    const sorted = [...order].sort((a, b) => a.selectionOrder - b.selectionOrder);

    await app.request('/api/draft/2026/select', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ draftPosition: 2, leagueMemberId: sorted[0]!.leagueMemberId }),
    });

    const clash = await app.request('/api/draft/2026/select', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ draftPosition: 2, leagueMemberId: sorted[1]!.leagueMemberId }),
    });

    expect(clash.status).toBe(409);
    expect((await clash.json()).error.code).toBe('draft_position_taken');
  });

  it('marks a commissioner pick as such rather than as the manager’s own', async () => {
    // Taking somebody's choice away is legitimate when they stall the queue, but it
    // must be visible in the record.
    const { jar, auth, order } = await readyToSelect(3);
    const sorted = [...order].sort((a, b) => a.selectionOrder - b.selectionOrder);

    await app.request('/api/draft/2026/select', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ draftPosition: 1, leagueMemberId: sorted[0]!.leagueMemberId }),
    });

    const status = await (
      await app.request('/api/draft/2026/status', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    const picked = status.selections.find(
      (s: { leagueMemberId: string }) => s.leagueMemberId === sorted[0]!.leagueMemberId,
    );
    expect(picked.status).toBe('commissioner_assigned');
  });

  it('reports the order incomplete until every slot is filled', async () => {
    /**
     * Twelve, because the slot count comes from the SEASON's team count — which the
     * Yahoo league link sets to 12 — not from however many members happen to be
     * mapped. A league with three mapped members really does have nine draft slots
     * nobody can claim, and the status endpoint is right to keep saying so.
     */
    const { jar, auth, order } = await readyToSelect(12);
    const sorted = [...order].sort((a, b) => a.selectionOrder - b.selectionOrder);

    let status = await (
      await app.request('/api/draft/2026/status', { headers: { Cookie: cookieHeader(jar) } })
    ).json();
    expect(status.complete).toBe(false);
    expect(status.missingPositions).toHaveLength(12);

    for (const [index, selection] of sorted.entries()) {
      await app.request('/api/draft/2026/select', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          draftPosition: index + 1,
          leagueMemberId: selection.leagueMemberId,
        }),
      });
    }

    status = await (
      await app.request('/api/draft/2026/status', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    expect(status.complete).toBe(true);
    expect(status.missingPositions).toEqual([]);
    // Nobody is up once everyone has chosen.
    expect(status.currentTurn).toBeNull();
  });

  it('never moves a locked pick when the order is recomputed', async () => {
    const { jar, auth, order } = await readyToSelect(4);
    const sorted = [...order].sort((a, b) => a.selectionOrder - b.selectionOrder);

    await app.request('/api/draft/2026/select', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ draftPosition: 3, leagueMemberId: sorted[0]!.leagueMemberId }),
    });

    // Recomputing with different tiebreakers must not reshuffle a slot somebody
    // already holds — that would take back a decision already announced.
    const recompute = await app.request('/api/draft/2026/selection-order', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ tieBreakers: ['worse_prior_season_finish', 'seeded_random'] }),
    });
    expect(recompute.status).toBe(200);

    const status = await (
      await app.request('/api/draft/2026/status', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    const held = status.selections.find(
      (s: { leagueMemberId: string }) => s.leagueMemberId === sorted[0]!.leagueMemberId,
    );
    expect(held.chosenDraftPosition).toBe(3);
  });

  it('records a reminder without pretending to send anything', async () => {
    const { auth } = await readyToSelect(3);

    const response = await app.request('/api/draft/2026/remind', { method: 'POST', headers: auth });
    expect(response.status).toBe(200);
    expect((await response.json()).reminded).toBe(true);
  });

  /**
   * The real shape of this problem: a twenty-team field and a twelve-team league.
   *
   * The LLWS is always bigger than a fantasy league, so eight teams going undrawn is
   * the normal case rather than an error — but they have to be reported. Eight teams
   * silently absent looks exactly like eight teams the commissioner forgot to enter,
   * and the first they would know of it is a draft order missing people.
   */
  it('draws a full league from a larger field and reports the teams nobody drew', async () => {
    const jar = await signInAsCommissioner();
    const auth = {
      'Content-Type': 'application/json',
      Cookie: cookieHeader(jar),
      [CSRF_HEADER]: jar[CSRF_COOKIE]!,
    };

    await app.request('/api/yahoo/league-link', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        yahooLeagueKey: '999.l.100001',
        yahooGameKey: '999',
        seasonYear: 2026,
      }),
    });

    for (let i = 1; i <= 12; i += 1) {
      await app.request('/api/league/members', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ seasonYear: 2026, legacyManagerName: `Manager ${i}` }),
      });
    }

    // Twenty teams, as the LLWS field actually is.
    await app.request('/api/llws/2026/teams', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        teams: Array.from({ length: 20 }, (_, i) => ({
          name: `Region ${i + 1}`,
          bracket: i < 10 ? 'united_states' : 'international',
        })),
      }),
    });

    const draw = await app.request('/api/llws/2026/draw', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ seed: 'llws-2026:twenty-team-field' }),
    });
    expect(draw.status).toBe(201);

    const drawBody = await draw.json();
    expect(drawBody.assignments).toHaveLength(12);
    expect(drawBody.unassignedLlwsTeamIds).toHaveLength(8);
    // Nobody is left without a team; that would be the actual problem.
    expect(drawBody.unassignedLeagueMemberIds).toHaveLength(0);

    const view = await (
      await app.request('/api/llws/2026/assignments', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    expect(view.assignments).toHaveLength(12);
    expect(view.undrawnTeams).toHaveLength(8);
    expect(view.unassignedManagers).toHaveLength(0);

    // Names, not ULIDs. A draw result nobody can read is not a result.
    for (const assignment of view.assignments) {
      expect(assignment.displayName).toMatch(/^Manager \d+$/);
      expect(assignment.teamName).toMatch(/^Region \d+$/);
    }

    // Every team is accounted for exactly once, drawn or not.
    const drawnIds = view.assignments.map((a: { llwsTeamId: string }) => a.llwsTeamId);
    const undrawnIds = view.undrawnTeams.map((t: { llwsTeamId: string }) => t.llwsTeamId);
    expect(new Set([...drawnIds, ...undrawnIds]).size).toBe(20);
  });

  it('reports managers who drew nothing when the field is too small', async () => {
    // The mirror case, and a genuine setup mistake: somebody would have no place in
    // the draft order at all.
    const jar = await signInAsCommissioner();
    const auth = {
      'Content-Type': 'application/json',
      Cookie: cookieHeader(jar),
      [CSRF_HEADER]: jar[CSRF_COOKIE]!,
    };

    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      await app.request('/api/league/members', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ seasonYear: 2026, legacyManagerName: name }),
      });
    }

    await app.request('/api/llws/2026/teams', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ teams: [{ name: 'Only Region' }] }),
    });

    await app.request('/api/llws/2026/draw', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ seed: 'llws-2026:short-field' }),
    });

    const view = await (
      await app.request('/api/llws/2026/assignments', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    expect(view.assignments).toHaveLength(1);
    expect(view.unassignedManagers).toHaveLength(2);
    expect(view.undrawnTeams).toHaveLength(0);
  });

  it('keeps an unpublished draw away from members', async () => {
    // The draw is not league news until it is published, and a half-drawn field
    // leaking invites exactly the argument the seed exists to prevent.
    const jar = await signInAsCommissioner();
    const auth = {
      'Content-Type': 'application/json',
      Cookie: cookieHeader(jar),
      [CSRF_HEADER]: jar[CSRF_COOKIE]!,
    };

    await app.request('/api/league/members', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ seasonYear: 2026, legacyManagerName: 'Alpha' }),
    });
    await app.request('/api/llws/2026/teams', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ teams: [{ name: 'Region One' }] }),
    });
    await app.request('/api/llws/2026/draw', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ seed: 'unpublished' }),
    });

    const user = table.ofEntity('PortalUser')[0]!;
    await table.put({ ...user, role: 'manager', isPrimaryCommissioner: false });

    const memberJar = await signIn();
    const asMember = await (
      await app.request('/api/llws/2026/assignments', {
        headers: { Cookie: cookieHeader(memberJar) },
      })
    ).json();

    expect(asMember.assignments).toHaveLength(0);
  });

  /**
   * The prior-season tiebreaker, end to end.
   *
   * `worse_prior_season_finish` is the DEFAULT tiebreaker for the selection order and
   * its only input is the previous season's `finalFinishOrder`. Until there was a way
   * to record that, the rule had nothing to compare and every tie fell through to the
   * random seed — which looks like it worked, and is not the rule the league agreed.
   *
   * Two managers whose LLWS teams finish level must be separated by last season, with
   * the WORSE prior finish choosing first.
   */
  it('separates a tie by last season, worst finisher choosing first', async () => {
    const jar = await signInAsCommissioner();
    const auth = {
      'Content-Type': 'application/json',
      Cookie: cookieHeader(jar),
      [CSRF_HEADER]: jar[CSRF_COOKIE]!,
    };

    await app.request('/api/yahoo/league-link', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        yahooLeagueKey: '999.l.100001',
        yahooGameKey: '999',
        seasonYear: 2026,
      }),
    });

    for (const name of ['Champion', 'WoodenSpoon']) {
      await app.request('/api/league/members', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ seasonYear: 2026, legacyManagerName: name }),
      });
    }

    const members = (
      await (
        await app.request('/api/league/members?seasonYear=2026', {
          headers: { Cookie: cookieHeader(jar) },
        })
      ).json()
    ).members as Array<{ leagueMemberId: string; displayName: string }>;

    const champion = members.find((m) => m.displayName === 'Champion')!;
    const spoon = members.find((m) => m.displayName === 'WoodenSpoon')!;

    // Last season: Champion first, WoodenSpoon last.
    const saved = await app.request('/api/seasons/2025', {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({
        finalFinishOrder: [champion.leagueMemberId, spoon.leagueMemberId],
      }),
    });
    expect(saved.status).toBe(200);

    await app.request('/api/llws/2026/teams', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ teams: [{ name: 'Region A' }, { name: 'Region B' }] }),
    });
    await app.request('/api/llws/2026/draw', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ seed: 'llws-2026:tiebreak' }),
    });

    // Both LLWS teams go out at the same stage, so the finishes cannot separate them.
    const teams = (
      await (
        await app.request('/api/llws/2026/teams', { headers: { Cookie: cookieHeader(jar) } })
      ).json()
    ).teams as Array<{ llwsTeamId: string }>;

    for (const team of teams) {
      await app.request(`/api/llws/2026/teams/${team.llwsTeamId}/finish`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ finishRank: 3 }),
      });
    }

    await app.request('/api/draft/2026/selection-order', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ tieBreakers: ['worse_prior_season_finish'] }),
    });

    const status = await (
      await app.request('/api/draft/2026/status', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    const ordered = [...status.selections].sort(
      (a: { selectionOrder: number }, b: { selectionOrder: number }) =>
        a.selectionOrder - b.selectionOrder,
    );

    // Worse last season chooses first. Without the recorded order this would be
    // whatever the seed happened to produce.
    expect(ordered[0].displayName).toBe('WoodenSpoon');
    expect(ordered[1].displayName).toBe('Champion');
    expect(ordered[0].derivedFrom.appliedTieBreaker).toBe('worse_prior_season_finish');
  });

  it('refuses to redraw over an existing draw without explicit confirmation', async () => {
    const jar = await signInAsCommissioner();
    const auth = {
      'Content-Type': 'application/json',
      Cookie: cookieHeader(jar),
      [CSRF_HEADER]: jar[CSRF_COOKIE]!,
    };

    await app.request('/api/league/members', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ seasonYear: 2026, legacyManagerName: 'Alpha' }),
    });
    await app.request('/api/llws/2026/teams', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ teams: [{ name: 'Region One' }] }),
    });
    await app.request('/api/llws/2026/draw', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ seed: 'seed-one' }),
    });

    const second = await app.request('/api/llws/2026/draw', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ seed: 'seed-two' }),
    });

    expect(second.status).toBe(409);
    expect((await second.json()).error.message).toContain('confirm explicitly');
  });

  /**
   * The public endpoint is the only route that answers without a session, so the
   * question these cover is not "does it work" but "what can a stranger get".
   */
  describe('the signed-out view', () => {
    it('needs no session at all', async () => {
      // No Cookie header anywhere: this is what someone opening the link sees.
      const response = await app.request('/api/public/home');

      expect(response.status).toBe(200);
      expect((await response.json()).order).toBeNull();
    });

    it('withholds the order until the draw is published', async () => {
      /**
       * The guarantee that matters. A drawn-but-unpublished order is the
       * commissioner's alone — publishing is the deliberate act of telling the
       * league, and it must not be pre-empted by an unauthenticated URL.
       */
      const { auth } = await readyToSelect(4);

      const drawn = await (await app.request('/api/public/home')).json();
      expect(drawn.order).toBeNull();

      await app.request('/api/llws/2026/publish', { method: 'POST', headers: auth });

      // Published, but the picks are not in yet, so still no order.
      const published = await (await app.request('/api/public/home')).json();
      expect(published.order).toBeNull();

      // The mapping, though, is exactly what publishing releases.
      expect(published.assignments.entries).toHaveLength(4);

      /*
        Every entry carries why its position is unsettled. The route builds this
        object field by field and once omitted `pending` entirely, which left the
        page unable to tell a range that narrows from one the tiebreakers decide —
        and made the "still playing" count include managers already knocked out.
      */
      for (const entry of published.assignments.entries) {
        // Every team here has a distinct finish recorded, so each position is settled.
        expect(entry.standing.locked).toBe(true);
        expect(entry.standing.pending).toBeNull();
      }

      // And nobody is counted as still playing, which is the bug this guards: the
      // count used to include anyone whose position was unsettled, tied-and-out
      // included.
      expect(published.assignments.stillPlaying).toBe(0);
      expect(published.assignments.entries[0].manager).toBeTruthy();
      expect(published.assignments.entries[0].llwsTeam).toBeTruthy();

      /*
        The seed ships with it, deliberately. It is worthless as a secret once the
        pairings are visible, and it is the only thing that turns "it was random"
        into a claim a suspicious manager can actually test.
      */
      expect(published.assignments.seed).toBe('llws-2026:selection-test');
    });

    it('keeps the mapping private until it is published', async () => {
      await readyToSelect(4);

      const body = await (await app.request('/api/public/home')).json();
      expect(body.assignments).toBeNull();
    });

    it('shows the finished order, with names and teams but nothing else', async () => {
      const { auth, order } = await readyToSelect(4);
      await app.request('/api/llws/2026/publish', { method: 'POST', headers: auth });

      // Linking the mock league set teamCount to its 12 teams; this league has four.
      await app.request('/api/seasons/2026', {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ teamCount: 4 }),
      });

      // Everybody picks, so the order is complete.
      const sorted = [...order].sort((a, b) => a.selectionOrder - b.selectionOrder);
      for (const [index, selection] of sorted.entries()) {
        await app.request('/api/draft/2026/select', {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({
            draftPosition: index + 1,
            leagueMemberId: selection.leagueMemberId,
          }),
        });
      }

      const body = await (await app.request('/api/public/home')).json();

      expect(body.order).toHaveLength(4);
      expect(body.order[0].draftPosition).toBe(1);
      expect(body.order[0].manager).toBeTruthy();

      /*
        Names and positions are the point; identifiers are not. A member ID in this
        payload would be a durable handle on a private record, handed to anyone who
        loads the page.
      */
      const keys = Object.keys(body.order[0]).sort();
      expect(keys).toEqual(['draftPosition', 'llwsTeam', 'manager']);

      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('leagueMemberId');
      expect(serialized).not.toContain('userId');
      expect(serialized).not.toContain('@');
    });

    it('carries the draft time so the countdown works before anything is drawn', async () => {
      const jar = await signInAsCommissioner();
      await app.request('/api/seasons/2026', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader(jar),
          [CSRF_HEADER]: jar[CSRF_COOKIE]!,
        },
        body: JSON.stringify({ draftAt: '2026-09-02T00:30:00Z' }),
      });

      const body = await (await app.request('/api/public/home')).json();
      expect(body.draftAt).toBe('2026-09-02T00:30:00Z');
    });
  });
});

describe('challenge results', () => {
  /**
   * The five capabilities the eight buildable challenges need.
   *
   * Deliberately excludes `team_projected_points` and `player_stat_by_id`, which
   * have no documented Yahoo field — so the five genuinely-blocked challenges stay
   * blocked here exactly as they do in production.
   */
  const VERIFIED = [
    'roster_selected_position',
    'player_week_points',
    'player_position',
    'team_week_points',
    'matchup_result',
  ] as const;

  function verifyCapabilities(): void {
    setCapabilityMatrix({ ...MATRIX, verifiedCapabilities: [...VERIFIED] });
  }

  /** Links a league, maps members to Yahoo teams, and seeds the definitions. */
  async function seededLeague(): Promise<{
    jar: Record<string, string>;
    auth: Record<string, string>;
  }> {
    const jar = await signInAsCommissioner();
    const auth = {
      'Content-Type': 'application/json',
      Cookie: cookieHeader(jar),
      [CSRF_HEADER]: jar[CSRF_COOKIE]!,
    };

    await app.request('/api/yahoo/league-link', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        yahooLeagueKey: '999.l.100001',
        yahooGameKey: '999',
        seasonYear: 2026,
      }),
    });

    // Challenges are keyed to portal members, so every Yahoo team needs one.
    const overview = await (
      await app.request('/api/league/overview', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    for (const [index, team] of overview.yahoo.teams.entries()) {
      await app.request('/api/league/members', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          seasonYear: 2026,
          yahooTeamKey: team.yahooTeamKey,
          legacyManagerName: `Manager ${index + 1}`,
        }),
      });
    }

    await app.request('/api/challenges/2026/seed', { method: 'POST', headers: auth });
    return { jar, auth };
  }

  /**
   * Recording a winner by hand.
   *
   * The interesting cases are not that it stores a name — it is that it stays
   * distinguishable from a computed result, and that it cannot be used to quietly
   * rewrite one that is already settled.
   */
  describe('recording a winner by hand', () => {
    async function members(jar: Record<string, string>): Promise<Array<{ leagueMemberId: string }>> {
      const response = await app.request('/api/league/members?seasonYear=2026', {
        headers: { Cookie: cookieHeader(jar) },
      });
      return (await response.json()).members;
    }

    it('records a winner for a challenge the portal cannot calculate at all', async () => {
      /*
        The whole point. Every capability is unverified, so `calculate` refuses all
        thirteen — and this league still ran these challenges every week out of a
        spreadsheet.
      */
      const { jar, auth } = await seededLeague();
      const [winner] = await members(jar);

      const response = await app.request('/api/challenges/2026/record/3/bench-mob', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          winningLeagueMemberIds: [winner!.leagueMemberId],
          winningValue: 41.5,
          note: 'Read off Yahoo by hand while the API is unavailable.',
        }),
      });

      expect(response.status).toBe(201);

      const results = await (
        await app.request('/api/challenges/2026/results/3', { headers: { Cookie: cookieHeader(jar) } })
      ).json();

      const recorded = results.results.find(
        (entry: { challengeSlug: string }) => entry.challengeSlug === 'bench-mob',
      );

      expect(recorded.status).toBe('manual');
      expect(recorded.winningValue).toBe(41.5);
      // Never dressed up as arithmetic the portal did.
      expect(recorded.explanation).toContain('rather than calculated');
    });

    it('can be finalized like any other result, so it is payable', async () => {
      const { jar, auth } = await seededLeague();
      const [winner] = await members(jar);

      await app.request('/api/challenges/2026/record/4/blackjack', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          winningLeagueMemberIds: [winner!.leagueMemberId],
          note: 'Agreed on the group chat.',
        }),
      });

      const finalize = await app.request('/api/challenges/2026/finalize/4/blackjack', {
        method: 'POST',
        headers: auth,
      });

      expect(finalize.status).toBe(200);
    });

    it('will not overwrite a finalized result', async () => {
      /*
        The guard that matters. A settled outcome may have been paid out, so changing
        it has to go through override and leave a reason — this path must not become
        a way around that.
      */
      const { jar, auth } = await seededLeague();
      const all = await members(jar);

      await app.request('/api/challenges/2026/record/5/bad-beat', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          winningLeagueMemberIds: [all[0]!.leagueMemberId],
          note: 'First entry.',
        }),
      });
      await app.request('/api/challenges/2026/finalize/5/bad-beat', {
        method: 'POST',
        headers: auth,
      });

      const second = await app.request('/api/challenges/2026/record/5/bad-beat', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          winningLeagueMemberIds: [all[1]!.leagueMemberId],
          note: 'Changed my mind.',
        }),
      });

      expect(second.status).toBe(409);

      // The refusal is itself worth a record.
      const blocked = table
        .all()
        .find((item) => item['action'] === 'challenge.settled_result_change_blocked');
      expect(blocked).toBeDefined();
    });

    it('refuses a manager who is not in the season', async () => {
      // Otherwise a mistyped id becomes a payable result pointing at nobody.
      const { auth } = await seededLeague();

      const response = await app.request('/api/challenges/2026/record/6/photo-finish', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          winningLeagueMemberIds: ['01M0000000000000000000000X'],
          note: 'Typo.',
        }),
      });

      expect(response.status).toBe(400);
    });

    it('requires a note', async () => {
      const { jar, auth } = await seededLeague();
      const [winner] = await members(jar);

      const response = await app.request('/api/challenges/2026/record/7/one-man-army', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          winningLeagueMemberIds: [winner!.leagueMemberId],
          note: '',
        }),
      });

      expect(response.status).toBe(400);
    });
  });

  it('refuses to calculate anything while no capability is verified', async () => {
    // The shipped state. Thirteen rules, nothing computed, and a reason for each.
    const { auth } = await seededLeague();

    const response = await app.request('/api/challenges/2026/calculate/3', {
      method: 'POST',
      headers: auth,
    });

    const body = await response.json();
    expect(body.calculated).toEqual([]);
    expect(body.blocked).toHaveLength(13);
  });

  it('will not activate a challenge whose Yahoo data is unverified', async () => {
    const { auth } = await seededLeague();

    const response = await app.request('/api/challenges/2026/bench-mob', {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ status: 'active' }),
    });

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('yahoo_capability_unverified');
  });

  it('calculates the nine buildable challenges once their data is verified', async () => {
    const { jar, auth } = await seededLeague();
    verifyCapabilities();

    // Seeded definitions keep the status they were given, so they must be activated
    // before anything runs — the same step a commissioner takes after approval.
    const definitions = await (
      await app.request('/api/challenges/2026', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    let activated = 0;
    for (const definition of definitions.definitions) {
      const response = await app.request(`/api/challenges/2026/${definition.slug}`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ status: 'active' }),
      });
      if (response.status === 200) activated += 1;
    }

    /*
      Nine buildable on documented fields; four stay refused. Air Raid joined them
      when its rule was corrected to the league's own — the starting quarterback
      with the most fantasy points, rather than the most passing yards, which needed
      a raw stat id.
    */
    expect(activated).toBe(9);

    /*
      One challenge a week, on the league's fixed schedule, so calculating a week
      computes that week's challenge and nothing else. Week 3 is Bench Mob.
    */
    const week3 = await (
      await app.request('/api/challenges/2026/calculate/3', { method: 'POST', headers: auth })
    ).json();

    expect(week3.calculated.map((entry: { slug: string }) => entry.slug)).toEqual(['bench-mob']);
    expect(week3.note).toContain('provisional');

    /*
      All nine buildable ones, each in its own week. Running the whole calendar is
      what proves the schedule and the arithmetic agree — calculating one week eight
      times would have proved neither.
    */
    const buildable: Array<[number, string]> = [
      [1, 'one-man-army'],
      [2, 'photo-finish'],
      [3, 'bench-mob'],
      [4, 'ground-and-pound'],
      [5, 'bad-beat'],
      [7, 'air-raid'],
      [8, 'tight-end-day'],
      [9, 'defense-wins-championships'],
      [12, 'blackjack'],
    ];

    for (const [week, slug] of buildable) {
      const response = await (
        await app.request(`/api/challenges/2026/calculate/${week}`, {
          method: 'POST',
          headers: auth,
        })
      ).json();

      expect(response.calculated.map((entry: { slug: string }) => entry.slug)).toEqual([slug]);

      const results = await (
        await app.request(`/api/challenges/2026/results/${week}`, {
          headers: { Cookie: cookieHeader(jar) },
        })
      ).json();

      // Every result carries the arithmetic that produced it.
      expect(results.results).toHaveLength(1);
      expect(results.results[0].explanation.length).toBeGreaterThan(0);
      expect(results.results[0].status).toBe('provisional');
    }
  });

  it('resolves winners to names, not member IDs', async () => {
    const { jar, auth } = await seededLeague();
    verifyCapabilities();

    await app.request('/api/challenges/2026/bench-mob', {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ status: 'active' }),
    });
    await app.request('/api/challenges/2026/calculate/3', { method: 'POST', headers: auth });

    const results = await (
      await app.request('/api/challenges/2026/results/3', {
        headers: { Cookie: cookieHeader(jar) },
      })
    ).json();

    const benchMob = results.results.find(
      (result: { challengeSlug: string }) => result.challengeSlug === 'bench-mob',
    );

    expect(benchMob.winners).toHaveLength(1);
    // A 26-character ULID would be no use to a reader.
    expect(benchMob.winners[0].displayName).toMatch(/^Manager \d+$/);
    expect(results.members.length).toBeGreaterThan(0);
  });

  /**
   * The regression case: a capability is withdrawn AFTER a challenge was activated.
   *
   * The stored status still says active. If calculation trusted that, the portal
   * would keep producing winners from data nobody has verified — and the number
   * would look exactly as authoritative as a real one.
   */
  it('stops calculating an active challenge if its capability is withdrawn', async () => {
    const { auth } = await seededLeague();
    verifyCapabilities();

    await app.request('/api/challenges/2026/bench-mob', {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ status: 'active' }),
    });

    const before = await (
      await app.request('/api/challenges/2026/calculate/3', { method: 'POST', headers: auth })
    ).json();
    expect(before.calculated).toHaveLength(1);

    // Yahoo changes, or a resource is marked failed in the matrix.
    setCapabilityMatrix({ ...MATRIX, verifiedCapabilities: [] });

    const after = await (
      await app.request('/api/challenges/2026/calculate/4', { method: 'POST', headers: auth })
    ).json();

    expect(after.calculated).toEqual([]);
    expect(after.blocked.some((entry: { slug: string }) => entry.slug === 'bench-mob')).toBe(true);
  });

  it('finalizes a provisional result and then refuses to finalize it twice', async () => {
    const { auth } = await seededLeague();
    verifyCapabilities();

    await app.request('/api/challenges/2026/bench-mob', {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ status: 'active' }),
    });
    await app.request('/api/challenges/2026/calculate/3', { method: 'POST', headers: auth });

    const first = await app.request('/api/challenges/2026/finalize/3/bench-mob', {
      method: 'POST',
      headers: auth,
    });
    expect(first.status).toBe(200);

    // Finalizing an already-final result is not a no-op to hide; it is a mistake.
    const second = await app.request('/api/challenges/2026/finalize/3/bench-mob', {
      method: 'POST',
      headers: auth,
    });
    expect(second.status).toBeGreaterThanOrEqual(400);
  });

  it('requires a reason to override, and keeps the computed outcome', async () => {
    const { jar, auth } = await seededLeague();
    verifyCapabilities();

    await app.request('/api/challenges/2026/bench-mob', {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ status: 'active' }),
    });
    await app.request('/api/challenges/2026/calculate/3', { method: 'POST', headers: auth });

    const before = await (
      await app.request('/api/challenges/2026/results/3', {
        headers: { Cookie: cookieHeader(jar) },
      })
    ).json();
    const original = before.results.find(
      (result: { challengeSlug: string }) => result.challengeSlug === 'bench-mob',
    );
    const originalExplanation: string = original.explanation;

    const members = before.members as Array<{ leagueMemberId: string }>;
    const someoneElse = members.find(
      (member) => member.leagueMemberId !== original.winningLeagueMemberIds[0],
    )!;

    // No reason: refused.
    const noReason = await app.request('/api/challenges/2026/override/3/bench-mob', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ winningLeagueMemberIds: [someoneElse.leagueMemberId], reason: '' }),
    });
    expect(noReason.status).toBeGreaterThanOrEqual(400);

    const withReason = await app.request('/api/challenges/2026/override/3/bench-mob', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        winningLeagueMemberIds: [someoneElse.leagueMemberId],
        reason: 'League voted to keep the announced winner after a stat correction.',
      }),
    });
    expect(withReason.status).toBe(200);

    const after = await (
      await app.request('/api/challenges/2026/results/3', {
        headers: { Cookie: cookieHeader(jar) },
      })
    ).json();
    const overridden = after.results.find(
      (result: { challengeSlug: string }) => result.challengeSlug === 'bench-mob',
    );

    expect(overridden.status).toBe('overridden');
    expect(overridden.winningLeagueMemberIds).toEqual([someoneElse.leagueMemberId]);
    // The arithmetic is appended to, never replaced.
    expect(overridden.explanation).toContain(originalExplanation);
    expect(overridden.explanation).toContain('League voted');
  });

  it('leaves an overridden result alone when the week is recalculated', async () => {
    const { jar, auth } = await seededLeague();
    verifyCapabilities();

    await app.request('/api/challenges/2026/bench-mob', {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ status: 'active' }),
    });
    await app.request('/api/challenges/2026/calculate/3', { method: 'POST', headers: auth });

    const before = await (
      await app.request('/api/challenges/2026/results/3', {
        headers: { Cookie: cookieHeader(jar) },
      })
    ).json();
    const target = before.members[0].leagueMemberId;

    await app.request('/api/challenges/2026/override/3/bench-mob', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        winningLeagueMemberIds: [target],
        reason: 'Commissioner decision, recorded.',
      }),
    });

    // Recalculating a week is routine after a stat correction. It must not quietly
    // undo a decision somebody made and announced.
    await app.request('/api/challenges/2026/calculate/3', { method: 'POST', headers: auth });

    const after = await (
      await app.request('/api/challenges/2026/results/3', {
        headers: { Cookie: cookieHeader(jar) },
      })
    ).json();
    const overridden = after.results.find(
      (result: { challengeSlug: string }) => result.challengeSlug === 'bench-mob',
    );

    expect(overridden.status).toBe('overridden');
    expect(overridden.winningLeagueMemberIds).toEqual([target]);
  });

  it('never persists a Yahoo player or team name when calculating', async () => {
    const { auth } = await seededLeague();
    verifyCapabilities();

    for (const slug of ['bench-mob', 'one-man-army', 'tight-end-day']) {
      await app.request(`/api/challenges/2026/${slug}`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ status: 'active' }),
      });
    }
    await app.request('/api/challenges/2026/calculate/3', { method: 'POST', headers: auth });

    /**
     * The explanation is the one place a player name legitimately reaches a durable
     * record — it is a derived sentence of arithmetic, and the persistence firewall
     * permits it by name. Everything else must be free of Yahoo strings.
     */
    const durable = table
      .all()
      .filter((item) => item['entity'] !== 'YahooCacheEntry')
      .map((item) => ({ ...item, explanation: undefined }));

    const serialized = JSON.stringify(durable);
    expect(serialized).not.toContain('Dovetail Dynasty');
    expect(serialized).not.toContain('mock_manager');
  });
});

describe('dues, prizes, tasks and announcements', () => {
  async function league(): Promise<{
    jar: Record<string, string>;
    auth: Record<string, string>;
    members: Array<{ leagueMemberId: string; displayName: string }>;
  }> {
    const jar = await signInAsCommissioner();
    const auth = {
      'Content-Type': 'application/json',
      Cookie: cookieHeader(jar),
      [CSRF_HEADER]: jar[CSRF_COOKIE]!,
    };

    await app.request('/api/yahoo/league-link', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        yahooLeagueKey: '999.l.100001',
        yahooGameKey: '999',
        seasonYear: 2026,
      }),
    });

    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      await app.request('/api/league/members', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ seasonYear: 2026, legacyManagerName: name }),
      });
    }

    const dues = await (
      await app.request('/api/dues/2026', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    return { jar, auth, members: dues.members };
  }

  it('derives dues status from the amounts rather than trusting a caller', async () => {
    // Status and money must never disagree: a row saying "paid" next to $40 of $75
    // is the kind of thing a league argues about for a season.
    const { jar, auth, members } = await league();

    const cases = [
      { paid: 0, expected: 'unpaid' },
      { paid: 4000, expected: 'partial' },
      { paid: 7500, expected: 'paid' },
    ];

    for (const [index, testCase] of cases.entries()) {
      await app.request('/api/dues/2026', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          leagueMemberId: members[index]!.leagueMemberId,
          amountOwed: { amountCents: 7500, currency: 'USD' },
          amountPaid: { amountCents: testCase.paid, currency: 'USD' },
          // Deliberately claims the wrong status; the API must not take its word.
          status: 'paid',
        }),
      });
    }

    const body = await (
      await app.request('/api/dues/2026', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    for (const [index, testCase] of cases.entries()) {
      const record = body.dues.find(
        (row: { leagueMemberId: string }) => row.leagueMemberId === members[index]!.leagueMemberId,
      );
      expect(record.status, `paid ${testCase.paid}`).toBe(testCase.expected);
    }

    expect(body.summary.totalOwedCents).toBe(22_500);
    expect(body.summary.totalPaidCents).toBe(11_500);
    expect(body.summary.unpaidCount).toBe(2);
  });

  /**
   * The update path, which is how dues are actually maintained.
   *
   * Someone pays half at the draft and the rest a fortnight later. That is an edit
   * to one row, not a second row — a ledger that grows a duplicate every time
   * somebody pays is worse than no ledger.
   */
  it('updates a dues record in place when a member pays the rest', async () => {
    const { jar, auth, members } = await league();

    const created = await app.request('/api/dues/2026', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        leagueMemberId: members[0]!.leagueMemberId,
        amountOwed: { amountCents: 7500, currency: 'USD' },
        amountPaid: { amountCents: 4000, currency: 'USD' },
        method: 'venmo',
      }),
    });
    expect(created.status).toBe(201);
    const duesRecordId = (await created.json()).dues.duesRecordId;

    const updated = await app.request('/api/dues/2026', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        duesRecordId,
        leagueMemberId: members[0]!.leagueMemberId,
        amountOwed: { amountCents: 7500, currency: 'USD' },
        amountPaid: { amountCents: 7500, currency: 'USD' },
        method: 'venmo',
      }),
    });
    // 200, not 201: this is the same row.
    expect(updated.status).toBe(200);

    const body = await (
      await app.request('/api/dues/2026', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    expect(body.dues).toHaveLength(1);
    expect(body.dues[0].duesRecordId).toBe(duesRecordId);
    expect(body.dues[0].status).toBe('paid');
    expect(body.summary.unpaidCount).toBe(0);
  });

  it('accepts a waiver, the one status the amounts cannot imply', async () => {
    const { jar, auth, members } = await league();

    const created = await app.request('/api/dues/2026', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        leagueMemberId: members[0]!.leagueMemberId,
        amountOwed: { amountCents: 7500, currency: 'USD' },
      }),
    });
    const duesRecordId = (await created.json()).dues.duesRecordId;

    await app.request('/api/dues/2026', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        duesRecordId,
        leagueMemberId: members[0]!.leagueMemberId,
        amountOwed: { amountCents: 7500, currency: 'USD' },
        status: 'waived',
        note: 'Ran draft night.',
      }),
    });

    const body = await (
      await app.request('/api/dues/2026', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    // Nothing was paid, and yet it is not outstanding. That is the whole point of
    // letting a decision override the arithmetic here and nowhere else.
    expect(body.dues[0].status).toBe('waived');
    expect(body.dues[0].amountPaid.amountCents).toBe(0);
    expect(body.summary.unpaidCount).toBe(0);
  });

  it('resolves dues and prizes to names, not member IDs', async () => {
    const { jar, auth, members } = await league();

    await app.request('/api/dues/2026', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        leagueMemberId: members[0]!.leagueMemberId,
        amountOwed: { amountCents: 7500, currency: 'USD' },
      }),
    });

    await app.request('/api/payouts/2026', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        leagueMemberId: members[0]!.leagueMemberId,
        reason: 'Week 1 Bench Mob',
        amount: { amountCents: 2500, currency: 'USD' },
      }),
    });

    const dues = await (
      await app.request('/api/dues/2026', { headers: { Cookie: cookieHeader(jar) } })
    ).json();
    const payouts = await (
      await app.request('/api/payouts/2026', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    expect(dues.dues[0].displayName).toBe('Alpha');
    expect(payouts.payouts[0].displayName).toBe('Alpha');
  });

  it('records prizes without processing any payment', async () => {
    const { jar, auth, members } = await league();

    await app.request('/api/payouts/2026', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        leagueMemberId: members[0]!.leagueMemberId,
        reason: 'Season champion',
        amount: { amountCents: 40_000, currency: 'USD' },
        status: 'paid',
        method: 'venmo',
      }),
    });

    const body = await (
      await app.request('/api/payouts/2026', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    // `method` is a description of what happened elsewhere, never an instruction.
    expect(body.payouts[0].method).toBe('venmo');
    expect(body.note).toContain('does not transfer money');
  });

  /**
   * The stat-correction chain, end to end.
   *
   * A prize is settled against a finalized result. Yahoo then corrects the stats so
   * the arithmetic produces a different winner. The engine must refuse to rewrite
   * the paid result, report the conflict, and put it in front of a person — because
   * the alternative is the portal quietly claiming someone won money they never got.
   */
  it('refuses to rewrite a paid result after a stat correction, and raises a task', async () => {
    const jar = await signInAsCommissioner();
    const auth = {
      'Content-Type': 'application/json',
      Cookie: cookieHeader(jar),
      [CSRF_HEADER]: jar[CSRF_COOKIE]!,
    };

    await app.request('/api/yahoo/league-link', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        yahooLeagueKey: '999.l.100001',
        yahooGameKey: '999',
        seasonYear: 2026,
      }),
    });

    const overview = await (
      await app.request('/api/league/overview', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    for (const [index, team] of overview.yahoo.teams.entries()) {
      await app.request('/api/league/members', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          seasonYear: 2026,
          yahooTeamKey: team.yahooTeamKey,
          legacyManagerName: `Manager ${index + 1}`,
        }),
      });
    }

    setCapabilityMatrix({
      ...MATRIX,
      verifiedCapabilities: [
        'roster_selected_position',
        'player_week_points',
        'player_position',
        'team_week_points',
        'matchup_result',
      ],
    });

    await app.request('/api/challenges/2026/seed', { method: 'POST', headers: auth });
    await app.request('/api/challenges/2026/bench-mob', {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ status: 'active' }),
    });
    await app.request('/api/challenges/2026/calculate/3', { method: 'POST', headers: auth });

    const results = await (
      await app.request('/api/challenges/2026/results/3', {
        headers: { Cookie: cookieHeader(jar) },
      })
    ).json();
    const result = results.results.find(
      (row: { challengeSlug: string }) => row.challengeSlug === 'bench-mob',
    );

    await app.request('/api/challenges/2026/finalize/3/bench-mob', {
      method: 'POST',
      headers: auth,
    });

    // The prize is handed over, referencing the result. This is what arms the lock.
    const payout = await app.request('/api/payouts/2026', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        leagueMemberId: result.winningLeagueMemberIds[0],
        reason: 'Week 3 Bench Mob',
        amount: { amountCents: 2500, currency: 'USD' },
        status: 'paid',
        week: 3,
        challengeResultId: result.challengeResultId,
      }),
    });
    expect(payout.status).toBe(201);

    const locked = await (
      await app.request('/api/challenges/2026/results/3', {
        headers: { Cookie: cookieHeader(jar) },
      })
    ).json();
    expect(
      locked.results.find((row: { challengeSlug: string }) => row.challengeSlug === 'bench-mob')
        .payoutSettled,
    ).toBe(true);

    /**
     * Simulates the correction by moving the stored winning value away from what the
     * fixtures produce. The fixtures are deterministic on purpose, so recalculating
     * them alone can never differ — the change has to come from the other side.
     */
    const stored = table
      .all()
      .find(
        (item) =>
          item['entity'] === 'WeeklyChallengeResult' && item['challengeSlug'] === 'bench-mob',
      )!;
    await table.put({ ...stored, winningValue: 999.9 });

    const recalculated = await (
      await app.request('/api/challenges/2026/calculate/3', { method: 'POST', headers: auth })
    ).json();

    expect(recalculated.conflicts?.length).toBeGreaterThan(0);
    expect(
      recalculated.conflicts.some((entry: { slug: string }) => entry.slug === 'bench-mob'),
    ).toBe(true);

    // The paid result is untouched.
    const after = await (
      await app.request('/api/challenges/2026/results/3', {
        headers: { Cookie: cookieHeader(jar) },
      })
    ).json();
    expect(
      after.results.find((row: { challengeSlug: string }) => row.challengeSlug === 'bench-mob')
        .winningValue,
    ).toBe(999.9);

    // And a person is told, on the task list they actually read.
    const tasks = await (
      await app.request('/api/tasks', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    const raised = tasks.tasks.find((task: { title: string }) =>
      task.title.includes('Stat correction changed a paid result'),
    );
    expect(raised).toBeDefined();
    expect(raised.priority).toBe('high');
  });

  it('creates and completes a commissioner task', async () => {
    const { jar, auth } = await league();

    const created = await app.request('/api/tasks', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ title: 'Chase unpaid dues', category: 'dues', priority: 'high' }),
    });
    expect(created.status).toBe(201);
    const taskId = (await created.json()).task.taskId;

    const done = await app.request(`/api/tasks/${taskId}`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ status: 'done' }),
    });
    expect(done.status).toBe(200);

    const body = await (
      await app.request('/api/tasks', { headers: { Cookie: cookieHeader(jar) } })
    ).json();
    expect(body.openCount).toBe(0);
    expect(body.tasks[0].status).toBe('done');
  });

  it('hides announcement drafts from members until published', async () => {
    // An unpublished announcement is not league communication yet.
    const { auth } = await league();

    await app.request('/api/announcements', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ title: 'Draft idea', body: 'Not ready', publish: false }),
    });
    await app.request('/api/announcements', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ title: 'Dues are due', body: 'Seventy five dollars', publish: true }),
    });

    const asCommissioner = await (
      await app.request('/api/announcements', {
        headers: { Cookie: cookieHeader(await signInAsCommissionerAgain()) },
      })
    ).json();
    expect(asCommissioner.announcements).toHaveLength(2);

    // Demote to a manager and look again.
    const user = table.ofEntity('PortalUser')[0]!;
    await table.put({ ...user, role: 'manager', isPrimaryCommissioner: false });

    const memberJar = await signIn();
    const asMember = await (
      await app.request('/api/announcements', { headers: { Cookie: cookieHeader(memberJar) } })
    ).json();

    expect(asMember.announcements).toHaveLength(1);
    expect(asMember.announcements[0].title).toBe('Dues are due');
  });

  /** The commissioner session is already bootstrapped, so reuse rather than re-run. */
  async function signInAsCommissionerAgain(): Promise<Record<string, string>> {
    return signIn();
  }
});

describe('prize rules', () => {
  async function league(): Promise<{
    jar: Record<string, string>;
    auth: Record<string, string>;
    members: Array<{ leagueMemberId: string; displayName: string }>;
  }> {
    const jar = await signInAsCommissioner();
    const auth = {
      'Content-Type': 'application/json',
      Cookie: cookieHeader(jar),
      [CSRF_HEADER]: jar[CSRF_COOKIE]!,
    };

    await app.request('/api/yahoo/league-link', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        yahooLeagueKey: '999.l.100001',
        yahooGameKey: '999',
        seasonYear: 2026,
      }),
    });

    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      await app.request('/api/league/members', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ seasonYear: 2026, legacyManagerName: name }),
      });
    }

    const dues = await (
      await app.request('/api/dues/2026', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    return { jar, auth, members: dues.members };
  }

  it('stores what a prize is worth', async () => {
    const { jar, auth } = await league();

    const created = await app.request('/api/prize-rules/2026', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        name: 'Weekly challenge',
        kind: 'weekly_challenge',
        amount: { amountCents: 2500, currency: 'USD' },
        perWeek: true,
      }),
    });
    expect(created.status).toBe(201);

    const body = await (
      await app.request('/api/prize-rules/2026', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    expect(body.rules).toHaveLength(1);
    expect(body.rules[0].amount.amountCents).toBe(2500);
    expect(body.rules[0].perWeek).toBe(true);
    expect(body.note).toContain('No money is held or moved');
  });

  it('refuses a rule that is both a fixed amount and a share of the pool', async () => {
    // Ambiguous about what it pays, which is the one thing a rule exists to answer.
    const { auth } = await league();

    const both = await app.request('/api/prize-rules/2026', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        name: 'Champion',
        kind: 'champion',
        amount: { amountCents: 20_000, currency: 'USD' },
        poolPercentage: 50,
      }),
    });
    expect(both.status).toBeGreaterThanOrEqual(400);

    const neither = await app.request('/api/prize-rules/2026', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'Champion', kind: 'champion' }),
    });
    expect(neither.status).toBeGreaterThanOrEqual(400);
  });

  it('updates a rule in place rather than adding a second one', async () => {
    const { jar, auth } = await league();

    const created = await app.request('/api/prize-rules/2026', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        name: 'Weekly challenge',
        kind: 'weekly_challenge',
        amount: { amountCents: 2500, currency: 'USD' },
      }),
    });
    const prizeRuleId = (await created.json()).rule.prizeRuleId;

    const updated = await app.request('/api/prize-rules/2026', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        prizeRuleId,
        name: 'Weekly challenge',
        kind: 'weekly_challenge',
        amount: { amountCents: 3000, currency: 'USD' },
      }),
    });
    expect(updated.status).toBe(200);

    const body = await (
      await app.request('/api/prize-rules/2026', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    expect(body.rules).toHaveLength(1);
    expect(body.rules[0].amount.amountCents).toBe(3000);
  });

  /**
   * A prize recorded from a rule carries both links and is not yet settled.
   *
   * The result link is what arms the stat-correction protection; the rule link is
   * how a future commissioner sees where the number came from. Creating it unpaid
   * keeps handing the money over a separate, deliberate act — the portal records a
   * decision, it does not make one.
   */
  it('records a prize against a result without settling it', async () => {
    const { jar, auth, members } = await league();

    const rule = await app.request('/api/prize-rules/2026', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        name: 'Weekly challenge',
        kind: 'weekly_challenge',
        amount: { amountCents: 2500, currency: 'USD' },
        perWeek: true,
      }),
    });
    const prizeRuleId = (await rule.json()).rule.prizeRuleId;

    const created = await app.request('/api/payouts/2026', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        leagueMemberId: members[0]!.leagueMemberId,
        reason: 'Week 3 Bench Mob',
        amount: { amountCents: 2500, currency: 'USD' },
        status: 'unpaid',
        week: 3,
        prizeRuleId,
      }),
    });
    expect(created.status).toBe(201);

    const body = await (
      await app.request('/api/payouts/2026', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    expect(body.payouts[0].prizeRuleId).toBe(prizeRuleId);
    expect(body.payouts[0].status).toBe('unpaid');
    // Unpaid means nothing is locked yet, and nothing has been handed over.
    expect(body.summary.pendingCount).toBe(1);
  });

  /**
   * A shared prize must still add up to the rule.
   *
   * $25 across three winners is 8.33 each, which is 24.99 — a cent has to land
   * somewhere, and money quietly disappearing to rounding is exactly the kind of
   * thing a league notices a season later and cannot explain.
   */
  it('splits a shared prize without losing a cent', async () => {
    const { jar, auth, members } = await league();

    const total = 2500;
    const count = members.length;
    const base = Math.floor(total / count);
    const shares = members.map((_, index) => (index === 0 ? base + (total - base * count) : base));

    for (const [index, member] of members.entries()) {
      await app.request('/api/payouts/2026', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          leagueMemberId: member.leagueMemberId,
          reason: 'Week 3 Photo Finish (shared)',
          amount: { amountCents: shares[index]!, currency: 'USD' },
          status: 'unpaid',
          week: 3,
        }),
      });
    }

    const body = await (
      await app.request('/api/payouts/2026', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    expect(body.summary.totalCents).toBe(total);
    // The odd cent goes to exactly one winner, not to all of them.
    expect(shares.filter((share) => share !== base)).toHaveLength(1);
  });
});

describe('weekly recaps', () => {
  async function linkedLeague(): Promise<{
    jar: Record<string, string>;
    auth: Record<string, string>;
  }> {
    const jar = await signInAsCommissioner();
    const auth = {
      'Content-Type': 'application/json',
      Cookie: cookieHeader(jar),
      [CSRF_HEADER]: jar[CSRF_COOKIE]!,
    };

    await app.request('/api/yahoo/league-link', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        yahooLeagueKey: '999.l.100001',
        yahooGameKey: '999',
        seasonYear: 2026,
      }),
    });

    return { jar, auth };
  }

  /**
   * The fact pack is the whole design: every number in a recap is computed here, in
   * code, and a model — when one is used at all — is given only the finished list.
   * A recap with no facts would mean the prose had nothing to be accountable to.
   */
  it('drafts a recap whose facts are computed, not written', async () => {
    const { jar, auth } = await linkedLeague();

    const drafted = await app.request('/api/recaps/2026/2/draft', {
      method: 'POST',
      headers: auth,
    });
    expect(drafted.status).toBe(200);

    const recap = (await drafted.json()).recap;
    expect(recap.facts.length).toBeGreaterThan(0);
    expect(recap.templateBody).toContain('Week 2');

    // Never published by drafting, whether a person or a schedule asked for it.
    expect(recap.status).toBe('draft');

    const listed = await (
      await app.request('/api/recaps/2026', { headers: { Cookie: cookieHeader(jar) } })
    ).json();
    expect(listed.recaps).toHaveLength(1);
    expect(listed.note).toContain('Nothing is emailed');
  });

  it('produces a readable recap with no model involved', async () => {
    // No ANTHROPIC_API_KEY in the test environment, so this is the no-prose path —
    // which must still yield a complete recap rather than an empty one.
    const { auth } = await linkedLeague();

    const drafted = await app.request('/api/recaps/2026/2/draft', {
      method: 'POST',
      headers: auth,
    });
    const recap = (await drafted.json()).recap;

    expect(recap.proseBody).toBeNull();
    expect(recap.templateBody.length).toBeGreaterThan(20);
  });

  it('hides drafts from members until they are published', async () => {
    const { auth } = await linkedLeague();
    await app.request('/api/recaps/2026/2/draft', { method: 'POST', headers: auth });

    // Demote and look again: an unreviewed recap is not league communication, and
    // prose nobody has read is exactly what not to show by accident.
    const user = table.ofEntity('PortalUser')[0]!;
    await table.put({ ...user, role: 'manager', isPrimaryCommissioner: false });

    const memberJar = await signIn();
    const asMember = await (
      await app.request('/api/recaps/2026', { headers: { Cookie: cookieHeader(memberJar) } })
    ).json();

    expect(asMember.recaps).toHaveLength(0);
  });

  it('publishes the reviewed text, not the draft it started from', async () => {
    const { jar, auth } = await linkedLeague();
    await app.request('/api/recaps/2026/2/draft', { method: 'POST', headers: auth });

    const published = await app.request('/api/recaps/2026/2/publish', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ body: 'A commissioner rewrote this bit.', publish: true }),
    });
    expect(published.status).toBe(200);

    const listed = await (
      await app.request('/api/recaps/2026', { headers: { Cookie: cookieHeader(jar) } })
    ).json();

    expect(listed.recaps[0].status).toBe('published');
    expect(listed.recaps[0].proseBody).toBe('A commissioner rewrote this bit.');
  });

  it('refuses to redraft over something the league has already read', async () => {
    const { auth } = await linkedLeague();
    await app.request('/api/recaps/2026/2/draft', { method: 'POST', headers: auth });
    await app.request('/api/recaps/2026/2/publish', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ publish: true }),
    });

    const again = await app.request('/api/recaps/2026/2/draft', { method: 'POST', headers: auth });

    expect(again.status).toBe(409);
    expect((await again.json()).error.message).toContain('already published');
  });

  it('lets a commissioner take a recap back to draft', async () => {
    const { jar, auth } = await linkedLeague();
    await app.request('/api/recaps/2026/2/draft', { method: 'POST', headers: auth });
    await app.request('/api/recaps/2026/2/publish', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ publish: true }),
    });

    await app.request('/api/recaps/2026/2/publish', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ publish: false }),
    });

    const listed = await (
      await app.request('/api/recaps/2026', { headers: { Cookie: cookieHeader(jar) } })
    ).json();
    expect(listed.recaps[0].status).toBe('draft');
  });

  it('never persists a Yahoo team name outside the recap facts', async () => {
    const { auth } = await linkedLeague();
    await app.request('/api/recaps/2026/2/draft', { method: 'POST', headers: auth });

    /**
     * A recap fact is a derived label — "Highest score: Dovetail Dynasty, 141.8" —
     * which the retention rules permit, and which is what lets a 2019 recap still
     * read correctly. Nothing ELSE durable may carry a Yahoo name.
     */
    const durable = table
      .all()
      .filter((item) => item['entity'] !== 'YahooCacheEntry' && item['entity'] !== 'LeagueRecap');

    expect(JSON.stringify(durable)).not.toContain('Dovetail Dynasty');
  });
});

describe('break-glass sign-in', () => {
  const TOKEN = 'a-token-long-enough-to-pass-validation';

  /**
   * A second authentication path earns close tests, because its guards are the only
   * thing keeping it from being a permanent bypass of Yahoo sign-in.
   */
  function appWith(overrides: Record<string, string | undefined>) {
    const base = config();
    const env = loadServerEnv({
      NODE_ENV: 'test',
      YAHOO_CLIENT_ID: 'replace-me',
      YAHOO_CLIENT_SECRET: 'replace-me',
      YAHOO_REDIRECT_URI: 'https://localhost:5173/auth/yahoo/callback',
      YAHOO_MODE: 'live',
      APP_BASE_URL: 'https://localhost:5173',
      AWS_REGION: 'us-east-1',
      DYNAMODB_TABLE_NAME: 'test',
      SESSION_SECRET: KEY,
      TOKEN_ENCRYPTION_KEY: KEY,
      ...overrides,
    });

    return createApp({
      config: { ...base, env },
      table: table.asTable(),
      fetchImpl: mockFetch,
      logger: createLogger({ correlationId: 'test', sink: () => {} }),
    });
  }

  it('does not exist when no token is configured', async () => {
    // The default for every normal deployment. Absent rather than refused, so probing
    // cannot tell a disabled route from one that was never built.
    const disabled = appWith({});

    const response = await disabled.request('/auth/break-glass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });

    expect(response.status).toBe(404);
  });

  it('refuses once Yahoo is configured, even with the right token', async () => {
    /**
     * The guarantee that matters most. Deleting the route is the tidy-up, but until
     * then this is what stops it becoming a permanent way around Yahoo sign-in.
     */
    const live = appWith({
      BREAK_GLASS_TOKEN: TOKEN,
      YAHOO_CLIENT_ID: 'a-real-client-id',
      YAHOO_CLIENT_SECRET: 'a-real-secret',
    });

    const response = await live.request('/auth/break-glass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });

    expect(response.status).toBe(404);
  });

  it('refuses a wrong token and records the attempt', async () => {
    const enabled = appWith({ BREAK_GLASS_TOKEN: TOKEN });

    const response = await enabled.request('/auth/break-glass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'not-the-right-token-but-long-enough' }),
    });

    expect(response.status).toBe(401);

    // A failed attempt here is one of the few genuinely interesting security events
    // this application can produce, so it must not pass silently.
    const refusal = table
      .all()
      .find(
        (item) =>
          item['entity'] === 'AuditLog' && String(item['summary']).includes('REFUSED'),
      );
    expect(refusal).toBeDefined();
  });

  it('signs in one commissioner and issues a short session', async () => {
    const enabled = appWith({ BREAK_GLASS_TOKEN: TOKEN });

    const response = await enabled.request('/auth/break-glass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });

    expect(response.status).toBe(200);

    const body = await response.json();
    // Two hours: enough to set a season up, not enough to become how the league runs.
    expect(body.expiresInSeconds).toBe(7200);

    const users = table.ofEntity('PortalUser');
    expect(users).toHaveLength(1);
    expect(users[0]!['role']).toBe('commissioner');
    // Never a Yahoo GUID, so the real account stays visibly separate later.
    expect(users[0]!['yahooGuid']).toBe('break-glass-commissioner');

    // The session cookie must actually work.
    const jar: Record<string, string> = {};
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const index = pair!.indexOf('=');
      jar[pair!.slice(0, index)] = decodeURIComponent(pair!.slice(index + 1));
    }

    const session = await enabled.request('/api/session', {
      headers: { Cookie: cookieHeader(jar) },
    });
    expect((await session.json()).authenticated).toBe(true);
  });

  it('reuses the same account rather than creating one per sign-in', async () => {
    const enabled = appWith({ BREAK_GLASS_TOKEN: TOKEN });

    for (let i = 0; i < 3; i += 1) {
      await enabled.request('/auth/break-glass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN }),
      });
    }

    expect(table.ofEntity('PortalUser')).toHaveLength(1);
  });
});

describe('CSV import', () => {
  it('previews without writing, and reports what would happen', async () => {
    const jar = await signInAsCommissioner();

    const response = await app.request('/api/imports/dry-run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        [CSRF_HEADER]: jar[CSRF_COOKIE]!,
      },
      body: JSON.stringify({
        kind: 'seasons',
        fileName: 'seasons.csv',
        csvText: 'season,buy_in,team_count\n2019,$50.00,12\n2020,$60.00,12\n',
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.summary.wouldCreate).toBe(2);
    expect(body.summary.errorRows).toBe(0);
    expect(body.canCommit).toBe(true);
    expect(body.note).toContain('Nothing has been written');
    // No Season entities yet — the preview really is read-only.
    expect(table.ofEntity('Season')).toHaveLength(0);
  });

  it('commits only the file that was previewed', async () => {
    const jar = await signInAsCommissioner();
    const auth = {
      'Content-Type': 'application/json',
      Cookie: cookieHeader(jar),
      [CSRF_HEADER]: jar[CSRF_COOKIE]!,
    };
    const csvText = 'season,buy_in,team_count\n2019,$50.00,12\n';

    const dryRun = await app.request('/api/imports/dry-run', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ kind: 'seasons', fileName: 'seasons.csv', csvText }),
    });
    const { importBatchId } = await dryRun.json();

    // A different file must be refused: committing content that was not reviewed
    // would defeat the purpose of the preview.
    const wrongFile = await app.request(`/api/imports/${importBatchId}/commit`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        csvText: 'season,buy_in,team_count\n2019,$999.00,12\n',
        conflictResolution: 'fail_on_conflict',
      }),
    });
    expect(wrongFile.status).toBe(412);

    const commit = await app.request(`/api/imports/${importBatchId}/commit`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ csvText, conflictResolution: 'fail_on_conflict' }),
    });

    expect(commit.status).toBe(200);
    const body = await commit.json();
    expect(body.created).toBe(1);
    expect(table.ofEntity('Season')).toHaveLength(1);
  });

  it('re-importing the same file changes nothing', async () => {
    const jar = await signInAsCommissioner();
    const auth = {
      'Content-Type': 'application/json',
      Cookie: cookieHeader(jar),
      [CSRF_HEADER]: jar[CSRF_COOKIE]!,
    };
    const csvText =
      'effective_season,category,title,rule\n2019,trades,Deadline,No trades after week 11\n';

    for (const expected of [1, 0]) {
      const dryRun = await app.request('/api/imports/dry-run', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ kind: 'league_rules', fileName: 'rules.csv', csvText }),
      });
      const { importBatchId } = await dryRun.json();

      const commit = await app.request(`/api/imports/${importBatchId}/commit`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ csvText, conflictResolution: 'fail_on_conflict' }),
      });

      // Second pass creates nothing: matched on external key and skipped.
      expect((await commit.json()).created).toBe(expected);
    }

    expect(table.ofEntity('LeagueRule')).toHaveLength(1);
  });

  it('serves a downloadable template with an example row', async () => {
    const jar = await signInAsCommissioner();

    const response = await app.request('/api/imports/templates/dues', {
      headers: { Cookie: cookieHeader(jar) },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/csv');
    const csv = await response.text();
    expect(csv.split(/\r?\n/).filter((line) => line.length > 0)).toHaveLength(2);
  });

  it('refuses imports to a non-commissioner', async () => {
    await signInAsCommissioner();
    const user = table.ofEntity('PortalUser')[0]!;
    await table.put({ ...user, role: 'manager', isPrimaryCommissioner: false });

    const jar = await signIn();
    const response = await app.request('/api/imports/templates', {
      headers: { Cookie: cookieHeader(jar) },
    });

    expect(response.status).toBe(403);
  });
});

describe('sign out', () => {
  it('revokes the session immediately', async () => {
    const jar = await signInAsCommissioner();

    const signOut = await app.request('/api/session/signout', {
      method: 'POST',
      headers: { Cookie: cookieHeader(jar), [CSRF_HEADER]: jar[CSRF_COOKIE]! },
    });
    expect(signOut.status).toBe(200);

    // Not merely expired client-side: the server record is gone.
    const after = await app.request('/api/session', { headers: { Cookie: cookieHeader(jar) } });
    expect((await after.json()).authenticated).toBe(false);
  });
});

describe('error responses', () => {
  it('returns a stable code and a safe message', async () => {
    const response = await app.request('/api/audit');
    const body = await response.json();

    expect(body.error.code).toBe('unauthenticated');
    expect(body.error.message).toBe('Sign in to continue.');
    // No stack trace, no internal detail.
    expect(body).not.toHaveProperty('stack');
    expect(JSON.stringify(body)).not.toContain('at ');
  });

  it('404s an unknown endpoint', async () => {
    const response = await app.request('/api/does-not-exist');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});

describe('manager-facing league views', () => {
  /** Signs in, bootstraps, and links the mock league. */
  async function linkedCommissioner(): Promise<Record<string, string>> {
    const jar = await signInAsCommissioner();
    await app.request('/api/yahoo/league-link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        [CSRF_HEADER]: jar[CSRF_COOKIE]!,
      },
      body: JSON.stringify({
        yahooLeagueKey: '999.l.100001',
        yahooGameKey: '999',
        seasonYear: 2026,
      }),
    });
    return jar;
  }

  it('serves standings with records and points', async () => {
    const jar = await linkedCommissioner();

    const response = await app.request('/api/league/standings', {
      headers: { Cookie: cookieHeader(jar) },
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.standings).toHaveLength(12);
    expect(body.standings[0].rank).toBe(1);
    expect(body.standings[0].record).toMatch(/^\d+-\d+$/);
    expect(body.standings[0].pointsFor).toBeTypeOf('number');
  });

  it('marks the signed-in user’s own row without any manual mapping', async () => {
    // Yahoo's is_current_login is what makes this work, so a member sees "you"
    // before a commissioner has mapped any teams.
    const jar = await linkedCommissioner();

    const response = await app.request('/api/league/standings', {
      headers: { Cookie: cookieHeader(jar) },
    });
    const body = await response.json();

    expect(body.standings.filter((row: { isYou: boolean }) => row.isYou)).toHaveLength(1);
  });

  it('serves a week of matchups with scores and a margin', async () => {
    const jar = await linkedCommissioner();

    const response = await app.request('/api/league/matchups/3', {
      headers: { Cookie: cookieHeader(jar) },
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.week).toBe(3);
    expect(body.matchups).toHaveLength(6);
    expect(body.matchups[0].teams).toHaveLength(2);
    expect(body.matchups[0].teams[0].points).toBeTypeOf('number');
    expect(body.matchups[0].margin).toBeTypeOf('number');
    expect(body.matchups.filter((m: { involvesYou: boolean }) => m.involvesYou)).toHaveLength(1);
  });

  it('summarises the home screen in a single request', async () => {
    const jar = await linkedCommissioner();

    const response = await app.request('/api/league/me', {
      headers: { Cookie: cookieHeader(jar) },
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.linked).toBe(true);
    expect(body.week).toBe(3);
    // The three things a manager opens the app for.
    expect(body.you.record).toMatch(/^\d+-\d+$/);
    expect(body.matchup.you.points).toBeTypeOf('number');
    expect(body.matchup.opponent.points).toBeTypeOf('number');
    expect(body.leaders).toHaveLength(3);
    expect(body.highestScore.points).toBeTypeOf('number');
    expect(body.closestMatchup.margin).toBeTypeOf('number');
  });

  it('reports not linked rather than erroring before a league is chosen', async () => {
    const jar = await signInAsCommissioner();

    const response = await app.request('/api/league/me', {
      headers: { Cookie: cookieHeader(jar) },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ linked: false });
  });

  it('explains itself when standings are requested with no league linked', async () => {
    const jar = await signInAsCommissioner();

    const response = await app.request('/api/league/standings', {
      headers: { Cookie: cookieHeader(jar) },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'yahoo_league_not_linked' } });
  });

  it('serves the roster split into starters and bench', async () => {
    const jar = await linkedCommissioner();

    const response = await app.request('/api/league/roster?week=3', {
      headers: { Cookie: cookieHeader(jar) },
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.week).toBe(3);
    expect(body.team.isYou).toBe(true);
    expect(body.slots.length).toBeGreaterThan(0);

    // Both groups must be non-empty, or the bench total below means nothing.
    const starters = body.slots.filter((slot: { isStarter: boolean }) => slot.isStarter);
    const bench = body.slots.filter((slot: { isStarter: boolean }) => !slot.isStarter);
    expect(starters.length).toBeGreaterThan(0);
    expect(bench.length).toBeGreaterThan(0);

    // 'BN' must never count as a starter — that is the whole Bench Mob distinction.
    expect(
      starters.some((slot: { selectedPosition: string }) => slot.selectedPosition === 'BN'),
    ).toBe(false);
  });

  it('totals starter and bench points separately', async () => {
    const jar = await linkedCommissioner();

    const response = await app.request('/api/league/roster?week=3', {
      headers: { Cookie: cookieHeader(jar) },
    });
    const body = await response.json();

    expect(body.startersPoints).toBeTypeOf('number');
    expect(body.benchPoints).toBeTypeOf('number');
    // Rounded to a tenth, like every other score in the portal.
    expect(body.benchPoints).toBe(Math.round(body.benchPoints * 10) / 10);
  });

  it('resolves the current week when none is given', async () => {
    const jar = await linkedCommissioner();

    const response = await app.request('/api/league/roster', {
      headers: { Cookie: cookieHeader(jar) },
    });

    expect(response.status).toBe(200);
    expect((await response.json()).week).toBeTypeOf('number');
  });

  it('reads another team’s roster when one is named', async () => {
    // A matchup preview needs the opponent's lineup, not only your own.
    const jar = await linkedCommissioner();

    const teams = await app.request('/api/league/standings', {
      headers: { Cookie: cookieHeader(jar) },
    });
    const other = (await teams.json()).standings.find((row: { isYou: boolean }) => !row.isYou);

    const response = await app.request(
      `/api/league/roster?week=3&team=${encodeURIComponent(other.yahooTeamKey)}`,
      { headers: { Cookie: cookieHeader(jar) } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.team.yahooTeamKey).toBe(other.yahooTeamKey);
    expect(body.team.isYou).toBe(false);
  });

  it('serves transactions with readable endpoints', async () => {
    const jar = await linkedCommissioner();

    const response = await app.request('/api/league/transactions', {
      headers: { Cookie: cookieHeader(jar) },
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.transactions.length).toBeGreaterThan(0);
    const [first] = body.transactions;
    expect(first.type).toBeTruthy();
    expect(first.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first.players[0].name).toBeTruthy();

    // Team keys are resolved to names here; a bare key would be meaningless.
    const named = body.transactions
      .flatMap(
        (transaction: { players: Array<{ destinationTeamName: string | null }> }) =>
          transaction.players,
      )
      .filter((player: { destinationTeamName: string | null }) => player.destinationTeamName);
    expect(named.length).toBeGreaterThan(0);
  });

  it('flags the transactions involving the signed-in user’s team', async () => {
    const jar = await linkedCommissioner();

    const response = await app.request('/api/league/transactions', {
      headers: { Cookie: cookieHeader(jar) },
    });
    const body = await response.json();

    expect(
      body.transactions.some((transaction: { involvesYou: boolean }) => transaction.involvesYou),
    ).toBe(true);
  });

  it('explains itself when transactions are requested with no league linked', async () => {
    const jar = await signInAsCommissioner();

    const response = await app.request('/api/league/transactions', {
      headers: { Cookie: cookieHeader(jar) },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'yahoo_league_not_linked' } });
  });

  it('is available to any member, not just commissioners', async () => {
    // League information is not administration. A manager must be able to read
    // standings and matchups.
    await linkedCommissioner();
    const user = table.ofEntity('PortalUser')[0]!;
    await table.put({ ...user, role: 'manager', isPrimaryCommissioner: false });

    const jar = await signIn();
    for (const path of [
      '/api/league/standings',
      '/api/league/matchups/3',
      '/api/league/me',
      '/api/league/roster',
      '/api/league/transactions',
    ]) {
      const response = await app.request(path, { headers: { Cookie: cookieHeader(jar) } });
      expect(response.status, path).toBe(200);
    }
  });

  it('never persists Yahoo names from these reads', async () => {
    const jar = await linkedCommissioner();
    for (const path of [
      '/api/league/standings',
      '/api/league/matchups/3',
      '/api/league/me',
      '/api/league/roster?week=3',
      '/api/league/transactions',
    ]) {
      await app.request(path, { headers: { Cookie: cookieHeader(jar) } });
    }

    const durable = table.all().filter((item) => item['entity'] !== 'YahooCacheEntry');
    const serialized = JSON.stringify(durable);

    expect(serialized).not.toContain('Dovetail Dynasty');
    // Player names arrive through the roster and transaction reads. They are
    // Yahoo's data too, and must not survive outside the TTL'd cache.
    expect(serialized).not.toContain('Mock Waiver Add');
    expect(serialized).not.toContain('Mock Player');
  });
});
