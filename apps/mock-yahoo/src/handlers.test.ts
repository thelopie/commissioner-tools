import { describe, expect, it } from 'vitest';
import {
  fixtures,
  parseUserLeagues,
  parseLeagueTeams,
  parseTeamRoster,
} from '@dinkel/yahoo-client';
import { handleFantasyRequest, handleTokenRequest } from './handlers.js';

describe('mock token endpoint', () => {
  it('exchanges an authorization code for a token pair', () => {
    const result = handleTokenRequest('grant_type=authorization_code&code=abc&redirect_uri=x');

    expect(result.status).toBe(200);
    const body = result.body as { access_token: string; refresh_token: string; expires_in: number };
    expect(body.access_token).toMatch(/^mock-access-/);
    expect(body.refresh_token).toBe('mock-refresh-token-1');
    expect(body.expires_in).toBe(3600);
  });

  it('rejects an exchange with no code', () => {
    expect(handleTokenRequest('grant_type=authorization_code').status).toBe(400);
  });

  it('rotates the refresh token, so rotation handling is exercised in development', () => {
    // Yahoo documents rotation as optional. Always rotating here means the
    // portal's rotation path is normal, not a production surprise.
    const first = handleTokenRequest('grant_type=refresh_token&refresh_token=mock-refresh-token-1');
    expect((first.body as { refresh_token: string }).refresh_token).toBe('mock-refresh-token-2');

    const second = handleTokenRequest(
      'grant_type=refresh_token&refresh_token=mock-refresh-token-2',
    );
    expect((second.body as { refresh_token: string }).refresh_token).toBe('mock-refresh-token-3');
  });

  it('rejects an unsupported grant type', () => {
    expect(handleTokenRequest('grant_type=password&username=x').status).toBe(400);
  });
});

describe('mock fantasy routes', () => {
  it('serves the user profile', () => {
    const result = handleFantasyRequest('users;use_login=1');
    expect(result.status).toBe(200);
  });

  it('serves leagues that the real parser can read', () => {
    // The mock is only useful if it exercises the production parser, so the
    // assertion runs the response through it rather than inspecting raw JSON.
    const result = handleFantasyRequest('users;use_login=1/games;game_codes=nfl/leagues');
    const leagues = parseUserLeagues(result.body);

    expect(leagues).toHaveLength(2);
    expect(leagues[0]?.leagueKey).toBe(fixtures.MOCK_LEAGUE_KEY);
  });

  it('serves league settings and teams for the primary fixture league', () => {
    const encoded = encodeURIComponent(fixtures.MOCK_LEAGUE_KEY);

    expect(handleFantasyRequest(`league/${encoded}/settings`).status).toBe(200);

    const teams = parseLeagueTeams(handleFantasyRequest(`league/${encoded}/teams`).body);
    expect(teams).toHaveLength(12);
  });

  it('serves a scoreboard for a requested week', () => {
    const encoded = encodeURIComponent(fixtures.MOCK_LEAGUE_KEY);
    expect(handleFantasyRequest(`league/${encoded}/scoreboard;week=3`).status).toBe(200);
  });

  it('serves a roster on the same path the client builds', () => {
    const teamKey = encodeURIComponent(fixtures.teamKey(1));
    const path = `team/${teamKey}/roster;week=3/players/stats;type=week;week=3`;

    const roster = parseTeamRoster(handleFantasyRequest(path).body, 3);
    expect(roster.slots).toHaveLength(13);
  });

  it('404s an unknown team rather than inventing one', () => {
    const teamKey = encodeURIComponent(`${fixtures.MOCK_LEAGUE_KEY}.t.99`);
    expect(handleFantasyRequest(`team/${teamKey}/roster;week=3`).status).toBe(404);
  });

  it('404s a league it has no data for', () => {
    // The second fixture league exists so selection is a real choice, but only
    // the primary league has full data.
    expect(handleFantasyRequest(`league/${encodeURIComponent('999.l.100002')}/teams`).status).toBe(
      404,
    );
  });

  it('404s an undocumented resource instead of guessing a shape', () => {
    // A plausible-looking guess here would hide a mismatch between what the
    // portal requests and what Yahoo actually documents.
    const result = handleFantasyRequest('league/999.l.100001/undocumented_thing');

    expect(result.status).toBe(404);
    expect(JSON.stringify(result.body)).toContain('yahoo-capabilities.json');
  });

  it('404s any write attempt, since Yahoo documents no write operations', () => {
    expect(handleFantasyRequest('league/999.l.100001/transactions/add').status).toBe(404);
    expect(handleFantasyRequest('league/999.l.100001/draftresults/order').status).toBe(404);
  });
});
