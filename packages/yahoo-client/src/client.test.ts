import { describe, expect, it, vi } from 'vitest';
import type { AppError, YahooCapabilityKey } from '@dinkel/shared';
import {
  createTokenProvider,
  parseRetryAfter,
  YahooClient,
  YAHOO_FANTASY_BASE_URL,
  type RequestCompletion,
} from './client.js';
import type { FetchLike, TokenSet } from './oauth.js';
import {
  assertCapabilities,
  canPerformCommissionerActions,
  canWriteToYahoo,
  isCapabilityVerified,
  setCapabilityMatrix,
  unverifiedCapabilities,
  type CapabilityMatrix,
} from './capabilities.js';
import * as fixtures from './fixtures/synthetic.js';

interface StubResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  throws?: Error;
}

/** Queues responses so retry behavior is observable. */
function queueFetch(responses: StubResponse[]): {
  fetchImpl: FetchLike;
  urls: string[];
  headers: Array<Record<string, string>>;
} {
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  let index = 0;

  const fetchImpl: FetchLike = async (url, init) => {
    urls.push(url);
    headers.push(init.headers);
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;

    if (response.throws) throw response.throws;

    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      text: async () =>
        typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? {}),
      headers: { get: (name) => response.headers?.[name] ?? null },
    };
  };

  return { fetchImpl, urls, headers };
}

const noSleep = async (): Promise<void> => undefined;

function client(
  responses: StubResponse[],
  overrides: Partial<ConstructorParameters<typeof YahooClient>[0]> = {},
): { instance: YahooClient; urls: string[]; headers: Array<Record<string, string>> } {
  const { fetchImpl, urls, headers } = queueFetch(responses);
  const instance = new YahooClient({
    fetchImpl,
    getAccessToken: async () => 'access-token',
    sleep: noSleep,
    random: () => 0.5,
    ...overrides,
  });
  return { instance, urls, headers };
}

describe('YahooClient request handling', () => {
  it('sends a bearer token and requests JSON', async () => {
    const { instance, urls, headers } = client([{ status: 200, body: { fantasy_content: {} } }]);

    await instance.get('users;use_login=1');

    expect(urls[0]).toBe(`${YAHOO_FANTASY_BASE_URL}/users;use_login=1?format=json`);
    expect(headers[0]?.['Authorization']).toBe('Bearer access-token');
    expect(headers[0]?.['Accept']).toBe('application/json');
  });

  it('appends format=json, since Yahoo returns XML by default', async () => {
    const { instance, urls } = client([{ status: 200, body: { fantasy_content: {} } }]);
    await instance.get('league/999.l.1/settings');
    expect(urls[0]).toContain('?format=json');
  });

  it('targets the mock base URL when one is configured', async () => {
    const { instance, urls } = client([{ status: 200, body: { fantasy_content: {} } }], {
      baseUrl: 'http://localhost:4310/fantasy/v2/',
    });

    await instance.get('users;use_login=1');
    // Trailing slash normalized, so no double slash reaches the server.
    expect(urls[0]).toBe('http://localhost:4310/fantasy/v2/users;use_login=1?format=json');
  });
});

describe('YahooClient retry behavior', () => {
  it('retries a 500 and succeeds on a later attempt', async () => {
    const { instance, urls } = client([
      { status: 500 },
      { status: 200, body: { fantasy_content: { ok: true } } },
    ]);

    await expect(instance.get('league/999.l.1')).resolves.toEqual({
      fantasy_content: { ok: true },
    });
    expect(urls).toHaveLength(2);
  });

  it('retries a 429, because Yahoo publishes no rate limit to stay under', async () => {
    const { instance, urls } = client([
      { status: 429 },
      { status: 200, body: { fantasy_content: {} } },
    ]);

    await instance.get('league/999.l.1');
    expect(urls).toHaveLength(2);
  });

  it('retries a network failure', async () => {
    const { instance, urls } = client([
      { status: 0, throws: new Error('ECONNRESET') },
      { status: 200, body: { fantasy_content: {} } },
    ]);

    await instance.get('league/999.l.1');
    expect(urls).toHaveLength(2);
  });

  it('gives up after maxAttempts and reports rate limiting', async () => {
    const { instance, urls } = client([{ status: 429 }], { maxAttempts: 3 });

    await expect(instance.get('league/999.l.1')).rejects.toThrow(
      expect.objectContaining({ code: 'yahoo_rate_limited' }),
    );
    expect(urls).toHaveLength(3);
  });

  it('does not retry a 401, which means the grant is gone rather than flaky', async () => {
    const { instance, urls } = client([{ status: 401 }]);

    await expect(instance.get('league/999.l.1')).rejects.toThrow(
      expect.objectContaining({ code: 'yahoo_needs_reconnect' }),
    );
    // Retrying a dead grant would just burn requests against a rate-limited API.
    expect(urls).toHaveLength(1);
  });

  it('does not retry a 403 or 404', async () => {
    for (const [status, code] of [
      [403, 'forbidden'],
      [404, 'not_found'],
    ] as const) {
      const { instance, urls } = client([{ status }]);
      await expect(instance.get('league/999.l.1')).rejects.toThrow(
        expect.objectContaining({ code }),
      );
      expect(urls).toHaveLength(1);
    }
  });

  it('honours Retry-After ahead of its own backoff', async () => {
    const sleeps: number[] = [];
    const { instance } = client(
      [
        { status: 429, headers: { 'Retry-After': '7' } },
        { status: 200, body: { fantasy_content: {} } },
      ],
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    await instance.get('league/999.l.1');
    expect(sleeps).toEqual([7000]);
  });

  it('caps a hostile Retry-After so a request cannot hang for an hour', async () => {
    const sleeps: number[] = [];
    const { instance } = client(
      [
        { status: 503, headers: { 'Retry-After': '3600' } },
        { status: 200, body: { fantasy_content: {} } },
      ],
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    await instance.get('league/999.l.1');
    expect(sleeps).toEqual([30_000]);
  });

  it('backs off with jitter, so parallel Lambdas do not re-collide', async () => {
    const sleeps: number[] = [];
    const { instance } = client([{ status: 500 }], {
      maxAttempts: 4,
      random: () => 1,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(instance.get('league/999.l.1')).rejects.toThrow();
    // Ceiling doubles per attempt; jitter scales it rather than adding a constant.
    expect(sleeps).toEqual([1100, 2100, 4100]);
  });

  it('rejects a non-JSON success response', async () => {
    const { instance } = client([{ status: 200, body: '<html>maintenance</html>' }]);

    await expect(instance.get('league/999.l.1')).rejects.toThrow(
      expect.objectContaining({ code: 'yahoo_unexpected_response' }),
    );
  });

  it('reports completion for observability, including attempt count', async () => {
    const events: RequestCompletion[] = [];
    const { instance } = client([{ status: 500 }, { status: 200, body: { fantasy_content: {} } }], {
      onRequestComplete: (event) => events.push(event),
    });

    await instance.get('league/999.l.1');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ path: 'league/999.l.1', ok: true, attempts: 2, status: 200 });
  });

  it('reports failures with an error code and no leaked detail', async () => {
    const events: RequestCompletion[] = [];
    const { instance } = client([{ status: 401 }], {
      onRequestComplete: (event) => events.push(event),
    });

    await expect(instance.get('league/999.l.1')).rejects.toThrow();
    expect(events[0]).toMatchObject({ ok: false, errorCode: 'yahoo_needs_reconnect' });
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('120')).toBe(120);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('reads an HTTP date', () => {
    const now = Date.parse('2026-07-26T12:00:00Z');
    expect(parseRetryAfter('Sun, 26 Jul 2026 12:00:30 GMT', now)).toBe(30);
  });

  it('never returns a negative wait for a date in the past', () => {
    const now = Date.parse('2026-07-26T12:00:00Z');
    expect(parseRetryAfter('Sun, 26 Jul 2026 11:00:00 GMT', now)).toBe(0);
  });

  it('returns null for absent or unparseable values', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});

describe('YahooClient resources', () => {
  it('reads the signed-in user leagues from the documented resource chain', async () => {
    const { instance, urls } = client([{ status: 200, body: fixtures.mockUserLeaguesResponse() }]);

    const leagues = await instance.getUserFootballLeagues();

    expect(urls[0]).toContain('users;use_login=1/games;game_codes=nfl/leagues');
    expect(leagues).toHaveLength(2);
    expect(leagues[0]?.leagueKey).toBe(fixtures.MOCK_LEAGUE_KEY);
  });

  it('never hardcodes a league, game, or season key', async () => {
    const { instance, urls } = client([
      { status: 200, body: fixtures.mockLeagueSettingsResponse() },
    ]);

    await instance.getLeagueMetadata(fixtures.MOCK_LEAGUE_KEY as never);
    // The key came from the caller, which got it from the user's own selection.
    expect(urls[0]).toContain(encodeURIComponent(fixtures.MOCK_LEAGUE_KEY));
  });

  it('reads rosters one team at a time rather than fanning out', async () => {
    const { instance, urls } = client([
      { status: 200, body: fixtures.mockTeamRosterResponse(1, 3) },
    ]);

    const teamKeys = [1, 2, 3].map((id) => fixtures.teamKey(id) as never);
    const rosters = await instance.getRostersForTeams(teamKeys, 3);

    expect(rosters).toHaveLength(3);
    // Twelve simultaneous requests is the pattern that earns a block from an API
    // with no published rate limit.
    expect(urls).toHaveLength(3);
  });
});

describe('YahooClient pagination', () => {
  it('stops on the first short page', async () => {
    const page = (count: number): unknown => ({ items: count });
    const { instance, urls } = client([
      { status: 200, body: page(25) },
      { status: 200, body: page(25) },
      { status: 200, body: page(4) },
    ]);

    const parsePage = (body: unknown): number[] =>
      Array.from({ length: (body as { items: number }).items }, (_, i) => i);

    const items = await instance.getPaginated(
      (start, count) => `league/999.l.1/players;start=${start};count=${count}`,
      parsePage,
      { pageSize: 25 },
    );

    expect(items).toHaveLength(54);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('start=0;count=25');
    expect(urls[1]).toContain('start=25;count=25');
    expect(urls[2]).toContain('start=50;count=25');
  });

  it('makes one more request after an exactly-full page, since Yahoo sends no total', async () => {
    const { instance, urls } = client([
      { status: 200, body: { items: 2 } },
      { status: 200, body: { items: 0 } },
    ]);

    const items = await instance.getPaginated(
      (start, count) => `players;start=${start};count=${count}`,
      (body) => Array.from({ length: (body as { items: number }).items }, () => 'x'),
      { pageSize: 2 },
    );

    expect(items).toHaveLength(2);
    expect(urls).toHaveLength(2);
  });

  it('stops at maxPages, so a paging contract change cannot loop forever', async () => {
    const { instance, urls } = client([{ status: 200, body: { items: 5 } }]);

    await instance.getPaginated(
      (start, count) => `players;start=${start};count=${count}`,
      (body) => Array.from({ length: (body as { items: number }).items }, () => 'x'),
      { pageSize: 5, maxPages: 3 },
    );

    expect(urls).toHaveLength(3);
  });

  it('handles an empty first page', async () => {
    const { instance } = client([{ status: 200, body: { items: 0 } }]);

    await expect(
      instance.getPaginated(
        (start, count) => `players;start=${start};count=${count}`,
        () => [],
        { pageSize: 25 },
      ),
    ).resolves.toEqual([]);
  });
});

describe('createTokenProvider', () => {
  const base = {
    clientId: 'id',
    clientSecret: 'secret',
    redirectUri: 'https://localhost:5173/auth/yahoo/callback',
  };

  const tokens = (expiresAt: number, refresh = 'refresh-1'): TokenSet => ({
    accessToken: 'access-1',
    refreshToken: refresh,
    expiresAtEpochSeconds: expiresAt,
    refreshTokenRotated: false,
  });

  it('returns the stored token when it is still comfortably valid', async () => {
    const { fetchImpl, urls } = queueFetch([{ status: 200, body: {} }]);
    const saveTokens = vi.fn();

    const getAccessToken = createTokenProvider({
      ...base,
      loadTokens: async () => tokens(10_000),
      saveTokens,
      fetchImpl,
      now: () => 1_000_000, // 1000s in epoch seconds
    });

    // now = 1000s, token expires at 10000s: no refresh needed.
    await expect(getAccessToken()).resolves.toBe('access-1');
    expect(urls).toHaveLength(0);
    expect(saveTokens).not.toHaveBeenCalled();
  });

  it('refreshes before expiry and persists the result', async () => {
    const { fetchImpl } = queueFetch([
      {
        status: 200,
        body: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 },
      },
    ]);
    const saved: TokenSet[] = [];

    const getAccessToken = createTokenProvider({
      ...base,
      loadTokens: async () => tokens(1200),
      saveTokens: async (next) => {
        saved.push(next);
      },
      fetchImpl,
      now: () => 1_000_000,
    });

    await expect(getAccessToken()).resolves.toBe('access-2');
    expect(saved[0]?.refreshToken).toBe('refresh-2');
    expect(saved[0]?.refreshTokenRotated).toBe(true);
  });

  it('shares one refresh across concurrent callers', async () => {
    // Twelve roster reads must not trigger twelve refreshes: the losers would
    // present an already-rotated refresh token and get invalid_grant.
    const { fetchImpl, urls } = queueFetch([
      {
        status: 200,
        body: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 },
      },
    ]);

    const getAccessToken = createTokenProvider({
      ...base,
      loadTokens: async () => tokens(1200),
      saveTokens: async () => undefined,
      fetchImpl,
      now: () => 1_000_000,
    });

    const results = await Promise.all(Array.from({ length: 12 }, () => getAccessToken()));

    expect(results.every((token) => token === 'access-2')).toBe(true);
    expect(urls).toHaveLength(1);
  });

  it('propagates a dead refresh token as a reconnect prompt', async () => {
    const { fetchImpl } = queueFetch([{ status: 400, body: { error: 'invalid_grant' } }]);

    const getAccessToken = createTokenProvider({
      ...base,
      loadTokens: async () => tokens(1200),
      saveTokens: async () => undefined,
      fetchImpl,
      now: () => 1_000_000,
    });

    await expect(getAccessToken()).rejects.toThrow(
      expect.objectContaining({ code: 'yahoo_needs_reconnect' }),
    );
  });

  it('recovers on a later call after a failed refresh', async () => {
    // A transient failure must not wedge the provider permanently.
    let attempt = 0;
    const fetchImpl: FetchLike = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('ECONNRESET');
      return {
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({
            access_token: 'access-3',
            refresh_token: 'refresh-3',
            expires_in: 3600,
          }),
        headers: { get: () => null },
      };
    };

    const getAccessToken = createTokenProvider({
      ...base,
      loadTokens: async () => tokens(1200),
      saveTokens: async () => undefined,
      fetchImpl,
      now: () => 1_000_000,
    });

    await expect(getAccessToken()).rejects.toThrow();
    await expect(getAccessToken()).resolves.toBe('access-3');
  });
});

describe('capability gate', () => {
  const matrix = (verified: string[]): CapabilityMatrix => ({
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
    verifiedCapabilities: verified,
  });

  it('reports a capability unverified until it is actually confirmed', () => {
    setCapabilityMatrix(matrix([]));
    expect(isCapabilityVerified('team_week_points')).toBe(false);
  });

  it('reports a capability verified once confirmed', () => {
    setCapabilityMatrix(matrix(['team_week_points']));
    expect(isCapabilityVerified('team_week_points')).toBe(true);
  });

  it('lists exactly which requirements are missing', () => {
    setCapabilityMatrix(matrix(['team_week_points']));
    const required: YahooCapabilityKey[] = [
      'team_week_points',
      'roster_selected_position',
      'player_projected_points',
    ];

    expect(unverifiedCapabilities(required)).toEqual([
      'roster_selected_position',
      'player_projected_points',
    ]);
  });

  it('throws an actionable error naming the missing capability', () => {
    setCapabilityMatrix(matrix([]));

    try {
      assertCapabilities(['player_projected_points']);
      expect.unreachable();
    } catch (error) {
      const appError = error as AppError;
      expect(appError.code).toBe('yahoo_capability_unverified');
      expect(appError.publicMessage).toContain('player_projected_points');
    }
  });

  it('passes when every requirement is verified', () => {
    setCapabilityMatrix(matrix(['team_week_points', 'matchup_result']));
    expect(() => assertCapabilities(['team_week_points', 'matchup_result'])).not.toThrow();
  });

  it('reports Yahoo writes and commissioner actions unsupported, as documented', () => {
    setCapabilityMatrix(matrix([]));
    // No write operation appears in Yahoo's current documentation, so the portal
    // performs no Yahoo mutation and the LLWS order is entered by hand.
    expect(canWriteToYahoo()).toBe(false);
    expect(canPerformCommissionerActions()).toBe(false);
  });
});
