import { Hono } from 'hono';
import {
  AppError,
  generateId,
  portalRoleSchema,
  type InternalId,
  type PortalUser,
  type YahooGuid,
} from '@dinkel/shared';
import {
  buildAuthorizeUrl,
  createOAuthState,
  exchangeCodeForTokens,
  validateOAuthState,
} from '@dinkel/yahoo-client';
import { z } from 'zod';
import type { AppEnv, RequestContext } from '../context.js';
import { requireLeagueId } from '../context.js';
import {
  requireAuthenticated,
  requireCommissioner,
  requirePrimaryCommissioner,
  requireSelfOrCommissioner,
} from '../lib/authorization.js';
import {
  buildClearCookies,
  buildCsrfCookie,
  buildSessionCookie,
  SESSION_TTL_SECONDS,
} from '../lib/cookies.js';
import {
  generateCsrfToken,
  generateSessionId,
  sha256Hex,
  generateInviteToken,
} from '../lib/crypto.js';
import { created, now } from '../repositories.js';

/**
 * Authentication, the Yahoo OAuth flow, and role management.
 *
 * Portal identity is the Yahoo GUID, the one Yahoo value the terms allow storing
 * indefinitely. Portal ROLES are Dinkel's own and are set here â€” Yahoo commissioner
 * status grants nothing.
 */

export const authRoutes = new Hono<AppEnv>();

/**
 * Starts the OAuth flow.
 *
 * The redirect URI comes from validated configuration, never from a request
 * header: deriving it from Host or Origin is how an open redirect becomes account
 * takeover.
 */
authRoutes.get('/auth/yahoo/start', async (c) => {
  const ctx = c.get('ctx');
  const { env } = ctx.config;

  const returnTo = sanitizeReturnTo(c.req.query('returnTo'));

  const state = createOAuthState({
    returnTo,
    ...(ctx.principal ? { sessionId: ctx.principal.sessionId } : {}),
  });

  await ctx.repositories.oauthStates.create(state);

  const authorizeUrl = buildAuthorizeUrl({
    clientId: env.YAHOO_CLIENT_ID,
    redirectUri: env.YAHOO_REDIRECT_URI,
    state: state.state,
    // Read-only Fantasy scope. The portal never requests write access; no Yahoo
    // write endpoint is documented, and read/write would not prove otherwise.
    scope: 'fspt-r',
  });

  const target =
    ctx.config.yahooOAuthBaseUrl === null
      ? authorizeUrl
      : authorizeUrl.replace('https://api.login.yahoo.com', ctx.config.yahooOAuthBaseUrl);

  ctx.logger.info('Yahoo OAuth started', { yahooMode: env.YAHOO_MODE, returnTo });

  // 302, not a JSON body with a URL: this must be a top-level navigation so the
  // user sees Yahoo's own consent screen on Yahoo's own domain.
  return c.redirect(target, 302);
});

/**
 * Handles Yahoo's callback.
 *
 * Redirects to the frontend with a short status code in the query rather than
 * rendering an error page: the API is not the app, and the app can present the
 * failure in context with a retry.
 */
authRoutes.get('/auth/yahoo/callback', async (c) => {
  const ctx = c.get('ctx');
  const { env } = ctx.config;

  const errorParam = c.req.query('error');
  const code = c.req.query('code');
  const stateParam = c.req.query('state');

  const stored = stateParam ? await ctx.repositories.oauthStates.find(stateParam) : null;
  const returnTo = sanitizeReturnTo(stored?.returnTo);

  // The user declined on Yahoo's screen. Not an error worth alarming about.
  if (errorParam) {
    ctx.logger.info('Yahoo OAuth denied by user', { reason: errorParam.slice(0, 60) });
    if (stateParam) await ctx.repositories.oauthStates.consume(stateParam);
    return c.redirect(frontendUrl(env.APP_BASE_URL, returnTo, 'oauth_denied'), 302);
  }

  try {
    validateOAuthState(stateParam, stored);
  } catch (error) {
    const code_ = error instanceof AppError ? error.code : 'oauth_state_invalid';
    ctx.logger.warn('Yahoo OAuth state rejected', { reason: code_ });
    return c.redirect(frontendUrl(env.APP_BASE_URL, returnTo, code_), 302);
  }

  if (!code) {
    await ctx.repositories.oauthStates.consume(stateParam!);
    return c.redirect(frontendUrl(env.APP_BASE_URL, returnTo, 'oauth_exchange_failed'), 302);
  }

  // Consumed before the exchange, so a duplicated callback cannot run the
  // exchange twice even if the first is still in flight.
  await ctx.repositories.oauthStates.consume(stateParam!);

  try {
    const tokens = await exchangeCodeForTokens(
      {
        clientId: env.YAHOO_CLIENT_ID,
        clientSecret: env.YAHOO_CLIENT_SECRET,
        redirectUri: env.YAHOO_REDIRECT_URI,
        code,
      },
      ctx.yahooFetch,
    );

    const { userId, isNewUser, prefillDisplayName } = await establishIdentity(ctx, tokens);

    const sessionId = generateSessionId();
    const csrfToken = generateCsrfToken();

    await ctx.repositories.sessions.create({
      sessionId,
      userId,
      csrfToken,
      expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    });

    const secure = env.APP_BASE_URL.startsWith('https://');
    c.header(
      'Set-Cookie',
      buildSessionCookie(sessionId, { secure, maxAgeSeconds: SESSION_TTL_SECONDS }),
      {
        append: true,
      },
    );
    c.header(
      'Set-Cookie',
      buildCsrfCookie(csrfToken, { secure, maxAgeSeconds: SESSION_TTL_SECONDS }),
      {
        append: true,
      },
    );

    ctx.logger.info('Yahoo OAuth completed', { userId, isNewUser });

    const destination = new URL(returnTo, env.APP_BASE_URL);
    if (isNewUser && prefillDisplayName) {
      // The display name is confirmed by the user, at which point it becomes
      // Dinkel's own data rather than retained Yahoo content.
      destination.searchParams.set('welcome', '1');
    }

    return c.redirect(destination.toString(), 302);
  } catch (error) {
    const errorCode = error instanceof AppError ? error.code : 'oauth_exchange_failed';
    ctx.logger.error('Yahoo OAuth exchange failed', {
      reason: errorCode,
      // Yahoo's error body is deliberately not attached: it can echo request
      // parameters, and this line goes to CloudWatch.
    });
    return c.redirect(frontendUrl(env.APP_BASE_URL, returnTo, errorCode), 302);
  }
});

/** Who am I, what may I do, and does the portal need setting up. */
authRoutes.get('/api/session', async (c) => {
  const ctx = c.get('ctx');

  if (!ctx.principal) {
    return c.json({
      authenticated: false,
      needsBootstrap: ctx.leagueId === null,
      yahooMode: ctx.config.env.YAHOO_MODE,
    });
  }

  const user = await ctx.repositories.users.findById(ctx.principal.userId as InternalId);

  return c.json({
    authenticated: true,
    needsBootstrap: ctx.leagueId === null,
    yahooMode: ctx.config.env.YAHOO_MODE,
    user: user ? publicUser(user) : null,
  });
});

authRoutes.post('/api/session/signout', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireAuthenticated(ctx.principal);

  await ctx.repositories.sessions.revoke(principal.sessionId);
  await ctx.repositories.audit.record({
    leagueId: principal.leagueId as InternalId,
    action: 'user.signed_out',
    actorUserId: principal.userId as InternalId,
    actorRole: principal.role,
    summary: 'Signed out.',
    correlationId: ctx.correlationId,
  });

  for (const cookie of buildClearCookies(ctx.config.env.APP_BASE_URL.startsWith('https://'))) {
    c.header('Set-Cookie', cookie, { append: true });
  }

  return c.json({ ok: true });
});

/**
 * One-time commissioner bootstrap.
 *
 * The first authenticated user claims the league. Guarded by a conditional write
 * on the league record, so a second attempt fails even if it arrives concurrently:
 * two people cannot both become the founding commissioner.
 */
authRoutes.post('/api/setup/bootstrap', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireAuthenticated(ctx.principal);

  const body = await parseJson(
    c,
    z.object({
      leagueName: z.string().min(1).max(120),
      timezone: z.string().min(1).max(60).default('America/New_York'),
    }),
  );

  if (ctx.leagueId) {
    throw new AppError('already_bootstrapped', {
      publicMessage: 'This portal has already been set up.',
    });
  }

  const leagueId = generateId();
  const userId = principal.userId as InternalId;

  // Claimed first, and conditionally: if two people run setup simultaneously the
  // loser gets a conflict instead of silently overwriting the other's league.
  try {
    await ctx.repositories.leagues.claimPortal(leagueId);
  } catch {
    throw new AppError('already_bootstrapped', {
      publicMessage: 'This portal was just set up by someone else. Reload the page.',
    });
  }

  await ctx.repositories.leagues.save({
    entity: 'League',
    leagueId,
    name: body.leagueName,
    timezone: body.timezone,
    ...created(userId),
  });

  const user = await ctx.repositories.users.findById(userId);
  if (user) {
    await ctx.repositories.users.update(
      user,
      { role: 'commissioner', isPrimaryCommissioner: true, status: 'active' },
      userId,
    );
  }

  await ctx.repositories.audit.record({
    leagueId,
    action: 'commissioner.bootstrapped',
    actorUserId: userId,
    actorRole: 'commissioner',
    summary: `Created league "${body.leagueName}" and claimed primary commissioner.`,
    correlationId: ctx.correlationId,
    targetEntity: 'League',
    targetId: leagueId,
  });

  ctx.logger.info('portal bootstrapped', { leagueId, userId });

  return c.json({ leagueId, name: body.leagueName }, 201);
});

/** Confirms or edits the display name prefilled from Yahoo at first sign-in. */
authRoutes.put('/api/users/:userId/display-name', async (c) => {
  const ctx = c.get('ctx');
  const targetUserId = c.req.param('userId') as InternalId;
  const principal = requireSelfOrCommissioner(ctx.principal, targetUserId);

  const body = await parseJson(c, z.object({ displayName: z.string().min(1).max(80) }));

  const user = await ctx.repositories.users.findById(targetUserId);
  if (!user) throw new AppError('not_found', { publicMessage: 'No such portal user.' });

  const updatedUser = await ctx.repositories.users.update(
    user,
    { displayName: body.displayName.trim(), displayNameConfirmed: true },
    principal.userId as InternalId,
  );

  await ctx.repositories.audit.record({
    leagueId: principal.leagueId as InternalId,
    action: 'user.display_name_confirmed',
    actorUserId: principal.userId as InternalId,
    actorRole: principal.role,
    summary: `Set display name for ${targetUserId}.`,
    correlationId: ctx.correlationId,
    targetEntity: 'PortalUser',
    targetId: targetUserId,
  });

  return c.json({ user: publicUser(updatedUser) });
});

authRoutes.get('/api/users', async (c) => {
  const ctx = c.get('ctx');
  requireAuthenticated(ctx.principal);
  const leagueId = requireLeagueId(ctx);

  const users = await ctx.repositories.users.listByLeague(leagueId);
  return c.json({ users: users.map(publicUser) });
});

/** Grants or changes a portal role. Commissioner only, always audited. */
authRoutes.put('/api/users/:userId/role', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const targetUserId = c.req.param('userId') as InternalId;

  const body = await parseJson(c, z.object({ role: portalRoleSchema }));

  const user = await ctx.repositories.users.findById(targetUserId);
  if (!user) throw new AppError('not_found', { publicMessage: 'No such portal user.' });

  // Removing commissioner access from someone else is a primary-only action, so
  // two commissioners cannot revoke each other into a locked-out league.
  if (user.role === 'commissioner' && body.role !== 'commissioner') {
    requirePrimaryCommissioner(ctx.principal);

    if (user.isPrimaryCommissioner) {
      throw new AppError('conflict', {
        publicMessage:
          'Transfer primary commissioner responsibility to someone else before removing this role.',
      });
    }

    const remaining = await ctx.repositories.users.countCommissioners(leagueId);
    if (remaining <= 1) {
      // A league with no commissioner cannot grant anyone access back.
      throw new AppError('conflict', {
        publicMessage: 'The league must keep at least one commissioner.',
      });
    }
  }

  const updatedUser = await ctx.repositories.users.update(
    user,
    { role: body.role },
    principal.userId as InternalId,
  );

  await ctx.repositories.audit.record({
    leagueId,
    action:
      body.role === 'commissioner'
        ? 'commissioner.granted'
        : user.role === 'commissioner'
          ? 'commissioner.revoked'
          : 'user.role_changed',
    actorUserId: principal.userId as InternalId,
    actorRole: principal.role,
    summary: `Changed ${user.displayName} from ${user.role} to ${body.role}.`,
    correlationId: ctx.correlationId,
    targetEntity: 'PortalUser',
    targetId: targetUserId,
    detail: { previousRole: user.role, newRole: body.role },
  });

  // Revoked access takes effect immediately rather than at session expiry.
  if (user.role === 'commissioner' && body.role !== 'commissioner') {
    const revoked = await ctx.repositories.sessions.revokeAllForUser(targetUserId);
    ctx.logger.info('sessions revoked after role downgrade', { targetUserId, revoked });
  }

  return c.json({ user: publicUser(updatedUser) });
});

/** Transfers primary commissioner responsibility. Primary only. */
authRoutes.post('/api/users/:userId/transfer-primary', async (c) => {
  const ctx = c.get('ctx');
  const principal = requirePrimaryCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const targetUserId = c.req.param('userId') as InternalId;

  const target = await ctx.repositories.users.findById(targetUserId);
  if (!target) throw new AppError('not_found', { publicMessage: 'No such portal user.' });

  if (target.status !== 'active') {
    throw new AppError('precondition_failed', {
      publicMessage: 'That user is not active, so they cannot take over as commissioner.',
    });
  }

  const current = await ctx.repositories.users.findById(principal.userId as InternalId);
  if (!current) throw new AppError('not_found');

  // Promote the target first: if the second write fails the league still has a
  // primary commissioner, which is the safe direction to fail in.
  await ctx.repositories.users.update(
    target,
    { role: 'commissioner', isPrimaryCommissioner: true },
    principal.userId as InternalId,
  );
  await ctx.repositories.users.update(
    current,
    { isPrimaryCommissioner: false },
    principal.userId as InternalId,
  );

  await ctx.repositories.audit.record({
    leagueId,
    action: 'commissioner.primary_transferred',
    actorUserId: principal.userId as InternalId,
    actorRole: 'commissioner',
    summary: `Transferred primary commissioner to ${target.displayName}.`,
    correlationId: ctx.correlationId,
    targetEntity: 'PortalUser',
    targetId: targetUserId,
  });

  return c.json({ ok: true });
});

/** Creates an invitation. Only the hash is stored; the token is returned once. */
authRoutes.post('/api/invitations', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);

  const body = await parseJson(
    c,
    z.object({ email: z.string().email(), role: portalRoleSchema.default('manager') }),
  );

  const token = generateInviteToken();
  const invitationId = generateId();

  await ctx.repositories.invitations.create({
    entity: 'Invitation',
    invitationId,
    leagueId,
    email: body.email.toLowerCase(),
    role: body.role,
    tokenHash: sha256Hex(token),
    expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, ''),
    status: 'pending',
    ...created(principal.userId as InternalId),
  });

  await ctx.repositories.audit.record({
    leagueId,
    action: 'user.invited',
    actorUserId: principal.userId as InternalId,
    actorRole: principal.role,
    summary: `Invited ${body.email} as ${body.role}.`,
    correlationId: ctx.correlationId,
    targetEntity: 'Invitation',
    targetId: invitationId,
  });

  // Returned once, for the commissioner to pass along by whatever means they
  // like. This version sends no email â€” a delivery integration is deferred, and
  // handing over a link keeps the portal honest about what it does.
  return c.json(
    {
      invitationId,
      inviteUrl: `${ctx.config.env.APP_BASE_URL}/invite?token=${encodeURIComponent(token)}`,
      note: 'Share this link yourself â€” the portal does not send email in this version.',
    },
    201,
  );
});

authRoutes.get('/api/invitations', async (c) => {
  const ctx = c.get('ctx');
  requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);

  const invitations = await ctx.repositories.invitations.list(leagueId);
  return c.json({
    // The token hash never leaves the server, even to a commissioner.
    invitations: invitations.map(({ tokenHash: _tokenHash, ...rest }) => rest),
  });
});

/** Privileged audit history. Commissioner only. */
authRoutes.get('/api/audit', async (c) => {
  const ctx = c.get('ctx');
  requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);

  const limit = Math.min(Number(c.req.query('limit') ?? 100), 200);
  const entries = await ctx.repositories.audit.list(leagueId, limit);

  return c.json({ entries });
});

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Finds or creates the portal user behind a Yahoo identity.
 *
 * The Yahoo nickname is read once here to prefill a display name and is not
 * otherwise retained; the GUID is what persists.
 */
async function establishIdentity(
  ctx: RequestContext,
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAtEpochSeconds: number;
    scope?: string;
  },
): Promise<{ userId: InternalId; isNewUser: boolean; prefillDisplayName: string | null }> {
  const { encryptToken } = await import('../lib/crypto.js');
  const { env } = ctx.config;

  // A temporary client, because identity is needed before a connection exists.
  const { YahooClient } = await import('@dinkel/yahoo-client');

  const probe = new YahooClient({
    fetchImpl: ctx.yahooFetch,
    baseUrl: ctx.config.yahooApiBaseUrl,
    getAccessToken: async () => tokens.accessToken,
  });

  const profile = await probe.getUserProfile();
  if (!profile.guid) {
    throw new AppError('oauth_exchange_failed', {
      publicMessage: 'Yahoo did not identify your account. Try connecting again.',
      detail: { reason: 'missing_guid' },
    });
  }

  const existing = await ctx.repositories.users.findByYahooGuid(profile.guid as YahooGuid);
  const userId = existing?.userId ?? generateId();
  const isNewUser = existing === null;

  if (isNewUser) {
    await ctx.repositories.users.create({
      entity: 'PortalUser',
      userId,
      yahooGuid: profile.guid as YahooGuid,
      // Prefilled from Yahoo, unconfirmed until the user accepts or edits it.
      displayName: profile.nickname ?? 'New manager',
      displayNameConfirmed: false,
      // A brand-new user gets the least privilege. The bootstrap endpoint is the
      // only way to become commissioner, and only while no league exists.
      role: 'readonly',
      isPrimaryCommissioner: false,
      status: 'active',
      ...(profile.email ? { email: profile.email } : {}),
    });
  }

  const existingConnection = await ctx.repositories.connections.find(userId);

  await ctx.repositories.connections.saveTokens({
    entity: 'YahooConnection',
    connectionId: existingConnection?.connectionId ?? generateId(),
    userId,
    yahooGuid: profile.guid as YahooGuid,
    encryptedAccessToken: encryptToken(tokens.accessToken, env.TOKEN_ENCRYPTION_KEY),
    encryptedRefreshToken: encryptToken(tokens.refreshToken, env.TOKEN_ENCRYPTION_KEY),
    accessTokenExpiresAt: new Date(tokens.expiresAtEpochSeconds * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, ''),
    refreshTokenRotations: existingConnection?.refreshTokenRotations ?? 0,
    status: 'active',
    lastSuccessAt: now(),
    ...(tokens.scope ? { grantedScope: tokens.scope } : {}),
    ...(existingConnection
      ? {
          createdAt: existingConnection.createdAt,
          createdBy: existingConnection.createdBy,
          updatedAt: now(),
          updatedBy: userId,
          version: existingConnection.version + 1,
        }
      : created(userId)),
  });

  if (ctx.leagueId) {
    await ctx.repositories.audit.record({
      leagueId: ctx.leagueId,
      action: 'yahoo.connection_created',
      actorUserId: userId,
      actorRole: existing?.role ?? 'readonly',
      summary: 'Connected a Yahoo account.',
      correlationId: ctx.correlationId,
      targetEntity: 'YahooConnection',
      targetId: userId,
    });
  }

  return { userId, isNewUser, prefillDisplayName: profile.nickname ?? null };
}

/** The user shape sent to the browser. Never includes the Yahoo GUID. */
export function publicUser(user: PortalUser): {
  userId: string;
  displayName: string;
  displayNameConfirmed: boolean;
  role: string;
  isPrimaryCommissioner: boolean;
  status: string;
  email?: string;
} {
  return {
    userId: user.userId,
    displayName: user.displayName,
    displayNameConfirmed: user.displayNameConfirmed,
    role: user.role,
    isPrimaryCommissioner: user.isPrimaryCommissioner,
    status: user.status,
    ...(user.email ? { email: user.email } : {}),
  };
}

/**
 * Restricts a post-OAuth destination to an internal path.
 *
 * Rejecting anything with a scheme or protocol-relative prefix: an attacker who
 * can set `returnTo` to an external URL turns the OAuth flow into an open
 * redirect on a domain users are about to trust with credentials.
 */
export function sanitizeReturnTo(candidate: string | undefined | null): string {
  if (!candidate) return '/';
  if (!candidate.startsWith('/')) return '/';
  if (candidate.startsWith('//')) return '/';
  if (candidate.includes('\\')) return '/';
  return candidate;
}

function frontendUrl(appBaseUrl: string, returnTo: string, errorCode: string): string {
  const url = new URL(returnTo, appBaseUrl);
  url.searchParams.set('yahooError', errorCode);
  return url.toString();
}

/**
 * Parses and validates a JSON body.
 *
 * @throws {AppError} `validation_failed` with field-level detail.
 */
export async function parseJson<T extends z.ZodTypeAny>(
  c: { req: { json: () => Promise<unknown> } },
  schema: T,
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError('validation_failed', { publicMessage: 'Expected a JSON body.' });
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const { ValidationError } = await import('@dinkel/shared');
    throw new ValidationError(
      result.error.issues.map((issue) => ({
        field: issue.path.join('.') || '(body)',
        message: issue.message,
      })),
    );
  }

  return result.data;
}
