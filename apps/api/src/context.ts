import { AppError, type InternalId, type PortalRole } from '@dinkel/shared';
import type { FetchLike } from '@dinkel/yahoo-client';
import type { AppConfig } from './config.js';
import type { Logger } from './lib/logger.js';
import type { Table } from './lib/table.js';
import type { Repositories } from './repositories.js';
import type { YahooService } from './services/yahoo-service.js';
import type { Principal } from './lib/authorization.js';

/**
 * Per-request context, carried on Hono's context so handlers stay free of
 * construction logic.
 */
export interface RequestContext {
  config: AppConfig;
  table: Table;
  repositories: Repositories;
  yahoo: YahooService;
  logger: Logger;
  correlationId: string;
  principal: Principal | null;
  /** The single league this deployment serves. Resolved once at bootstrap. */
  leagueId: InternalId | null;
  /**
   * HTTP transport for direct Yahoo calls, already mock-aware.
   *
   * On the context rather than imported per route: the OAuth callback needs a
   * transport before a `YahooService` exists, and a route reaching for its own
   * `fetch` would silently bypass whatever the app was configured with.
   */
  yahooFetch: FetchLike;
}

export type AppEnv = {
  Variables: {
    ctx: RequestContext;
  };
};

/**
 * The league the request operates on.
 *
 * @throws {AppError} `not_found` before setup has run, which is what a fresh
 *   deployment looks like and needs a clear message rather than a 500.
 */
export function requireLeagueId(ctx: RequestContext): InternalId {
  if (!ctx.leagueId) {
    throw new AppError('not_found', {
      publicMessage: 'The portal has not been set up yet. Complete commissioner setup first.',
      detail: { reason: 'league_not_bootstrapped' },
    });
  }
  return ctx.leagueId;
}

/** Role of the actor for an audit record, or `system` for scheduled work. */
export function actorRole(principal: Principal | null): PortalRole | 'system' {
  return principal?.role ?? 'system';
}
