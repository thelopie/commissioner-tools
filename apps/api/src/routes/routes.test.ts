import { beforeEach, describe, expect, it } from 'vitest';
import { loadServerEnv } from '@dinkel/shared';
import { setCapabilityMatrix, type CapabilityMatrix, type FetchLike } from '@dinkel/yahoo-client';
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
    expect(url.searchParams.get('scope')).toBe('fspt-r');
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

    // Yahoo identifiers are stored separately from Dinkel's own IDs.
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

    // Two Dinkel members, mapped by hand as the commissioner would.
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
