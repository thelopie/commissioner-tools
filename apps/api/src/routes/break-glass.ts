import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import {
  AppError,
  generateId,
  isYahooConfigured,
  type InternalId,
  type PortalUser,
} from '@lopie/shared';
import { z } from 'zod';
import type { AppEnv } from '../context.js';
import { buildCsrfCookie, buildSessionCookie } from '../lib/cookies.js';
import { generateCsrfToken, generateSessionId } from '../lib/crypto.js';
import { created } from '../repositories.js';
import { parseJson } from './auth.js';

/**
 * A temporary way in, for the window before Yahoo credentials arrive.
 *
 * The portal's identity model is Yahoo's: sign-in is OAuth and a user is keyed on a
 * Yahoo GUID. That is the right design and this does not change it. But it leaves a
 * gap — a brand-new deployment waiting on Yahoo's approval cannot be set up at all,
 * because the commissioner cannot get in to enter the LLWS field or run the draw.
 *
 * THIS IS A SECOND AUTHENTICATION PATH AND IT IS MEANT TO BE DELETED.
 *
 * Four things keep it narrow while it exists:
 *
 * 1. **Off by default.** Without `BREAK_GLASS_TOKEN` the route does not authenticate
 *    anything. An operator has to deliberately set a secret to enable it.
 * 2. **Impossible once Yahoo works.** If Yahoo is configured the route refuses, so it
 *    cannot linger as a bypass of the real sign-in. Deleting the file is the tidy-up;
 *    this is the guarantee in the meantime.
 * 3. **One account.** It signs in a single commissioner. It cannot create a second
 *    user, and it cannot elevate anybody.
 * 4. **Audited and slow to guess.** Every attempt, successful or not, is written to
 *    the audit log, and the comparison is constant-time.
 *
 * The session it issues is deliberately short. This is for an afternoon of setup, not
 * a way to run the league.
 */

export const breakGlassRoutes = new Hono<AppEnv>();

/** Two hours: long enough to set up a season, short enough not to become normal. */
const BREAK_GLASS_SESSION_SECONDS = 2 * 60 * 60;

/** The fixed identity this route signs in. Never a Yahoo GUID. */
const BREAK_GLASS_GUID = 'break-glass-commissioner';

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Length is compared first because timingSafeEqual throws on a mismatch; the
  // length of a secret is not itself the secret.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

breakGlassRoutes.post('/auth/break-glass', async (c) => {
  const ctx = c.get('ctx');
  const env = ctx.config.env;

  const expected = env.BREAK_GLASS_TOKEN;

  /**
   * Absent token or working Yahoo: the route does not exist as far as a caller is
   * concerned. `not_found` rather than a specific refusal, so probing cannot
   * distinguish "disabled here" from "no such endpoint".
   */
  if (!expected || isYahooConfigured(env)) {
    throw new AppError('not_found', { publicMessage: 'Not found.' });
  }

  const body = await parseJson(c, z.object({ token: z.string().min(1).max(200) }));

  if (!tokensMatch(body.token, expected)) {
    /*
      Logged before the refusal, and at warn: a failed attempt on this route is one of
      the few genuinely interesting security events this application can produce.
    */
    ctx.logger.warn('Break-glass sign-in refused', { reason: 'token mismatch' });

    await ctx.repositories.audit
      .record({
        leagueId: ctx.leagueId ?? ('00000000000000000000000000' as InternalId),
        action: 'user.signed_in',
        actorUserId: null,
        actorRole: 'system',
        summary: 'Break-glass sign-in REFUSED: token mismatch.',
        correlationId: ctx.correlationId,
      })
      .catch(() => {
        // Never let audit trouble turn a refusal into a 500 that reads as a hint.
      });

    throw new AppError('unauthenticated', { publicMessage: 'That token is not valid.' });
  }

  /**
   * One fixed user, found or created.
   *
   * Keyed on a sentinel rather than a Yahoo GUID, so when the real commissioner signs
   * in through Yahoo later they get their own account and this one is visibly
   * separate — a break-glass session should never be mistaken for the real person.
   */
  let user = await ctx.repositories.users.findByYahooGuid(BREAK_GLASS_GUID as never);

  if (!user) {
    const userId = generateId();
    const record: PortalUser = {
      entity: 'PortalUser',
      userId,
      yahooGuid: BREAK_GLASS_GUID as never,
      displayName: 'Commissioner (setup)',
      displayNameConfirmed: true,
      role: 'commissioner',
      isPrimaryCommissioner: true,
      status: 'active',
      ...created(userId),
    };

    await ctx.repositories.users.create(record);
    user = record;
  }

  const sessionId = generateSessionId();
  const csrfToken = generateCsrfToken();

  await ctx.repositories.sessions.create({
    sessionId,
    userId: user.userId,
    csrfToken,
    expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + BREAK_GLASS_SESSION_SECONDS,
  });

  const secure = env.APP_BASE_URL.startsWith('https://');
  c.header(
    'Set-Cookie',
    buildSessionCookie(sessionId, { secure, maxAgeSeconds: BREAK_GLASS_SESSION_SECONDS }),
    { append: true },
  );
  c.header(
    'Set-Cookie',
    buildCsrfCookie(csrfToken, { secure, maxAgeSeconds: BREAK_GLASS_SESSION_SECONDS }),
    { append: true },
  );

  ctx.logger.warn('Break-glass sign-in used', { userId: user.userId });

  await ctx.repositories.audit
    .record({
      leagueId: ctx.leagueId ?? ('00000000000000000000000000' as InternalId),
      action: 'user.signed_in',
      actorUserId: user.userId,
      actorRole: 'commissioner',
      summary: 'Break-glass sign-in used, before Yahoo credentials were configured.',
      correlationId: ctx.correlationId,
    })
    .catch(() => {});

  return c.json({ ok: true, expiresInSeconds: BREAK_GLASS_SESSION_SECONDS });
});
