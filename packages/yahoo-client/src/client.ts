import { AppError } from '@dinkel/shared';
import { needsRefresh, refreshAccessToken, type FetchLike, type TokenSet } from './oauth.js';
import {
  parseLeagueMetadata,
  parseLeagueTeams,
  parseScoreboard,
  parseStandings,
  parseTeamRoster,
  parseTransactions,
  parseUserLeagues,
  parseUserProfile,
  type YahooLeagueMetadata,
  type YahooLeagueSummary,
  type YahooMatchup,
  type YahooStandingsRow,
  type YahooTeam,
  type YahooTeamRoster,
  type YahooTransaction,
  type YahooUserProfile,
} from './resources.js';
import type { YahooLeagueKey, YahooTeamKey } from '@dinkel/shared';

export const YAHOO_FANTASY_BASE_URL = 'https://fantasysports.yahooapis.com/fantasy/v2';

/**
 * Yahoo Fantasy API client.
 *
 * Behaviors that exist because Yahoo publishes no rate limit (see
 * `yahoo-capabilities.json`): retry with exponential backoff and full jitter,
 * honour `Retry-After`, and treat 429 and 5xx as retryable while treating 4xx as
 * final. Being conservative costs a little latency; being wrong risks the API
 * access this whole portal depends on.
 */

export interface YahooClientOptions {
  fetchImpl: FetchLike;
  /** Base URL. Points at apps/mock-yahoo when YAHOO_MODE=mock. */
  baseUrl?: string;
  /** Supplies a valid access token, refreshing first when necessary. */
  getAccessToken: () => Promise<string>;
  /** Called after each request so the caller can record success or failure. */
  onRequestComplete?: (event: RequestCompletion) => void;
  maxAttempts?: number;
  /** Injectable so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter, for deterministic backoff tests. */
  random?: () => number;
}

export interface RequestCompletion {
  path: string;
  status: number | null;
  attempts: number;
  durationMs: number;
  ok: boolean;
  /** Error code when the request ultimately failed. */
  errorCode?: string;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export class YahooClient {
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly options: YahooClientOptions) {
    this.baseUrl = (options.baseUrl ?? YAHOO_FANTASY_BASE_URL).replace(/\/+$/, '');
    this.maxAttempts = options.maxAttempts ?? 3;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  /**
   * Issues a GET against a Fantasy resource path.
   *
   * @param path - Resource path with no leading slash, e.g.
   *   `users;use_login=1/games;game_codes=nfl/leagues`.
   */
  async get(path: string): Promise<unknown> {
    const url = this.buildUrl(path);
    const startedAt = Date.now();
    let lastError: AppError | null = null;
    let attempts = 0;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      attempts = attempt;
      const accessToken = await this.options.getAccessToken();

      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await this.options.fetchImpl(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
        });
      } catch (cause) {
        lastError = new AppError('yahoo_unavailable', { cause });
        if (attempt < this.maxAttempts) {
          await this.sleep(this.backoffMs(attempt, null));
          continue;
        }
        break;
      }

      if (response.ok) {
        const raw = await response.text();
        this.report({
          path,
          status: response.status,
          attempts,
          durationMs: Date.now() - startedAt,
          ok: true,
        });
        return this.parseJson(raw);
      }

      lastError = this.errorForStatus(response.status);

      if (RETRYABLE_STATUSES.has(response.status) && attempt < this.maxAttempts) {
        const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
        await this.sleep(this.backoffMs(attempt, retryAfter));
        continue;
      }

      break;
    }

    const error = lastError ?? new AppError('yahoo_unavailable');
    this.report({
      path,
      status: null,
      attempts,
      durationMs: Date.now() - startedAt,
      ok: false,
      errorCode: error.code,
    });
    throw error;
  }

  // ---------------------------------------------------------------- resources

  /** The signed-in user's profile. Only the GUID is retained by the caller. */
  async getUserProfile(): Promise<YahooUserProfile> {
    return parseUserProfile(await this.get('users;use_login=1'));
  }

  /**
   * The signed-in user's football leagues.
   *
   * `game_codes=nfl` restricts to football. Nothing about the game key, league
   * key, or season is hardcoded — whatever Yahoo returns is what the
   * commissioner chooses from.
   */
  async getUserFootballLeagues(): Promise<YahooLeagueSummary[]> {
    const body = await this.get('users;use_login=1/games;game_codes=nfl/leagues');
    return parseUserLeagues(body);
  }

  async getLeagueMetadata(leagueKey: YahooLeagueKey): Promise<YahooLeagueMetadata> {
    const body = await this.get(`league/${encodeURIComponent(leagueKey)}/settings`);
    return parseLeagueMetadata(body);
  }

  async getLeagueTeams(leagueKey: YahooLeagueKey): Promise<YahooTeam[]> {
    const body = await this.get(`league/${encodeURIComponent(leagueKey)}/teams`);
    return parseLeagueTeams(body);
  }

  /**
   * League standings.
   *
   * Displayed live only. A season's final order is recorded separately as
   * Dinkel's own data, because Yahoo standings cannot be retained past 24 hours.
   */
  async getStandings(leagueKey: YahooLeagueKey): Promise<YahooStandingsRow[]> {
    const body = await this.get(`league/${encodeURIComponent(leagueKey)}/standings`);
    return parseStandings(body);
  }

  async getScoreboard(leagueKey: YahooLeagueKey, week: number): Promise<YahooMatchup[]> {
    const body = await this.get(
      `league/${encodeURIComponent(leagueKey)}/scoreboard;week=${encodeURIComponent(String(week))}`,
    );
    return parseScoreboard(body, week);
  }

  /**
   * Recent league transactions: adds, drops, trades, waiver claims.
   *
   * Read-only. Yahoo documents no write operation for transactions, so the portal
   * displays them and never creates one.
   */
  async getTransactions(leagueKey: YahooLeagueKey, count = 25): Promise<YahooTransaction[]> {
    const body = await this.get(
      `league/${encodeURIComponent(leagueKey)}/transactions;count=${encodeURIComponent(String(count))}`,
    );
    return parseTransactions(body);
  }

  async getTeamRoster(teamKey: YahooTeamKey, week: number): Promise<YahooTeamRoster> {
    const body = await this.get(
      `team/${encodeURIComponent(teamKey)}/roster;week=${encodeURIComponent(String(week))}/players/stats;type=week;week=${encodeURIComponent(String(week))}`,
    );
    return parseTeamRoster(body, week);
  }

  /**
   * Walks a paginated Yahoo collection.
   *
   * Yahoo pages collections with `;start={n};count={m}` and signals the end by
   * returning fewer items than requested — there is no total count or next
   * cursor. A page returning exactly `pageSize` is therefore ambiguous, so the
   * loop makes one more request and stops on the short or empty page.
   *
   * `maxPages` is a hard stop. Without it a Yahoo change to the paging contract
   * would turn this into an unbounded request loop against a rate-limited API.
   *
   * @param buildPath - Receives start and count, returns the resource path.
   * @param parsePage - Parses one response into items.
   */
  async getPaginated<T>(
    buildPath: (start: number, count: number) => string,
    parsePage: (body: unknown) => T[],
    options: { pageSize?: number; maxPages?: number } = {},
  ): Promise<T[]> {
    const pageSize = options.pageSize ?? 25;
    const maxPages = options.maxPages ?? 40;

    const items: T[] = [];

    for (let page = 0; page < maxPages; page += 1) {
      const body = await this.get(buildPath(page * pageSize, pageSize));
      const pageItems = parsePage(body);
      items.push(...pageItems);

      if (pageItems.length < pageSize) return items;
    }

    return items;
  }

  /**
   * Rosters for many teams.
   *
   * Sequential on purpose. Yahoo publishes no concurrency guidance, and a
   * twelve-team league fanning out twelve simultaneous requests is exactly the
   * pattern that earns a block. Challenge calculation is scheduled work, so the
   * extra seconds cost nothing a user notices.
   */
  async getRostersForTeams(
    teamKeys: readonly YahooTeamKey[],
    week: number,
  ): Promise<YahooTeamRoster[]> {
    const rosters: YahooTeamRoster[] = [];
    for (const teamKey of teamKeys) {
      rosters.push(await this.getTeamRoster(teamKey, week));
    }
    return rosters;
  }

  // ------------------------------------------------------------------ private

  private buildUrl(path: string): string {
    const clean = path.replace(/^\/+/, '');
    // format=json is required; Yahoo returns XML by default.
    const separator = clean.includes('?') ? '&' : '?';
    return `${this.baseUrl}/${clean}${separator}format=json`;
  }

  private parseJson(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch (cause) {
      throw new AppError('yahoo_unexpected_response', {
        detail: { reason: 'response_not_json' },
        cause,
      });
    }
  }

  private errorForStatus(status: number): AppError {
    if (status === 401) {
      // The access token was rejected. The token provider refreshes proactively,
      // so a 401 here means the grant itself is gone — reconnect, do not retry.
      return new AppError('yahoo_needs_reconnect', { detail: { status } });
    }
    if (status === 403) {
      return new AppError('forbidden', {
        publicMessage: 'Yahoo refused access to that league for this account.',
        detail: { status },
      });
    }
    if (status === 404) {
      return new AppError('not_found', {
        publicMessage: 'Yahoo has no such league or team.',
        detail: { status },
      });
    }
    if (status === 429) {
      return new AppError('yahoo_rate_limited', { detail: { status } });
    }
    if (status >= 500) {
      return new AppError('yahoo_unavailable', { detail: { status } });
    }
    return new AppError('yahoo_unexpected_response', { detail: { status } });
  }

  /**
   * Exponential backoff with full jitter, or `Retry-After` when Yahoo sent one.
   *
   * Full jitter rather than a fixed multiplier: several Lambdas retrying on the
   * same schedule would re-collide at every step.
   */
  private backoffMs(attempt: number, retryAfterSeconds: number | null): number {
    if (retryAfterSeconds !== null) {
      return Math.min(retryAfterSeconds * 1000, 30_000);
    }
    const ceiling = Math.min(1000 * 2 ** (attempt - 1), 8000);
    return Math.floor(this.random() * ceiling) + 100;
  }

  private report(event: RequestCompletion): void {
    this.options.onRequestComplete?.(event);
  }
}

/** `Retry-After` is either delta-seconds or an HTTP date. Both are accepted. */
export function parseRetryAfter(value: string | null, nowMs: number = Date.now()): number | null {
  if (!value) return null;

  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;

  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.ceil((date - nowMs) / 1000));
  }
  return null;
}

/**
 * Builds a token provider that refreshes before expiry and persists rotation.
 *
 * Concurrency-safe within one Lambda invocation: parallel callers share a single
 * in-flight refresh, so twelve roster reads cannot trigger twelve refreshes and
 * race each other into an invalid_grant.
 */
export function createTokenProvider(options: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  loadTokens: () => Promise<TokenSet>;
  saveTokens: (tokens: TokenSet) => Promise<void>;
  fetchImpl: FetchLike;
  now?: () => number;
}): () => Promise<string> {
  let inFlight: Promise<TokenSet> | null = null;

  return async function getAccessToken(): Promise<string> {
    const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
    const current = await options.loadTokens();

    if (!needsRefresh(current.expiresAtEpochSeconds, now)) {
      return current.accessToken;
    }

    inFlight ??= (async () => {
      try {
        const refreshed = await refreshAccessToken(
          {
            clientId: options.clientId,
            clientSecret: options.clientSecret,
            redirectUri: options.redirectUri,
            refreshToken: current.refreshToken,
            nowEpochSeconds: now,
          },
          options.fetchImpl,
        );
        await options.saveTokens(refreshed);
        return refreshed;
      } finally {
        inFlight = null;
      }
    })();

    return (await inFlight).accessToken;
  };
}
