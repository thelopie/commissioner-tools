import { describe, expect, it } from 'vitest';
import { collect, descend, mergeParts, optionalNumber } from './parse.js';
import {
  parseLeagueMetadata,
  parseLeagueTeams,
  parseScoreboard,
  parseTeamRoster,
  parseUserLeagues,
  parseUserProfile,
} from './resources.js';
import * as fixtures from './fixtures/synthetic.js';

describe('collect', () => {
  it('reads Yahoo numeric-keyed collections in order', () => {
    const collection = { '0': { a: 1 }, '1': { a: 2 }, '2': { a: 3 }, count: 3 };
    expect(collect(collection)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('orders numerically, not lexically, past nine items', () => {
    // Lexical sorting would put "10" before "2" and silently reorder a 12-team league.
    const collection: Record<string, unknown> = { count: 12 };
    for (let i = 0; i < 12; i += 1) collection[String(i)] = { index: i };

    expect(collect(collection).map((item) => (item as { index: number }).index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
  });

  it('accepts a genuine array, which Yahoo also returns', () => {
    expect(collect([{ a: 1 }, { a: 2 }])).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('returns empty for an empty collection, absent value, or null', () => {
    expect(collect({ count: 0 })).toEqual([]);
    expect(collect(undefined)).toEqual([]);
    expect(collect(null)).toEqual([]);
  });

  it('drops nulls inside a collection rather than yielding holes', () => {
    expect(collect({ '0': { a: 1 }, '1': null, count: 2 })).toEqual([{ a: 1 }]);
  });
});

describe('mergeParts', () => {
  it('merges Yahoo array-of-partials into one object', () => {
    expect(mergeParts([{ team_key: 'k' }, { name: 'n' }])).toEqual({ team_key: 'k', name: 'n' });
  });

  it('flattens the nested-array wrapper Yahoo uses for teams', () => {
    expect(mergeParts([[{ team_key: 'k' }, { name: 'n' }], { extra: 1 }])).toEqual({
      team_key: 'k',
      name: 'n',
      extra: 1,
    });
  });

  it('ignores nulls', () => {
    expect(mergeParts([{ a: 1 }, null, { b: null }])).toEqual({ a: 1 });
  });
});

describe('optionalNumber', () => {
  it('parses Yahoo numbers-as-strings', () => {
    expect(optionalNumber({ total: '123.4' }, 'total')).toBe(123.4);
  });

  it('treats an empty string as no value, not zero', () => {
    // Yahoo returns "" for a player who did not play. A 0 here would enter a
    // challenge calculation as a real score and could win a "lowest" challenge.
    expect(optionalNumber({ total: '' }, 'total')).toBeUndefined();
    expect(optionalNumber({ total: '-' }, 'total')).toBeUndefined();
  });

  it('preserves a real zero', () => {
    expect(optionalNumber({ total: '0' }, 'total')).toBe(0);
    expect(optionalNumber({ total: 0 }, 'total')).toBe(0);
  });

  it('preserves negatives, which fantasy scoring produces', () => {
    expect(optionalNumber({ total: '-2.5' }, 'total')).toBe(-2.5);
  });

  it('rejects non-numeric text', () => {
    expect(optionalNumber({ total: 'n/a' }, 'total')).toBeUndefined();
  });
});

describe('descend', () => {
  it('walks a chain of collection wrappers', () => {
    const root = {
      users: {
        '0': {
          user: [{ guid: 'g' }, { games: { '0': { game: [{ game_key: '999' }] }, count: 1 } }],
        },
        count: 1,
      },
    };

    expect(descend(root, ['users', 'user', 'games', 'game'])).toEqual([{ game_key: '999' }]);
  });

  it('returns empty rather than throwing when the chain breaks', () => {
    expect(descend({ users: { count: 0 } }, ['users', 'user', 'games'])).toEqual([]);
  });
});

describe('parseUserProfile', () => {
  it('extracts the GUID, the one value Yahoo lets us keep', () => {
    const profile = parseUserProfile(fixtures.mockUserProfileResponse());
    expect(profile.guid).toBe(fixtures.MOCK_USER_GUID);
    expect(profile.nickname).toBe('mock_commissioner');
  });

  it('throws a clear error on a response with no fantasy_content envelope', () => {
    expect(() => parseUserProfile({ unexpected: true })).toThrow(
      expect.objectContaining({ code: 'yahoo_unexpected_response' }),
    );
  });
});

describe('parseUserLeagues', () => {
  it('returns every league with its game key taken from the parent game node', () => {
    const leagues = parseUserLeagues(fixtures.mockUserLeaguesResponse());

    expect(leagues).toHaveLength(2);
    const [first, second] = leagues;

    expect(first?.leagueKey).toBe(fixtures.MOCK_LEAGUE_KEY);
    // Read from the game node, not split out of the league key — the
    // "{game_key}.l.{id}" format is a convention, not a documented guarantee.
    expect(first?.gameKey).toBe(fixtures.MOCK_GAME_KEY);
    expect(first?.name).toBe('Mock Dinkel League');
    expect(first?.season).toBe(fixtures.MOCK_SEASON);
    expect(first?.teamCount).toBe(12);
    expect(first?.isCommissioner).toBe(true);

    expect(second?.leagueKey).toBe('999.l.100002');
    expect(second?.isCommissioner).toBe(false);
  });

  it('returns an empty list when the user has no football leagues', () => {
    const body = {
      fantasy_content: {
        users: { '0': { user: [{ guid: 'g' }, { games: { count: 0 } }] }, count: 1 },
      },
    };
    // No leagues is a legitimate answer, not an error state.
    expect(parseUserLeagues(body)).toEqual([]);
  });

  it('skips a league with no league_key rather than emitting a broken entry', () => {
    const body = {
      fantasy_content: {
        users: {
          '0': {
            user: [
              { guid: 'g' },
              {
                games: {
                  '0': {
                    game: [
                      { game_key: '999' },
                      { leagues: { '0': { league: [{ name: 'Nameless' }] }, count: 1 } },
                    ],
                  },
                  count: 1,
                },
              },
            ],
          },
          count: 1,
        },
      },
    };
    expect(parseUserLeagues(body)).toEqual([]);
  });
});

describe('parseLeagueMetadata', () => {
  it('reads league fields and merges the settings sub-resource', () => {
    const metadata = parseLeagueMetadata(fixtures.mockLeagueSettingsResponse());

    expect(metadata.leagueKey).toBe(fixtures.MOCK_LEAGUE_KEY);
    expect(metadata.currentWeek).toBe(fixtures.MOCK_CURRENT_WEEK);
    expect(metadata.startWeek).toBe(1);
    expect(metadata.endWeek).toBe(17);
    expect(metadata.playoffStartWeek).toBe(15);
    expect(metadata.numPlayoffTeams).toBe(6);
  });

  it('tolerates a response with no settings node', () => {
    // Optional fields stay absent rather than becoming undefined-shaped noise.
    const body = {
      fantasy_content: { league: [{ league_key: 'k', name: 'n', season: '2026' }] },
    };
    const metadata = parseLeagueMetadata(body);
    expect(metadata.name).toBe('n');
    expect(metadata.playoffStartWeek).toBeUndefined();
  });

  it('throws when league_key is absent, instead of returning a keyless league', () => {
    expect(() => parseLeagueMetadata({ fantasy_content: { league: [{ name: 'n' }] } })).toThrow(
      expect.objectContaining({ code: 'yahoo_unexpected_response' }),
    );
  });
});

describe('parseLeagueTeams', () => {
  it('reads all twelve teams with managers', () => {
    const teams = parseLeagueTeams(fixtures.mockLeagueTeamsResponse());

    expect(teams).toHaveLength(12);
    const first = teams[0];
    expect(first?.teamKey).toBe(fixtures.teamKey(1));
    expect(first?.name).toBe('Dovetail Dynasty');
    expect(first?.managers[0]?.nickname).toBe('mock_commissioner');
    expect(first?.managers[0]?.guid).toBe(fixtures.MOCK_USER_GUID);
    expect(first?.managers[0]?.isCommissioner).toBe(true);
  });

  it('handles a manager with no GUID, which Yahoo commonly omits for others', () => {
    const teams = parseLeagueTeams(fixtures.mockLeagueTeamsResponse());
    const second = teams[1];

    expect(second?.managers[0]?.nickname).toBe('mock_manager_2');
    // The portal never depends on other managers' GUIDs; the commissioner maps
    // teams to Dinkel members by hand.
    expect(second?.managers[0]?.guid).toBeUndefined();
  });

  it('falls back to a placeholder rather than crashing on a nameless team', () => {
    const body = {
      fantasy_content: {
        league: [
          { league_key: 'k' },
          { teams: { '0': { team: [[{ team_key: 'k.t.1' }]] }, count: 1 } },
        ],
      },
    };
    expect(parseLeagueTeams(body)[0]?.name).toBe('(unnamed team)');
  });
});

describe('parseTeamRoster', () => {
  it('reads slots, distinguishing bench from starters', () => {
    const roster = parseTeamRoster(fixtures.mockTeamRosterResponse(1, 3), 3);

    expect(roster.teamKey).toBe(fixtures.teamKey(1));
    expect(roster.week).toBe(3);
    expect(roster.slots).toHaveLength(13);

    const bench = roster.slots.filter((slot) => slot.selectedPosition === 'BN');
    const starters = roster.slots.filter((slot) => slot.selectedPosition !== 'BN');
    expect(bench).toHaveLength(4);
    expect(starters).toHaveLength(9);
  });

  it('reports Yahoo slot codes verbatim instead of normalizing them', () => {
    // The bench code 'BN' is a convention recorded as unverified in
    // yahoo-capabilities.json. Normalizing here would hide a surprise value.
    const roster = parseTeamRoster(fixtures.mockTeamRosterResponse(1, 3), 3);
    const flex = roster.slots.find((slot) => slot.selectedPosition === 'W/R/T');
    expect(flex).toBeDefined();
  });

  it('reads player points and eligible positions', () => {
    const roster = parseTeamRoster(fixtures.mockTeamRosterResponse(2, 5), 5);
    const quarterback = roster.slots.find((slot) => slot.selectedPosition === 'QB');

    expect(quarterback?.points).toBeTypeOf('number');
    expect(quarterback?.eligiblePositions).toContain('QB');
    expect(quarterback?.nflTeamAbbreviation).toBe('MCK');
  });

  it('falls back to the requested week when Yahoo omits it', () => {
    const body = {
      fantasy_content: { team: [[{ team_key: 'k.t.1' }], { roster: [{ players: { count: 0 } }] }] },
    };
    expect(parseTeamRoster(body, 9).week).toBe(9);
  });
});

describe('parseScoreboard', () => {
  it('reads six matchups with both teams and their points', () => {
    const matchups = parseScoreboard(fixtures.mockScoreboardResponse(3), 3);

    expect(matchups).toHaveLength(6);
    for (const matchup of matchups) {
      expect(matchup.week).toBe(3);
      expect(matchup.teams).toHaveLength(2);
      for (const team of matchup.teams) {
        expect(team.points).toBeTypeOf('number');
      }
    }
  });

  it('reads the winner and tie flag', () => {
    const [first] = parseScoreboard(fixtures.mockScoreboardResponse(3), 3);
    expect(first?.winnerTeamKey).toBeDefined();
    expect(first?.isTied).toBe(false);
  });

  it('returns empty for a week with no matchups', () => {
    const body = {
      fantasy_content: {
        league: [{ league_key: 'k' }, { scoreboard: [{ matchups: { count: 0 } }] }],
      },
    };
    expect(parseScoreboard(body, 1)).toEqual([]);
  });
});

describe('synthetic fixtures', () => {
  it('contain no real personal data', () => {
    // This repository is public and Yahoo's terms forbid retaining user data.
    // Every fixture name must be obviously invented.
    const serialized = JSON.stringify([
      fixtures.mockUserProfileResponse(),
      fixtures.mockUserLeaguesResponse(),
      fixtures.mockLeagueTeamsResponse(),
      fixtures.mockTeamRosterResponse(1, 1),
    ]);

    expect(serialized).toMatch(/mock/i);
    expect(fixtures.MOCK_USER_GUID).toMatch(/^MOCKGUID/);
    // Placeholder domains only, per RFC 2606.
    for (const match of serialized.matchAll(/https?:\/\/([^"/]+)/g)) {
      expect(match[1]).toMatch(/\.(invalid|example|test|localhost)$|^localhost/);
    }
  });

  it('produce deterministic scores, so challenge tests are reproducible', () => {
    const first = JSON.stringify(fixtures.mockScoreboardResponse(3));
    const second = JSON.stringify(fixtures.mockScoreboardResponse(3));
    expect(first).toBe(second);
  });
});
