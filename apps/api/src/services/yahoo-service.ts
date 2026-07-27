import {
  AppError,
  ttlForResource,
  type InternalId,
  type YahooConnection,
  type YahooLeagueKey,
  type YahooTeamKey,
} from '@dinkel/shared';
import {
  createTokenProvider,
  YahooClient,
  type FetchLike,
  type TokenSet,
  type YahooLeagueMetadata,
  type YahooLeagueSummary,
  type YahooMatchup,
  type YahooStandingsRow,
  type YahooTeam,
  type YahooTeamRoster,
  type YahooTransaction,
  type YahooUserProfile,
} from '@dinkel/yahoo-client';
import type { AppConfig } from '../config.js';
import { decryptToken, DecryptionError, encryptToken } from '../lib/crypto.js';
import type { Logger } from '../lib/logger.js';
import type { ConnectionRepository } from '../repositories.js';
import type { Table } from '../lib/table.js';

/**
 * Yahoo access for one connected user.
 *
 * Owns three things the routes should not each reimplement: decrypting tokens,
 * refreshing them (persisting rotation), and caching responses under a TTL that
 * cannot exceed the 24 hours Yahoo's terms allow.
 *
 * Every read here is ephemeral. Nothing fetched is written to a permanent entity.
 */

export interface YahooServiceOptions {
  config: AppConfig;
  connections: ConnectionRepository;
  table: Table;
  logger: Logger;
  fetchImpl?: FetchLike;
}

export class YahooService {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: YahooServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
  }

  /**
   * Builds a client for a user's connection.
   *
   * @throws {AppError} `yahoo_not_connected` when there is no connection, or
   *   `yahoo_needs_reconnect` when the stored tokens cannot be decrypted — which
   *   happens after a `TOKEN_ENCRYPTION_KEY` rotation and is a reconnect, not a bug.
   */
  async clientFor(
    userId: InternalId,
  ): Promise<{ client: YahooClient; connection: YahooConnection }> {
    const connection = await this.options.connections.find(userId);

    if (!connection) throw new AppError('yahoo_not_connected');
    if (connection.status === 'revoked') {
      throw new AppError('yahoo_not_connected', {
        publicMessage: 'That Yahoo connection was removed. Connect again to load league data.',
      });
    }

    const { env } = this.options.config;

    const loadTokens = async (): Promise<TokenSet> => {
      const current = await this.options.connections.find(userId);
      if (!current) throw new AppError('yahoo_not_connected');

      try {
        return {
          accessToken: decryptToken(current.encryptedAccessToken, env.TOKEN_ENCRYPTION_KEY),
          refreshToken: decryptToken(current.encryptedRefreshToken, env.TOKEN_ENCRYPTION_KEY),
          expiresAtEpochSeconds: Math.floor(
            new Date(`${current.accessTokenExpiresAt}Z`).getTime() / 1000,
          ),
          refreshTokenRotated: false,
        };
      } catch (error) {
        if (error instanceof DecryptionError) {
          this.options.logger.warn('stored Yahoo tokens could not be decrypted', {
            userId,
            reason: 'decryption_failed',
          });
          await this.markNeedsReconnect(current, 'Stored credentials could not be read.');
          throw new AppError('yahoo_needs_reconnect', {
            publicMessage:
              'Your saved Yahoo credentials could not be read. Reconnect your Yahoo account.',
          });
        }
        throw error;
      }
    };

    const saveTokens = async (tokens: TokenSet): Promise<void> => {
      const current = await this.options.connections.find(userId);
      if (!current) return;

      await this.options.connections.saveTokens({
        ...current,
        encryptedAccessToken: encryptToken(tokens.accessToken, env.TOKEN_ENCRYPTION_KEY),
        encryptedRefreshToken: encryptToken(tokens.refreshToken, env.TOKEN_ENCRYPTION_KEY),
        accessTokenExpiresAt: isoFromEpoch(tokens.expiresAtEpochSeconds),
        refreshTokenRotations: current.refreshTokenRotations + (tokens.refreshTokenRotated ? 1 : 0),
        lastRefreshedAt: isoNow(),
        status: 'active',
        ...(tokens.scope === undefined ? {} : { grantedScope: tokens.scope }),
      });

      this.options.logger.info('Yahoo access token refreshed', {
        userId,
        // Whether rotation happened is worth recording: Yahoo documents it as
        // optional, so this is evidence of actual behavior.
        refreshTokenRotated: tokens.refreshTokenRotated,
      });
    };

    const tokenUrlBase = this.options.config.yahooOAuthBaseUrl;

    const client = new YahooClient({
      fetchImpl: tokenUrlBase ? mockAwareFetch(this.fetchImpl, tokenUrlBase) : this.fetchImpl,
      baseUrl: this.options.config.yahooApiBaseUrl,
      getAccessToken: createTokenProvider({
        clientId: env.YAHOO_CLIENT_ID,
        clientSecret: env.YAHOO_CLIENT_SECRET,
        redirectUri: env.YAHOO_REDIRECT_URI,
        loadTokens,
        saveTokens,
        fetchImpl: tokenUrlBase ? mockAwareFetch(this.fetchImpl, tokenUrlBase) : this.fetchImpl,
      }),
      onRequestComplete: (event) => {
        this.options.logger.info('Yahoo request complete', {
          path: event.path,
          status: event.status,
          attempts: event.attempts,
          durationMs: event.durationMs,
          ok: event.ok,
          ...(event.errorCode ? { errorCode: event.errorCode } : {}),
        });

        // Recorded so the dashboard can show "last successful Yahoo request"
        // without the frontend having to guess from a failed page load.
        void this.recordOutcome(userId, event.ok, event.errorCode);
      },
    });

    return { client, connection };
  }

  /** The signed-in user's profile. Only the GUID is retained by the caller. */
  async getUserProfile(userId: InternalId): Promise<YahooUserProfile> {
    const { client } = await this.clientFor(userId);
    return client.getUserProfile();
  }

  async getLeagues(
    userId: InternalId,
    options: { refresh?: boolean } = {},
  ): Promise<YahooLeagueSummary[]> {
    return this.cached(
      `user_leagues:${userId}`,
      'user_leagues',
      options.refresh ?? false,
      async () => {
        const { client } = await this.clientFor(userId);
        return client.getUserFootballLeagues();
      },
    );
  }

  async getLeagueMetadata(
    userId: InternalId,
    leagueKey: YahooLeagueKey,
    options: { refresh?: boolean } = {},
  ): Promise<YahooLeagueMetadata> {
    return this.cached(
      `league_metadata:${leagueKey}`,
      'league_metadata',
      options.refresh ?? false,
      async () => {
        const { client } = await this.clientFor(userId);
        return client.getLeagueMetadata(leagueKey);
      },
    );
  }

  async getLeagueTeams(
    userId: InternalId,
    leagueKey: YahooLeagueKey,
    options: { refresh?: boolean } = {},
  ): Promise<YahooTeam[]> {
    return this.cached(
      `league_teams:${leagueKey}`,
      'league_teams',
      options.refresh ?? false,
      async () => {
        const { client } = await this.clientFor(userId);
        return client.getLeagueTeams(leagueKey);
      },
    );
  }

  async getStandings(
    userId: InternalId,
    leagueKey: YahooLeagueKey,
    options: { refresh?: boolean } = {},
  ): Promise<YahooStandingsRow[]> {
    return this.cached(
      `standings:${leagueKey}`,
      'standings',
      options.refresh ?? false,
      async () => {
        const { client } = await this.clientFor(userId);
        return client.getStandings(leagueKey);
      },
    );
  }

  async getScoreboard(
    userId: InternalId,
    leagueKey: YahooLeagueKey,
    week: number,
    options: { refresh?: boolean } = {},
  ): Promise<YahooMatchup[]> {
    return this.cached(
      `scoreboard:${leagueKey}:${week}`,
      'scoreboard',
      options.refresh ?? false,
      async () => {
        const { client } = await this.clientFor(userId);
        return client.getScoreboard(leagueKey, week);
      },
    );
  }

  async getRosters(
    userId: InternalId,
    teamKeys: readonly YahooTeamKey[],
    week: number,
    options: { refresh?: boolean } = {},
  ): Promise<YahooTeamRoster[]> {
    const rosters: YahooTeamRoster[] = [];

    for (const teamKey of teamKeys) {
      rosters.push(
        await this.cached(
          `roster:${teamKey}:${week}`,
          'roster',
          options.refresh ?? false,
          async () => {
            const { client } = await this.clientFor(userId);
            return client.getTeamRoster(teamKey, week);
          },
        ),
      );
    }

    return rosters;
  }

  /**
   * Recent league transactions.
   *
   * Read-only: Yahoo documents no way to create a transaction through the API, so
   * the portal shows the league's moves and never makes one.
   */
  async getTransactions(
    userId: InternalId,
    leagueKey: YahooLeagueKey,
    options: { refresh?: boolean; count?: number } = {},
  ): Promise<YahooTransaction[]> {
    const count = options.count ?? 25;
    return this.cached(
      `transactions:${leagueKey}:${count}`,
      'transactions',
      options.refresh ?? false,
      async () => {
        const { client } = await this.clientFor(userId);
        return client.getTransactions(leagueKey, count);
      },
    );
  }

  /** One team's roster. A thin wrapper over {@link getRosters} for the common case. */
  async getRoster(
    userId: InternalId,
    teamKey: YahooTeamKey,
    week: number,
    options: { refresh?: boolean } = {},
  ): Promise<YahooTeamRoster> {
    const [roster] = await this.getRosters(userId, [teamKey], week, options);
    if (!roster) {
      throw new AppError('yahoo_unexpected_response', {
        publicMessage: 'Yahoo returned no roster for that team.',
      });
    }
    return roster;
  }

  /**
   * Clears cached league reads, backing the dashboard's manual refresh button.
   *
   * Scoreboard keys are week-scoped, so the caller passes the weeks currently on
   * screen rather than this guessing at them.
   */
  async invalidateLeague(
    leagueKey: YahooLeagueKey,
    userId: InternalId,
    weeks: readonly number[] = [],
  ): Promise<void> {
    await this.options.table.invalidateCache([
      `user_leagues:${userId}`,
      `league_metadata:${leagueKey}`,
      `league_teams:${leagueKey}`,
      `standings:${leagueKey}`,
      ...weeks.map((week) => `scoreboard:${leagueKey}:${week}`),
    ]);
  }

  /**
   * Reads through the TTL cache.
   *
   * The TTL comes from the resource's entry in the shared table, which is itself
   * validated against the 24-hour ceiling — so no call site can accidentally cache
   * Yahoo data longer than the terms allow.
   */
  private async cached<T>(
    cacheKey: string,
    resource: Parameters<typeof ttlForResource>[0],
    refresh: boolean,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    if (!refresh) {
      const hit = await this.options.table.getCached<T>(cacheKey);
      if (hit !== null) {
        this.options.logger.debug('Yahoo cache hit', { cacheKey, resource });
        return hit;
      }
    }

    const value = await fetcher();
    await this.options.table.putCached(cacheKey, resource, value, ttlForResource(resource));
    return value;
  }

  private async recordOutcome(userId: InternalId, ok: boolean, errorCode?: string): Promise<void> {
    try {
      const connection = await this.options.connections.find(userId);
      if (!connection) return;

      await this.options.connections.saveTokens({
        ...connection,
        ...(ok
          ? { lastSuccessAt: isoNow(), status: 'active' as const }
          : {
              lastFailureAt: isoNow(),
              lastFailureReason: errorCode ?? 'unknown',
              status:
                errorCode === 'yahoo_needs_reconnect'
                  ? ('needs_reconnect' as const)
                  : connection.status,
            }),
      });
    } catch (error) {
      // Recording an outcome must never fail the request it was describing.
      this.options.logger.warn('could not record Yahoo request outcome', {
        userId,
        reason: String(error instanceof Error ? error.name : error),
      });
    }
  }

  private async markNeedsReconnect(connection: YahooConnection, reason: string): Promise<void> {
    await this.options.connections.saveTokens({
      ...connection,
      status: 'needs_reconnect',
      lastFailureAt: isoNow(),
      lastFailureReason: reason,
    });
  }
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '');
}

function isoFromEpoch(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, '');
}

/**
 * Redirects Yahoo's OAuth host to the mock server in mock mode.
 *
 * The client and OAuth helpers hardcode Yahoo's real endpoints, which is correct —
 * they are documented constants, not configuration. Rewriting here keeps mock mode
 * from leaking a "base URL" parameter into the OAuth module.
 */
function mockAwareFetch(inner: FetchLike, mockBaseUrl: string): FetchLike {
  return (url, init) => {
    const rewritten = url.startsWith('https://api.login.yahoo.com')
      ? url.replace('https://api.login.yahoo.com', mockBaseUrl)
      : url;
    return inner(rewritten, init);
  };
}

const defaultFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });

  return {
    status: response.status,
    ok: response.ok,
    text: () => response.text(),
    headers: { get: (name: string) => response.headers.get(name) },
  };
};

export { defaultFetch, mockAwareFetch };
