import { AppError } from '@dinkel/shared';
import { safeCompare } from './crypto.js';

/**
 * Session cookies and CSRF protection.
 *
 * The session cookie is `HttpOnly` so no script can read it, `Secure` so it never
 * crosses plaintext, and `SameSite=Lax` so a cross-site form post cannot carry it
 * while an ordinary top-level navigation back from Yahoo still can — which the
 * OAuth callback depends on.
 *
 * Because `Lax` still permits cross-site GETs, state-changing requests carry a
 * double-submit CSRF token: a readable cookie whose value must be echoed in a
 * header. An attacker's page can cause a request but cannot read our cookie to
 * populate the header.
 */

export const SESSION_COOKIE = 'dinkel_session';
export const CSRF_COOKIE = 'dinkel_csrf';
export const CSRF_HEADER = 'x-dinkel-csrf';

/** Session lifetime. Long enough to be convenient for a league that logs in weekly. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface CookieOptions {
  /** False only for local HTTP development; true everywhere real. */
  secure: boolean;
  maxAgeSeconds: number;
}

export function buildSessionCookie(sessionId: string, options: CookieOptions): string {
  return serializeCookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: options.secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: options.maxAgeSeconds,
  });
}

/**
 * The CSRF cookie is deliberately readable by script — the frontend must echo it
 * in a header. It is not a secret in the way the session is: knowing it is
 * useless without also being able to set it, which same-origin policy prevents.
 */
export function buildCsrfCookie(token: string, options: CookieOptions): string {
  return serializeCookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: options.secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: options.maxAgeSeconds,
  });
}

/** Expiring cookies for sign-out. Same attributes, zero lifetime. */
export function buildClearCookies(secure: boolean): string[] {
  return [
    serializeCookie(SESSION_COOKIE, '', {
      httpOnly: true,
      secure,
      sameSite: 'Lax',
      path: '/',
      maxAge: 0,
    }),
    serializeCookie(CSRF_COOKIE, '', {
      httpOnly: false,
      secure,
      sameSite: 'Lax',
      path: '/',
      maxAge: 0,
    }),
  ];
}

export function parseCookies(header: string | undefined | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;

    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name.length === 0) continue;

    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      // A malformed cookie is ignored rather than failing the request: a stale
      // cookie from another app on localhost should not lock a user out.
      cookies[name] = value;
    }
  }

  return cookies;
}

/**
 * Verifies the double-submit CSRF token.
 *
 * @throws {AppError} `forbidden`
 */
export function assertCsrf(
  cookieHeader: string | null | undefined,
  headerToken: string | null,
): void {
  const cookieToken = parseCookies(cookieHeader)[CSRF_COOKIE];

  if (!cookieToken || !headerToken) {
    throw new AppError('forbidden', {
      publicMessage: 'That request was missing its security token. Reload the page and try again.',
      detail: { reason: 'csrf_token_missing' },
    });
  }

  if (!safeCompare(cookieToken, headerToken)) {
    throw new AppError('forbidden', {
      publicMessage: 'That request failed a security check. Reload the page and try again.',
      detail: { reason: 'csrf_token_mismatch' },
    });
  }
}

interface SerializeOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Lax' | 'Strict' | 'None';
  path: string;
  maxAge: number;
}

function serializeCookie(name: string, value: string, options: SerializeOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    `SameSite=${options.sameSite}`,
  ];

  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');

  return parts.join('; ');
}
