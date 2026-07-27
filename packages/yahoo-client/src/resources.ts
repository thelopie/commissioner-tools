import type { YahooGameKey, YahooGuid, YahooLeagueKey, YahooTeamKey } from '@dinkel/shared';
import {
  collect,
  descend,
  fantasyContent,
  mergeParts,
  optionalBoolean,
  optionalNumber,
  optionalString,
  pick,
  requireString,
  type Json,
} from './parse.js';

/**
 * Normalized Yahoo resources.
 *
 * Everything here is EPHEMERAL. These shapes exist to be rendered or fed into a
 * calculation and then discarded — the only durable trace is a Yahoo identifier
 * plus, for a finalized challenge, a single derived number. Nothing in this file
 * is written to a permanent entity.
 */

export interface YahooLeagueSummary {
  leagueKey: YahooLeagueKey;
  gameKey: YahooGameKey;
  /** Ephemeral: displayed live, never persisted. */
  name: string;
  season?: number;
  teamCount?: number;
  /** Yahoo's own flag for whether the signed-in user is the league commissioner. */
  isCommissioner?: boolean;
  scoringType?: string;
  url?: string;
  /** Yahoo indicates a finished season; useful for offering past seasons. */
  isFinished?: boolean;
}

export interface YahooLeagueMetadata extends YahooLeagueSummary {
  currentWeek?: number;
  startWeek?: number;
  endWeek?: number;
  playoffStartWeek?: number;
  numPlayoffTeams?: number;
  /** Raw scoring-type string, e.g. "head" for head-to-head. */
  leagueType?: string;
  draftStatus?: string;
}

export interface YahooManager {
  /**
   * Present only for some managers, commonly the signed-in user. The portal
   * never depends on other managers' GUIDs; when absent, the commissioner maps
   * the team to a Dinkel member by hand.
   */
  guid?: YahooGuid;
  /** Ephemeral display text. */
  nickname: string;
  isCommissioner?: boolean;
  /** True when this manager is the signed-in user. */
  isCurrentLogin?: boolean;
}

export interface YahooTeam {
  teamKey: YahooTeamKey;
  teamId?: string;
  /** Ephemeral display text. */
  name: string;
  logoUrl?: string;
  managers: YahooManager[];
  waiverPriority?: number;
  numberOfMoves?: number;
  numberOfTrades?: number;
}

/** Yahoo user profile, read once at sign-in. Only the GUID is retained. */
export interface YahooUserProfile {
  guid: YahooGuid;
  /** Prefills the portal display name at first sign-in, then is discarded. */
  nickname?: string;
  email?: string;
}

export interface YahooRosterSlot {
  playerKey: string;
  /** Ephemeral display text. */
  playerName: string;
  /** Yahoo's slot code. `BN` is bench, `IR` is injured reserve. */
  selectedPosition: string;
  eligiblePositions: string[];
  displayPosition?: string;
  nflTeamAbbreviation?: string;
  injuryStatus?: string;
  /** Points under this league's scoring, when the roster was fetched with stats. */
  points?: number;
}

export interface YahooTeamRoster {
  teamKey: YahooTeamKey;
  week: number;
  slots: YahooRosterSlot[];
}

export interface YahooMatchupTeam {
  teamKey: YahooTeamKey;
  /** Ephemeral display text. Needed to render a matchup at all. */
  name?: string;
  points?: number;
  projectedPoints?: number;
  /**
   * Managers, carrying Yahoo's `is_current_login` flag.
   *
   * That flag is how the portal identifies which team belongs to the signed-in
   * user without requiring the commissioner to map anything first.
   */
  managers: YahooManager[];
}

export interface YahooMatchup {
  week: number;
  teams: YahooMatchupTeam[];
  isTied?: boolean;
  winnerTeamKey?: YahooTeamKey;
  status?: string;
}

/**
 * One row of the league standings.
 *
 * Ephemeral like everything else here. Displayed live and cached for minutes; a
 * season's final order is recorded separately as Dinkel's own data so that
 * draft-order tiebreakers survive past Yahoo's 24-hour retention window.
 */
export interface YahooStandingsRow {
  teamKey: YahooTeamKey;
  /** Ephemeral display text. */
  name: string;
  rank?: number;
  wins?: number;
  losses?: number;
  ties?: number;
  /** Yahoo's own formatted record string, e.g. "8-4-0". */
  recordLabel?: string;
  pointsFor?: number;
  pointsAgainst?: number;
  /** e.g. "W3" or "L1". Absent early in a season. */
  streak?: string;
  /** Games behind the division or league leader, when Yahoo reports it. */
  gamesBack?: string;
  managers: YahooManager[];
}

// --------------------------------------------------------------------------
// Parsers
// --------------------------------------------------------------------------

/**
 * Parses `/users;use_login=1` into the signed-in user's profile.
 *
 * The GUID is the one durable value: per Yahoo's terms it is storable
 * indefinitely, which is why portal identity is keyed on it. The nickname is
 * used once to prefill a display-name field and then dropped.
 */
export function parseUserProfile(body: unknown): YahooUserProfile {
  const users = descend(fantasyContent(body), ['users', 'user']);
  const user = users[0];
  if (!user) {
    return { guid: '' as YahooGuid };
  }

  const profile: YahooUserProfile = {
    guid: requireString(user, 'guid', 'users.user') as YahooGuid,
  };
  const nickname = optionalString(user, 'nickname');
  if (nickname !== undefined) profile.nickname = nickname;
  const email = optionalString(user, 'email');
  if (email !== undefined) profile.email = email;
  return profile;
}

/**
 * Parses the user's leagues from
 * `/users;use_login=1/games;game_codes=nfl/leagues`.
 *
 * The game key is read from the parent `game` node rather than split out of the
 * league key: `{game_key}.l.{league_id}` is a convention, not a documented
 * guarantee, and parsing it would break silently if Yahoo changed the format.
 */
export function parseUserLeagues(body: unknown): YahooLeagueSummary[] {
  const content = fantasyContent(body);
  const games = descend(content, ['users', 'user', 'games', 'game']);

  const summaries: YahooLeagueSummary[] = [];

  for (const game of games) {
    const gameKey = optionalString(game, 'game_key');
    for (const node of collect(game['leagues'])) {
      const league = mergeParts(pick(node, 'league') ?? node);
      if (Object.keys(league).length === 0) continue;

      const leagueKey = optionalString(league, 'league_key');
      if (!leagueKey) continue;

      summaries.push(toSummary(league, leagueKey as YahooLeagueKey, gameKey));
    }
  }

  return summaries;
}

/** Parses `/league/{league_key}/settings` (or a bare league resource). */
export function parseLeagueMetadata(body: unknown): YahooLeagueMetadata {
  const content = fantasyContent(body);
  const leagues = descend(content, ['league']);
  const league = leagues[0] ?? mergeParts(content['league']);

  const leagueKey = requireString(league, 'league_key', 'league') as YahooLeagueKey;
  const base = toSummary(league, leagueKey, optionalString(league, 'game_key'));

  // Settings arrive as a sibling node; merge so both shapes read the same.
  const settings = mergeParts(league['settings']);

  const metadata: YahooLeagueMetadata = { ...base };
  assign(metadata, 'currentWeek', optionalNumber(league, 'current_week'));
  assign(metadata, 'startWeek', optionalNumber(league, 'start_week'));
  assign(metadata, 'endWeek', optionalNumber(league, 'end_week'));
  assign(metadata, 'leagueType', optionalString(league, 'league_type'));
  assign(metadata, 'draftStatus', optionalString(league, 'draft_status'));
  assign(
    metadata,
    'playoffStartWeek',
    optionalNumber(settings, 'playoff_start_week') ?? optionalNumber(league, 'playoff_start_week'),
  );
  assign(
    metadata,
    'numPlayoffTeams',
    optionalNumber(settings, 'num_playoff_teams') ?? optionalNumber(league, 'num_playoff_teams'),
  );
  return metadata;
}

/** Parses `/league/{league_key}/teams`, including managers. */
export function parseLeagueTeams(body: unknown): YahooTeam[] {
  const content = fantasyContent(body);

  // The teams collection appears under a league, or at the top level when the
  // request targeted `/teams` directly.
  const fromLeague = descend(content, ['league', 'teams', 'team']);
  const teams = fromLeague.length > 0 ? fromLeague : descend(content, ['teams', 'team']);

  return teams.map((team) => parseTeam(team)).filter((team): team is YahooTeam => team !== null);
}

/**
 * Reads the managers attached to a team node.
 *
 * Shared by the teams, scoreboard, and standings parsers: Yahoo nests managers
 * identically in all three, and duplicating this is how `is_current_login`
 * quietly goes missing from one of them.
 */
function parseManagers(team: Record<string, Json>): YahooManager[] {
  const managers: YahooManager[] = [];

  for (const node of collect(team['managers'])) {
    const manager = mergeParts(pick(node, 'manager') ?? node);
    const nickname = optionalString(manager, 'nickname');
    if (nickname === undefined) continue;

    const parsed: YahooManager = { nickname };
    const guid = optionalString(manager, 'guid');
    if (guid !== undefined) parsed.guid = guid as YahooGuid;
    const isCommissioner = optionalBoolean(manager, 'is_commissioner');
    if (isCommissioner !== undefined) parsed.isCommissioner = isCommissioner;
    const isCurrentLogin = optionalBoolean(manager, 'is_current_login');
    if (isCurrentLogin !== undefined) parsed.isCurrentLogin = isCurrentLogin;
    managers.push(parsed);
  }

  return managers;
}

function parseTeam(team: Record<string, Json>): YahooTeam | null {
  const teamKey = optionalString(team, 'team_key');
  if (!teamKey) return null;

  const managers = parseManagers(team);

  const result: YahooTeam = {
    teamKey: teamKey as YahooTeamKey,
    name: optionalString(team, 'name') ?? '(unnamed team)',
    managers,
  };
  assign(result, 'teamId', optionalString(team, 'team_id'));
  assign(result, 'waiverPriority', optionalNumber(team, 'waiver_priority'));
  assign(result, 'numberOfMoves', optionalNumber(team, 'number_of_moves'));
  assign(result, 'numberOfTrades', optionalNumber(team, 'number_of_trades'));

  const logos = collect(team['team_logos']);
  for (const node of logos) {
    const logo = mergeParts(pick(node, 'team_logo') ?? node);
    const url = optionalString(logo, 'url');
    if (url) {
      result.logoUrl = url;
      break;
    }
  }

  return result;
}

/**
 * Parses `/team/{team_key}/roster;week={n}`.
 *
 * `selectedPosition` is what makes the Bench Mob challenge possible, and it is
 * exactly the field whose bench code (`BN`) is unverified against a real league —
 * see `yahoo-capabilities.json`. The parser reports whatever Yahoo sends rather
 * than normalizing it, so a surprise value is visible instead of swallowed.
 */
export function parseTeamRoster(body: unknown, fallbackWeek: number): YahooTeamRoster {
  const content = fantasyContent(body);
  const teams = descend(content, ['team']);
  const team = teams[0] ?? mergeParts(content['team']);

  const teamKey = requireString(team, 'team_key', 'team.roster') as YahooTeamKey;
  const roster = mergeParts(team['roster']);
  const week = optionalNumber(roster, 'week') ?? fallbackWeek;

  const slots: YahooRosterSlot[] = [];
  const players = descend(roster, ['players', 'player']);

  for (const player of players) {
    const playerKey = optionalString(player, 'player_key');
    if (!playerKey) continue;

    const nameNode = mergeParts(player['name']);
    const playerName =
      optionalString(nameNode, 'full') ?? optionalString(player, 'name') ?? '(unknown player)';

    const selected = mergeParts(player['selected_position']);
    const selectedPosition = optionalString(selected, 'position') ?? 'UNKNOWN';

    const eligible = collect(player['eligible_positions'])
      .map((node) => {
        const merged = mergeParts(node);
        return optionalString(merged, 'position') ?? (typeof node === 'string' ? node : undefined);
      })
      .filter((value): value is string => value !== undefined);

    const slot: YahooRosterSlot = {
      playerKey,
      playerName,
      selectedPosition,
      eligiblePositions: eligible,
    };
    assign(slot, 'displayPosition', optionalString(player, 'display_position'));
    assign(slot, 'nflTeamAbbreviation', optionalString(player, 'editorial_team_abbr'));
    assign(
      slot,
      'injuryStatus',
      optionalString(player, 'status_full') ?? optionalString(player, 'status'),
    );

    // Points appear under player_points when the roster was requested with stats.
    const points = mergeParts(player['player_points']);
    assign(slot, 'points', optionalNumber(points, 'total'));

    slots.push(slot);
  }

  return { teamKey, week, slots };
}

/** Parses `/league/{league_key}/scoreboard;week={n}`. */
export function parseScoreboard(body: unknown, fallbackWeek: number): YahooMatchup[] {
  const content = fantasyContent(body);
  const leagues = descend(content, ['league']);
  const league = leagues[0] ?? mergeParts(content['league']);
  const scoreboard = mergeParts(league['scoreboard']);

  const matchups: YahooMatchup[] = [];

  for (const node of collect(scoreboard['matchups'])) {
    const matchup = mergeParts(pick(node, 'matchup') ?? node);
    if (Object.keys(matchup).length === 0) continue;

    const teams: YahooMatchupTeam[] = [];
    for (const teamNode of descend(matchup, ['teams', 'team'])) {
      const teamKey = optionalString(teamNode, 'team_key');
      if (!teamKey) continue;

      const entry: YahooMatchupTeam = {
        teamKey: teamKey as YahooTeamKey,
        managers: parseManagers(teamNode),
      };
      assign(entry, 'name', optionalString(teamNode, 'name'));
      const points = mergeParts(teamNode['team_points']);
      assign(entry, 'points', optionalNumber(points, 'total'));
      const projected = mergeParts(teamNode['team_projected_points']);
      assign(entry, 'projectedPoints', optionalNumber(projected, 'total'));
      teams.push(entry);
    }

    const parsed: YahooMatchup = {
      week: optionalNumber(matchup, 'week') ?? fallbackWeek,
      teams,
    };
    assign(parsed, 'status', optionalString(matchup, 'status'));
    const isTied = optionalBoolean(matchup, 'is_tied');
    if (isTied !== undefined) parsed.isTied = isTied;
    const winner = optionalString(matchup, 'winner_team_key');
    if (winner !== undefined) parsed.winnerTeamKey = winner as YahooTeamKey;

    matchups.push(parsed);
  }

  return matchups;
}

/**
 * Parses `/league/{league_key}/standings`.
 *
 * Yahoo nests the record under `team_standings.outcome_totals` and points under
 * `team_points` / `team_standings.points_for`, and which of those is populated
 * varies. Both are read, preferring the standings block, because a half-filled
 * standings table is worse than none.
 *
 * Rank is taken from Yahoo when present and otherwise derived from array order,
 * which is the order Yahoo returns standings in.
 */
export function parseStandings(body: unknown): YahooStandingsRow[] {
  const content = fantasyContent(body);
  const leagues = descend(content, ['league']);
  const league = leagues[0] ?? mergeParts(content['league']);
  const standings = mergeParts(league['standings']);

  const teams = descend(standings, ['teams', 'team']);
  const rows: YahooStandingsRow[] = [];

  teams.forEach((team, index) => {
    const teamKey = optionalString(team, 'team_key');
    if (!teamKey) return;

    const teamStandings = mergeParts(team['team_standings']);
    const outcomes = mergeParts(teamStandings['outcome_totals']);

    const row: YahooStandingsRow = {
      teamKey: teamKey as YahooTeamKey,
      name: optionalString(team, 'name') ?? '(unnamed team)',
      managers: parseManagers(team),
      // Yahoo returns standings already ordered, so position is a safe fallback.
      rank: optionalNumber(teamStandings, 'rank') ?? index + 1,
    };

    assign(row, 'wins', optionalNumber(outcomes, 'wins'));
    assign(row, 'losses', optionalNumber(outcomes, 'losses'));
    assign(row, 'ties', optionalNumber(outcomes, 'ties'));
    assign(row, 'streak', describeStreak(mergeParts(teamStandings['streak'])));
    assign(row, 'gamesBack', optionalString(teamStandings, 'games_back'));

    assign(
      row,
      'pointsFor',
      optionalNumber(teamStandings, 'points_for') ??
        optionalNumber(mergeParts(team['team_points']), 'total'),
    );
    assign(row, 'pointsAgainst', optionalNumber(teamStandings, 'points_against'));

    if (row.wins !== undefined && row.losses !== undefined) {
      row.recordLabel = `${row.wins}-${row.losses}${row.ties ? `-${row.ties}` : ''}`;
    }

    rows.push(row);
  });

  return rows;
}

/** Yahoo reports a streak as `{ type: 'win', value: '3' }`. */
function describeStreak(streak: Record<string, Json>): string | undefined {
  const type = optionalString(streak, 'type');
  const value = optionalString(streak, 'value');
  if (!type || !value) return undefined;

  const letter = type.startsWith('win') ? 'W' : type.startsWith('loss') ? 'L' : 'T';
  return `${letter}${value}`;
}

function toSummary(
  league: Record<string, Json>,
  leagueKey: YahooLeagueKey,
  gameKey: string | undefined,
): YahooLeagueSummary {
  const summary: YahooLeagueSummary = {
    leagueKey,
    gameKey: (gameKey ?? optionalString(league, 'game_key') ?? '') as YahooGameKey,
    name: optionalString(league, 'name') ?? '(unnamed league)',
  };
  assign(summary, 'season', optionalNumber(league, 'season'));
  assign(summary, 'teamCount', optionalNumber(league, 'num_teams'));
  assign(summary, 'scoringType', optionalString(league, 'scoring_type'));
  assign(summary, 'url', optionalString(league, 'url'));

  // Yahoo's own commissioner flag. Recorded as a hint for the league-selection
  // UI only — it grants nothing in this portal, where roles are Dinkel-owned.
  const isCommissioner = optionalBoolean(league, 'is_commissioner');
  if (isCommissioner !== undefined) summary.isCommissioner = isCommissioner;

  const isFinished = optionalBoolean(league, 'is_finished');
  if (isFinished !== undefined) summary.isFinished = isFinished;

  return summary;
}

/** Assigns only when defined, so optional fields stay absent rather than undefined. */
function assign<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}
