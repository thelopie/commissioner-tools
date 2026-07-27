import { fixtures } from '@dinkel/yahoo-client';

/**
 * Mock Yahoo route handling, separated from the HTTP server so it is unit
 * testable without opening a socket.
 *
 * This exists because Yahoo Fantasy API access is granted only after Yahoo
 * reviews an application (see `yahoo-capabilities.json`). Without a mock, no part
 * of the portal could be built or demonstrated until that approval landed.
 *
 * It is a development aid, not a Yahoo emulator. It answers only the resources
 * this portal actually calls, with synthetic data, in Yahoo's documented URL
 * shapes. Anything else returns 404 rather than a plausible-looking guess, so a
 * mismatch between what the portal requests and what Yahoo documents surfaces
 * here rather than in production.
 */

export interface MockResponse {
  status: number;
  body: unknown;
}

/** Mirrors Yahoo's OAuth token endpoint closely enough to exercise the real flow. */
export function handleTokenRequest(body: string): MockResponse {
  const params = new URLSearchParams(body);
  const grantType = params.get('grant_type');

  if (grantType === 'authorization_code') {
    if (!params.get('code')) {
      return { status: 400, body: { error: 'invalid_request', error_description: 'missing code' } };
    }
    return {
      status: 200,
      body: {
        access_token: `mock-access-${Date.now()}`,
        refresh_token: 'mock-refresh-token-1',
        expires_in: 3600,
        token_type: 'bearer',
        xoauth_yahoo_guid: fixtures.MOCK_USER_GUID,
      },
    };
  }

  if (grantType === 'refresh_token') {
    const refreshToken = params.get('refresh_token');
    if (!refreshToken) {
      return { status: 400, body: { error: 'invalid_request' } };
    }
    // Deliberately rotates the refresh token. Yahoo documents rotation as
    // optional, and rotating here means the portal's rotation handling is
    // exercised in normal development rather than discovered in production.
    const generation = Number(/-(\d+)$/.exec(refreshToken)?.[1] ?? '1');
    return {
      status: 200,
      body: {
        access_token: `mock-access-${Date.now()}`,
        refresh_token: `mock-refresh-token-${generation + 1}`,
        expires_in: 3600,
        token_type: 'bearer',
      },
    };
  }

  return { status: 400, body: { error: 'unsupported_grant_type' } };
}

/**
 * Routes a Fantasy API path.
 *
 * @param path - Path after `/fantasy/v2/`, with the query string removed.
 */
export function handleFantasyRequest(path: string): MockResponse {
  const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');

  if (clean === 'users;use_login=1') {
    return { status: 200, body: fixtures.mockUserProfileResponse() };
  }

  if (clean === 'users;use_login=1/games;game_codes=nfl/leagues') {
    return { status: 200, body: fixtures.mockUserLeaguesResponse() };
  }

  const leagueSettings = /^league\/([^/]+)\/settings$/.exec(clean);
  if (leagueSettings) {
    return leagueScopedResponse(leagueSettings[1]!, fixtures.mockLeagueSettingsResponse());
  }

  const leagueTeams = /^league\/([^/]+)\/teams$/.exec(clean);
  if (leagueTeams) {
    return leagueScopedResponse(leagueTeams[1]!, fixtures.mockLeagueTeamsResponse());
  }

  const standings = /^league\/([^/]+)\/standings$/.exec(clean);
  if (standings) {
    return leagueScopedResponse(standings[1]!, fixtures.mockStandingsResponse());
  }

  const transactions = /^league\/([^/]+)\/transactions(?:;count=\d+)?$/.exec(clean);
  if (transactions) {
    // The live clock, so recent moves read as recent. The fixture defaults to a
    // fixed timestamp for tests; only this server passes a real one.
    return leagueScopedResponse(
      transactions[1]!,
      fixtures.mockTransactionsResponse(Math.floor(Date.now() / 1000)),
    );
  }

  const scoreboard = /^league\/([^/]+)\/scoreboard;week=(\d+)$/.exec(clean);
  if (scoreboard) {
    return leagueScopedResponse(
      scoreboard[1]!,
      fixtures.mockScoreboardResponse(Number(scoreboard[2])),
    );
  }

  // The roster path the client builds requests stats in the same call.
  const roster = /^team\/([^/]+)\/roster;week=(\d+)(?:\/players\/stats;[^/]*)?$/.exec(clean);
  if (roster) {
    const teamKey = decodeURIComponent(roster[1]!);
    const teamId = Number(/\.t\.(\d+)$/.exec(teamKey)?.[1] ?? '0');

    if (!teamId || teamId > fixtures.MOCK_TEAMS.length) {
      return notFound(`unknown team key: ${teamKey}`);
    }
    return { status: 200, body: fixtures.mockTeamRosterResponse(teamId, Number(roster[2])) };
  }

  return notFound(
    `the mock server does not implement "${clean}". ` +
      `Add it here only if Yahoo documents it — see yahoo-capabilities.json.`,
  );
}

function leagueScopedResponse(rawLeagueKey: string, body: unknown): MockResponse {
  const leagueKey = decodeURIComponent(rawLeagueKey);
  if (leagueKey !== fixtures.MOCK_LEAGUE_KEY) {
    // The second fixture league exists so league selection has a real choice,
    // but only the primary one has full data.
    return notFound(`the mock server only has data for ${fixtures.MOCK_LEAGUE_KEY}`);
  }
  return { status: 200, body };
}

function notFound(description: string): MockResponse {
  return {
    status: 404,
    body: { error: { description, detail: null, 'yahoo:uri': null } },
  };
}
