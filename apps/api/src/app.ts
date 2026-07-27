import { Hono } from 'hono';
import { AppError, isAppError, type InternalId } from '@dinkel/shared';
import type { FetchLike } from '@dinkel/yahoo-client';
import { loadConfig, type AppConfig } from './config.js';
import type { AppEnv, RequestContext } from './context.js';
import { createLogger, describeError, type Logger } from './lib/logger.js';
import { Table } from './lib/table.js';
import { createRepositories, type Repositories } from './repositories.js';
import { defaultFetch, mockAwareFetch, YahooService } from './services/yahoo-service.js';
import { assertCsrf, CSRF_HEADER, parseCookies, SESSION_COOKIE } from './lib/cookies.js';
import { authRoutes } from './routes/auth.js';
import { yahooRoutes } from './routes/yahoo.js';
import { leagueOpsRoutes } from './routes/league-ops.js';
import { challengeRoutes } from './routes/challenges.js';
import { draftRoutes } from './routes/draft.js';
import { importRoutes } from './routes/imports.js';

/**
 * Application assembly.
 *
 * Middleware order matters and is deliberate:
 *   1. correlation ID and logger, so everything after can be traced
 *   2. security headers, applied even to error responses
 *   3. CORS, before any handler can respond
 *   4. context construction
 *   5. session resolution
 *   6. CSRF, on state-changing methods only
 *   7. routes
 *   8. error mapping, which must be outermost to catch everything
 */

export interface CreateAppOptions {
  config?: AppConfig;
  /** Injectable, so tests can supply an in-memory table. */
  table?: Table;
  repositories?: Repositories;
  logger?: Logger;
  /**
   * Injectable HTTP transport for Yahoo calls.
   *
   * Lets integration tests route Yahoo requests straight into the mock handlers
   * without opening a socket, so route behavior is testable end to end.
   */
  fetchImpl?: FetchLike;
}

export function createApp(options: CreateAppOptions = {}): Hono<AppEnv> {
  const config = options.config ?? loadConfig();
  const app = new Hono<AppEnv>();

  const table =
    options.table ??
    new Table({
      tableName: config.env.DYNAMODB_TABLE_NAME,
      region: config.env.AWS_REGION,
      ...(config.env.DYNAMODB_ENDPOINT ? { endpoint: config.env.DYNAMODB_ENDPOINT } : {}),
    });

  const repositories = options.repositories ?? createRepositories(table);

  // Resolved once: the injected transport if one was given, otherwise real fetch,
  // wrapped so mock mode redirects Yahoo's OAuth host to the local mock server.
  const baseFetch = options.fetchImpl ?? defaultFetch;
  const yahooFetch =
    config.yahooOAuthBaseUrl === null
      ? baseFetch
      : mockAwareFetch(baseFetch, config.yahooOAuthBaseUrl);

  // ---------------------------------------------------------------- 1. logging
  app.use('*', async (c, next) => {
    // Reuse the API Gateway request ID when present, so a log line can be tied
    // to an access log entry.
    const correlationId =
      c.req.header('x-amzn-trace-id') ??
      c.req.header('x-request-id') ??
      `req_${Math.random().toString(36).slice(2, 12)}`;

    const logger = (
      options.logger ?? createLogger({ level: config.env.LOG_LEVEL, correlationId })
    ).child({
      method: c.req.method,
      path: new URL(c.req.url).pathname,
    });

    c.set('ctx', {
      config,
      table,
      repositories,
      yahoo: new YahooService({
        config,
        connections: repositories.connections,
        table,
        logger,
        fetchImpl: baseFetch,
      }),
      logger,
      correlationId,
      principal: null,
      leagueId: null,
      yahooFetch,
    } satisfies RequestContext);

    const startedAt = Date.now();
    await next();
    logger.info('request complete', { status: c.res.status, durationMs: Date.now() - startedAt });
  });

  // ------------------------------------------------------- 2. security headers
  app.use('*', async (c, next) => {
    await next();

    // The API serves JSON only, so the CSP can be maximally restrictive: nothing
    // should ever be loaded or framed from these responses.
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    // API responses are per-user and must never be shared by a cache.
    c.header('Cache-Control', 'no-store');
    if (config.env.NODE_ENV === 'production') {
      c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  });

  // ------------------------------------------------------------------- 3. CORS
  app.use('*', async (c, next) => {
    const origin = c.req.header('Origin');

    // An explicit allowlist of exactly one origin. A wildcard cannot be used
    // with credentialed requests, and reflecting the request origin would defeat
    // the point of having a policy.
    if (origin && origin === config.env.APP_BASE_URL) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Access-Control-Allow-Headers', `Content-Type, ${CSRF_HEADER}`);
      c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      c.header('Vary', 'Origin');
    }

    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    return next();
  });

  /**
   * Liveness check, registered before session resolution so it touches nothing.
   *
   * A health check that fails when DynamoDB is unreachable cannot distinguish
   * "the process is dead" from "a dependency is down", which is exactly the
   * distinction a health check exists to make.
   */
  app.get('/health', (c) =>
    c.json({
      ok: true,
      yahooMode: config.env.YAHOO_MODE,
      environment: config.env.NODE_ENV,
    }),
  );

  // --------------------------------------------------- 4/5. session resolution
  app.use('*', async (c, next) => {
    const ctx = c.get('ctx');

    // The single league this deployment serves, resolved per request so a
    // bootstrap during the process lifetime is picked up.
    ctx.leagueId = await resolveLeagueId(repositories);

    const sessionId = parseCookies(c.req.header('Cookie'))[SESSION_COOKIE];
    if (!sessionId) return next();

    const session = await repositories.sessions.find(sessionId);
    if (!session) {
      // Expired or revoked. Not an error here: unauthenticated routes still work,
      // and the ones that need a principal will say so.
      ctx.logger.debug('session not found or expired');
      return next();
    }

    const user = await repositories.users.findById(session.userId);
    if (!user || user.status === 'disabled') {
      // A disabled user's session is dead immediately, not at expiry.
      await repositories.sessions.revoke(sessionId);
      return next();
    }

    ctx.principal = {
      userId: user.userId,
      role: user.role,
      isPrimaryCommissioner: user.isPrimaryCommissioner,
      leagueId: ctx.leagueId ?? '',
      sessionId,
    };

    ctx.logger = ctx.logger.child({ userId: user.userId, role: user.role });

    return next();
  });

  // ------------------------------------------------------------------- 6. CSRF
  app.use('*', async (c, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();

    // Bootstrap and OAuth callbacks arrive before any CSRF cookie exists, and
    // the callback is a GET anyway. Everything else that changes state is checked.
    assertCsrf(c.req.header('Cookie'), c.req.header(CSRF_HEADER) ?? null);
    return next();
  });

  // ----------------------------------------------------------------- 7. routes
  app.route('/', authRoutes);
  app.route('/', yahooRoutes);
  app.route('/', leagueOpsRoutes);
  app.route('/', challengeRoutes);
  app.route('/', draftRoutes);
  app.route('/', importRoutes);

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such endpoint.' } }, 404));

  // ------------------------------------------------------------ 8. error shape
  app.onError((error, c) => {
    const ctx = c.get('ctx');
    const logger = ctx?.logger ?? createLogger({ correlationId: 'unknown' });

    if (isAppError(error)) {
      // Client mistakes are not warnings worth paging anyone about; server-side
      // and upstream failures are.
      const level = error.status >= 500 ? 'error' : 'info';
      logger[level]('request failed', {
        errorCode: error.code,
        status: error.status,
        ...error.detail,
      });

      return c.json(error.toResponseBody(), error.status as 400);
    }

    // Unexpected: log everything, return nothing. A stack trace or a database
    // message in a response body is an information leak.
    logger.error('unhandled error', describeError(error));

    const safe = new AppError('internal_error');
    return c.json(safe.toResponseBody(), 500);
  });

  return app;
}

/**
 * Finds the league this deployment serves.
 *
 * Reads the singleton pointer written once at bootstrap. The data model is
 * league-scoped throughout so multi-league support needs no migration, but
 * resolving it here keeps every route from having to ask.
 */
async function resolveLeagueId(repositories: Repositories): Promise<InternalId | null> {
  return repositories.leagues.findCurrentLeagueId();
}

export { loadConfig };
