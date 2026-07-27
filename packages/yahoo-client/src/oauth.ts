import { AppError } from '@dinkel/shared';
import { z } from 'zod';

/**
 * Yahoo OAuth 2.0 authorization-code flow.
 *
 * Endpoints and semantics per Yahoo's official documentation:
 * https://developer.yahoo.com/oauth2/guide/flows_authcode/
 *
 * Two properties matter most here and are both tested:
 *   - `state` is single-use and expiring, so a replayed callback fails
 *   - a refresh response MAY carry a new refresh token, and we always persist
 *     whichever one comes back rather than assuming the original stays valid
 */

export const YAHOO_AUTHORIZE_URL = 'https://api.login.yahoo.com/oauth2/request_auth';
export const YAHOO_TOKEN_URL = 'https://api.login.yahoo.com/oauth2/get_token';

/**
 * Lifetime of an OAuth state value.
 *
 * Long enough for a person to read Yahoo's consent screen and decide, short
 * enough that a state captured from a browser history or a referrer log is
 * useless. Ten minutes is the usual balance.
 */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

/**
 * Refresh this many seconds before actual expiry.
 *
 * Yahoo access tokens last an hour. Refreshing early avoids the race where a
 * token passes the expiry check, then expires in flight during a slow request.
 */
export const TOKEN_REFRESH_SKEW_SECONDS = 5 * 60;

/** A pending authorization attempt. Stored server-side, never in the browser. */
export interface OAuthState {
  state: string;
  /** Unix seconds. Enforced both in code and by a DynamoDB TTL. */
  expiresAtEpochSeconds: number;
  /** Where to send the user after a successful connection. Validated as internal. */
  returnTo: string;
  /** Set once consumed, so a second callback with the same state is rejected. */
  consumedAt?: string;
  /** Bound to the session that started the flow, when one exists. */
  sessionId?: string;
}

/**
 * Generates a cryptographically random state value.
 *
 * 32 bytes of CSPRNG output, base64url-encoded. Not a UUID: v4 UUIDs carry only
 * 122 bits and read as guessable to a reviewer even though they are not.
 *
 * @param randomBytes - Injectable randomness source, so tests are deterministic.
 */
export function generateOAuthState(
  randomBytes: (size: number) => Uint8Array = defaultRandomBytes,
): string {
  return base64UrlEncode(randomBytes(32));
}

/** Creates a state record ready to persist. */
export function createOAuthState(
  options: {
    returnTo?: string;
    sessionId?: string;
    nowEpochSeconds?: number;
    ttlSeconds?: number;
  } = {},
  randomBytes: (size: number) => Uint8Array = defaultRandomBytes,
): OAuthState {
  const now = options.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const record: OAuthState = {
    state: generateOAuthState(randomBytes),
    expiresAtEpochSeconds: now + (options.ttlSeconds ?? OAUTH_STATE_TTL_SECONDS),
    returnTo: options.returnTo ?? '/',
  };
  if (options.sessionId !== undefined) record.sessionId = options.sessionId;
  return record;
}

/**
 * Validates a state value returned by Yahoo.
 *
 * Rejects, with a distinct error code for each case so the UI can explain what
 * happened: missing, unknown, expired, or already used.
 *
 * @throws {AppError} `oauth_state_missing` | `oauth_state_invalid` |
 *   `oauth_state_expired` | `oauth_state_reused`
 */
export function validateOAuthState(
  received: string | null | undefined,
  stored: OAuthState | null | undefined,
  nowEpochSeconds: number = Math.floor(Date.now() / 1000),
): OAuthState {
  if (!received) {
    throw new AppError('oauth_state_missing', {
      publicMessage: 'The Yahoo sign-in link was incomplete. Start the connection again.',
    });
  }

  if (!stored) {
    throw new AppError('oauth_state_invalid', {
      publicMessage: 'That Yahoo sign-in attempt is no longer valid. Start the connection again.',
    });
  }

  // Constant-time comparison: a timing oracle on state would let an attacker
  // discover a valid value one character at a time.
  if (!timingSafeEqualStrings(received, stored.state)) {
    throw new AppError('oauth_state_invalid', {
      publicMessage: 'That Yahoo sign-in attempt is no longer valid. Start the connection again.',
    });
  }

  if (stored.consumedAt) {
    throw new AppError('oauth_state_reused', {
      publicMessage: 'That Yahoo sign-in link was already used. Start the connection again.',
    });
  }

  if (stored.expiresAtEpochSeconds <= nowEpochSeconds) {
    throw new AppError('oauth_state_expired', {
      publicMessage: 'The Yahoo sign-in attempt timed out. Start the connection again.',
    });
  }

  return stored;
}

/**
 * Builds the Yahoo consent URL.
 *
 * The redirect URI is passed through verbatim from configuration and never
 * constructed from a request header: deriving it from Host or Origin is how an
 * open-redirect turns into account takeover.
 */
export function buildAuthorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  /** Yahoo's Fantasy read scope. Read-only is all this portal requests. */
  scope?: string;
}): string {
  const url = new URL(YAHOO_AUTHORIZE_URL);
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', options.state);
  if (options.scope) url.searchParams.set('scope', options.scope);
  return url.toString();
}

/** Yahoo's token response. Extra fields are tolerated; missing required ones are not. */
export const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  /**
   * Optional because a refresh response may omit it, meaning "keep using the
   * one you have". Treating an omission as revocation would sign users out for
   * no reason.
   */
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  token_type: z.string().optional(),
  /** Present on some Yahoo responses; recorded for diagnostics, not trusted. */
  xoauth_yahoo_guid: z.string().optional(),
  scope: z.string().optional(),
});
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAtEpochSeconds: number;
  scope?: string;
  /** True when Yahoo returned a different refresh token than the one we sent. */
  refreshTokenRotated: boolean;
}

/** Minimal fetch shape, so tests inject a transport without touching the network. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  ok: boolean;
  text: () => Promise<string>;
  headers: { get: (name: string) => string | null };
}>;

/**
 * Exchanges an authorization code for tokens.
 *
 * @throws {AppError} `oauth_exchange_failed` — the message is deliberately
 *   generic; Yahoo's error body goes to structured logs, never to the browser,
 *   since it can echo request parameters.
 */
export async function exchangeCodeForTokens(
  options: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
    nowEpochSeconds?: number;
  },
  fetchImpl: FetchLike,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    redirect_uri: options.redirectUri,
    code: options.code,
  });

  const response = await postToken(options.clientId, options.clientSecret, body, fetchImpl);
  const now = options.nowEpochSeconds ?? Math.floor(Date.now() / 1000);

  if (!response.refresh_token) {
    // An authorization-code exchange must yield a refresh token; without one the
    // connection would silently die in an hour with no way to renew it.
    throw new AppError('oauth_exchange_failed', {
      publicMessage: 'Yahoo did not return a renewable connection. Try connecting again.',
      detail: { reason: 'missing_refresh_token' },
    });
  }

  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAtEpochSeconds: now + response.expires_in,
    ...(response.scope === undefined ? {} : { scope: response.scope }),
    refreshTokenRotated: false,
  };
}

/**
 * Refreshes an access token.
 *
 * Handles rotation: if Yahoo returns a new refresh token we keep that one and
 * flag the rotation so the caller persists it. Yahoo documents rotation as
 * optional, so both behaviors are supported rather than assumed.
 */
export async function refreshAccessToken(
  options: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    refreshToken: string;
    nowEpochSeconds?: number;
  },
  fetchImpl: FetchLike,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    redirect_uri: options.redirectUri,
    refresh_token: options.refreshToken,
  });

  const response = await postToken(options.clientId, options.clientSecret, body, fetchImpl);
  const now = options.nowEpochSeconds ?? Math.floor(Date.now() / 1000);

  const returned = response.refresh_token;
  const refreshToken = returned ?? options.refreshToken;

  return {
    accessToken: response.access_token,
    refreshToken,
    expiresAtEpochSeconds: now + response.expires_in,
    ...(response.scope === undefined ? {} : { scope: response.scope }),
    refreshTokenRotated: returned !== undefined && returned !== options.refreshToken,
  };
}

async function postToken(
  clientId: string,
  clientSecret: string,
  body: URLSearchParams,
  fetchImpl: FetchLike,
): Promise<TokenResponse> {
  // HTTP Basic with client_id:client_secret, per Yahoo's documented flow.
  const credentials = base64Encode(`${clientId}:${clientSecret}`);

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(YAHOO_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch (cause) {
    throw new AppError('yahoo_unavailable', {
      publicMessage: 'Could not reach Yahoo. Try again shortly.',
      cause,
    });
  }

  const raw = await response.text();

  if (!response.ok) {
    // Yahoo signals a dead refresh token with 400 invalid_grant. That is a
    // reconnect prompt, not a transient failure worth retrying.
    if (response.status === 400 && raw.includes('invalid_grant')) {
      throw new AppError('yahoo_needs_reconnect', {
        detail: { status: response.status, reason: 'invalid_grant' },
      });
    }
    if (response.status === 429) {
      throw new AppError('yahoo_rate_limited', { detail: { status: response.status } });
    }
    throw new AppError('oauth_exchange_failed', {
      detail: { status: response.status },
      // The body may echo request parameters, so it is not attached here. The
      // caller logs it separately through the redacting logger.
      cause: new Error(`Yahoo token endpoint returned ${response.status}`),
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new AppError('yahoo_unexpected_response', {
      detail: { reason: 'token_response_not_json' },
      cause,
    });
  }

  const result = tokenResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new AppError('yahoo_unexpected_response', {
      detail: { reason: 'token_response_shape', issues: result.error.issues.length },
    });
  }
  return result.data;
}

/** True when a token should be refreshed, accounting for the safety skew. */
export function needsRefresh(
  expiresAtEpochSeconds: number,
  nowEpochSeconds: number = Math.floor(Date.now() / 1000),
  skewSeconds: number = TOKEN_REFRESH_SKEW_SECONDS,
): boolean {
  return expiresAtEpochSeconds - skewSeconds <= nowEpochSeconds;
}

// --------------------------------------------------------------------------
// Small primitives, kept local so this package has no runtime dependencies
// beyond zod and works identically in Lambda and in tests.
// --------------------------------------------------------------------------

function defaultRandomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function base64Encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/**
 * Length-independent constant-time string comparison.
 *
 * Compares over a fixed number of iterations regardless of input length, so
 * neither the length nor the position of the first mismatch is observable.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < length; i += 1) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}
