/**
 * Synthetic Yahoo fixtures.
 *
 * Every value here is invented. No real league, manager, team name, player, or
 * Yahoo response appears in this repository — it is public, and the Yahoo terms
 * forbid retaining user data besides the GUID and token regardless.
 *
 * The shapes deliberately reproduce Yahoo's awkward conventions rather than a
 * tidy version of them: numeric-keyed collections with a `count` sibling, single
 * entities as arrays of partial objects, and numbers encoded as strings. A tidy
 * fixture would let the parsers pass here and fail against the real API.
 *
 * Names are drawn from a fictional league of woodworking-themed teams so nothing
 * can be mistaken for a real person.
 */

export const MOCK_GAME_KEY = '999';
export const MOCK_LEAGUE_KEY = '999.l.100001';
export const MOCK_USER_GUID = 'MOCKGUID0000000000000001';
export const MOCK_SEASON = 2026;
export const MOCK_CURRENT_WEEK = 3;

interface MockManager {
  guid?: string;
  nickname: string;
  isCommissioner?: boolean;
  isCurrentLogin?: boolean;
}

interface MockTeam {
  teamId: number;
  name: string;
  managers: MockManager[];
}

export const MOCK_TEAMS: MockTeam[] = [
  {
    teamId: 1,
    name: 'Dovetail Dynasty',
    managers: [
      {
        guid: MOCK_USER_GUID,
        nickname: 'mock_commissioner',
        isCommissioner: true,
        isCurrentLogin: true,
      },
    ],
  },
  { teamId: 2, name: 'Mortise & Tenon', managers: [{ nickname: 'mock_manager_2' }] },
  { teamId: 3, name: 'Kerf Kings', managers: [{ nickname: 'mock_manager_3' }] },
  { teamId: 4, name: 'Sanders of Time', managers: [{ nickname: 'mock_manager_4' }] },
  { teamId: 5, name: 'Router Rage', managers: [{ nickname: 'mock_manager_5' }] },
  { teamId: 6, name: 'Chisel Chasers', managers: [{ nickname: 'mock_manager_6' }] },
  { teamId: 7, name: 'Planer Perfect', managers: [{ nickname: 'mock_manager_7' }] },
  { teamId: 8, name: 'Jigsaw Junkies', managers: [{ nickname: 'mock_manager_8' }] },
  { teamId: 9, name: 'Clamp Down', managers: [{ nickname: 'mock_manager_9' }] },
  { teamId: 10, name: 'Grain Matchers', managers: [{ nickname: 'mock_manager_10' }] },
  { teamId: 11, name: 'Bandsaw Bandits', managers: [{ nickname: 'mock_manager_11' }] },
  { teamId: 12, name: 'Lathe Expectations', managers: [{ nickname: 'mock_manager_12' }] },
];

export const teamKey = (teamId: number): string => `${MOCK_LEAGUE_KEY}.t.${teamId}`;

/** Wraps items the way Yahoo does: numeric keys plus a `count`. */
function countedCollection(items: unknown[]): Record<string, unknown> {
  const collection: Record<string, unknown> = {};
  items.forEach((item, index) => {
    collection[String(index)] = item;
  });
  collection['count'] = items.length;
  return collection;
}

export function mockUserProfileResponse(): unknown {
  return {
    fantasy_content: {
      users: countedCollection([
        {
          // A single entity as an array of partials — Yahoo's actual shape.
          user: [{ guid: MOCK_USER_GUID }, { nickname: 'mock_commissioner' }],
        },
      ]),
    },
  };
}

export function mockUserLeaguesResponse(): unknown {
  return {
    fantasy_content: {
      users: countedCollection([
        {
          user: [
            { guid: MOCK_USER_GUID },
            {
              games: countedCollection([
                {
                  game: [
                    {
                      game_key: MOCK_GAME_KEY,
                      game_id: MOCK_GAME_KEY,
                      name: 'Mock Football',
                      code: 'nfl',
                      season: String(MOCK_SEASON),
                    },
                    {
                      leagues: countedCollection([
                        {
                          league: [
                            {
                              league_key: MOCK_LEAGUE_KEY,
                              league_id: '100001',
                              name: 'Mock Dinkel League',
                              // Yahoo returns these as strings.
                              num_teams: '12',
                              season: String(MOCK_SEASON),
                              scoring_type: 'head',
                              is_commissioner: '1',
                              is_finished: '0',
                              url: 'https://example.invalid/mock-league',
                            },
                          ],
                        },
                        {
                          league: [
                            {
                              league_key: '999.l.100002',
                              league_id: '100002',
                              name: 'Mock Second League',
                              num_teams: '10',
                              season: String(MOCK_SEASON),
                              scoring_type: 'head',
                              is_commissioner: '0',
                            },
                          ],
                        },
                      ]),
                    },
                  ],
                },
              ]),
            },
          ],
        },
      ]),
    },
  };
}

export function mockLeagueSettingsResponse(): unknown {
  return {
    fantasy_content: {
      league: [
        {
          league_key: MOCK_LEAGUE_KEY,
          league_id: '100001',
          name: 'Mock Dinkel League',
          season: String(MOCK_SEASON),
          num_teams: '12',
          scoring_type: 'head',
          league_type: 'private',
          draft_status: 'predraft',
          current_week: String(MOCK_CURRENT_WEEK),
          start_week: '1',
          end_week: '17',
          is_commissioner: '1',
        },
        {
          settings: [
            {
              playoff_start_week: '15',
              num_playoff_teams: '6',
              uses_playoff_reseeding: '0',
            },
          ],
        },
      ],
    },
  };
}

export function mockLeagueTeamsResponse(): unknown {
  return {
    fantasy_content: {
      league: [
        { league_key: MOCK_LEAGUE_KEY, name: 'Mock Dinkel League' },
        {
          teams: countedCollection(
            MOCK_TEAMS.map((team) => ({
              team: [
                [
                  { team_key: teamKey(team.teamId) },
                  { team_id: String(team.teamId) },
                  { name: team.name },
                  {
                    managers: countedCollection(
                      team.managers.map((manager) => ({
                        manager: [
                          ...(manager.guid ? [{ guid: manager.guid }] : []),
                          { nickname: manager.nickname },
                          ...(manager.isCommissioner ? [{ is_commissioner: '1' }] : []),
                          ...(manager.isCurrentLogin ? [{ is_current_login: '1' }] : []),
                        ],
                      })),
                    ),
                  },
                ],
                { waiver_priority: String(team.teamId), number_of_moves: '0' },
              ],
            })),
          ),
        },
      ],
    },
  };
}

/**
 * Deterministic pseudo-score, so mock data is stable across runs.
 *
 * Fixed arithmetic rather than randomness: a challenge test that computed a
 * different winner on each run would be worthless.
 */
function mockPoints(seed: number): number {
  const value = ((seed * 37) % 61) + 60 + ((seed * 13) % 10) / 10;
  return Math.round(value * 10) / 10;
}

export function mockScoreboardResponse(week: number): unknown {
  const matchups: unknown[] = [];

  for (let i = 0; i < MOCK_TEAMS.length; i += 2) {
    const home = MOCK_TEAMS[i]!;
    const away = MOCK_TEAMS[i + 1]!;
    const homePoints = mockPoints(home.teamId * week);
    const awayPoints = mockPoints(away.teamId * week + 7);

    matchups.push({
      matchup: [
        {
          week: String(week),
          status: 'postevent',
          is_tied: homePoints === awayPoints ? '1' : '0',
          winner_team_key: teamKey(homePoints >= awayPoints ? home.teamId : away.teamId),
        },
        {
          teams: countedCollection([
            {
              team: [
                [{ team_key: teamKey(home.teamId) }, { name: home.name }],
                {
                  team_points: {
                    coverage_type: 'week',
                    week: String(week),
                    total: String(homePoints),
                  },
                },
              ],
            },
            {
              team: [
                [{ team_key: teamKey(away.teamId) }, { name: away.name }],
                {
                  team_points: {
                    coverage_type: 'week',
                    week: String(week),
                    total: String(awayPoints),
                  },
                },
              ],
            },
          ]),
        },
      ],
    });
  }

  return {
    fantasy_content: {
      league: [
        { league_key: MOCK_LEAGUE_KEY, name: 'Mock Dinkel League' },
        { scoreboard: [{ week: String(week) }, { matchups: countedCollection(matchups) }] },
      ],
    },
  };
}

const MOCK_ROSTER_TEMPLATE: Array<{ position: string; slot: string; name: string }> = [
  { position: 'QB', slot: 'QB', name: 'Mock Quarterback' },
  { position: 'RB', slot: 'RB', name: 'Mock Runningback One' },
  { position: 'RB', slot: 'RB', name: 'Mock Runningback Two' },
  { position: 'WR', slot: 'WR', name: 'Mock Receiver One' },
  { position: 'WR', slot: 'WR', name: 'Mock Receiver Two' },
  { position: 'TE', slot: 'TE', name: 'Mock Tightend' },
  { position: 'WR', slot: 'W/R/T', name: 'Mock Flex' },
  { position: 'K', slot: 'K', name: 'Mock Kicker' },
  { position: 'DEF', slot: 'DEF', name: 'Mock Defense' },
  // Bench slots. `BN` is the conventional bench code, and it is exactly the
  // convention `yahoo-capabilities.json` records as unverified.
  { position: 'QB', slot: 'BN', name: 'Mock Bench Quarterback' },
  { position: 'RB', slot: 'BN', name: 'Mock Bench Runningback' },
  { position: 'WR', slot: 'BN', name: 'Mock Bench Receiver' },
  { position: 'TE', slot: 'BN', name: 'Mock Bench Tightend' },
];

export function mockTeamRosterResponse(teamId: number, week: number): unknown {
  const players = MOCK_ROSTER_TEMPLATE.map((template, index) => ({
    player: [
      [
        { player_key: `${MOCK_GAME_KEY}.p.${teamId * 100 + index}` },
        { player_id: String(teamId * 100 + index) },
        {
          name: {
            full: template.name,
            first: 'Mock',
            last: template.name.split(' ').at(-1) ?? 'Player',
          },
        },
        { editorial_team_abbr: 'MCK' },
        { display_position: template.position },
        {
          eligible_positions: [{ position: template.position }],
        },
      ],
      {
        selected_position: [
          { coverage_type: 'week', week: String(week) },
          { position: template.slot },
        ],
      },
      {
        player_points: {
          coverage_type: 'week',
          week: String(week),
          total: String(mockPoints(teamId * 10 + index + week)),
        },
      },
    ],
  }));

  return {
    fantasy_content: {
      team: [
        [{ team_key: teamKey(teamId) }, { team_id: String(teamId) }],
        {
          roster: [
            { coverage_type: 'week', week: String(week) },
            { players: countedCollection(players) },
          ],
        },
      ],
    },
  };
}
