/**
 * API client.
 *
 * Same-origin `fetch` with `credentials: 'include'`, so the HttpOnly session
 * cookie travels without any script ever reading it. State-changing requests echo
 * the readable CSRF cookie in a header — the double-submit pattern.
 *
 * There is no token handling here at all, deliberately: the Yahoo refresh token
 * never leaves the backend, so the browser has nothing to store, refresh, or leak.
 */

const CSRF_COOKIE = 'dinkel_csrf';
const CSRF_HEADER = 'x-dinkel-csrf';

export interface ApiErrorBody {
  error: { code: string; message: string };
  fieldErrors?: Array<{ field: string; message: string }>;
}

/**
 * A failed request, carrying the backend's stable error code.
 *
 * The code is what the UI branches on — `yahoo_needs_reconnect` shows a reconnect
 * prompt, `commissioner_required` explains the permission — rather than matching
 * on message text, which would break the moment wording changed.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: Array<{ field: string; message: string }> = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when reconnecting Yahoo is the fix. */
  get needsYahooReconnect(): boolean {
    return this.code === 'yahoo_needs_reconnect' || this.code === 'yahoo_not_connected';
  }

  get isUnauthenticated(): boolean {
    return this.code === 'unauthenticated' || this.code === 'session_expired';
  }

  get isPermission(): boolean {
    return this.code === 'forbidden' || this.code === 'commissioner_required';
  }

  /** True when retrying later is reasonable. */
  get isTransient(): boolean {
    return (
      this.code === 'yahoo_rate_limited' ||
      this.code === 'yahoo_unavailable' ||
      this.code === 'rate_limited' ||
      this.status >= 500
    );
  }
}

function readCsrfToken(): string | null {
  for (const part of document.cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === CSRF_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};

  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  if (!['GET', 'HEAD'].includes(method)) {
    const csrf = readCsrfToken();
    if (csrf) headers[CSRF_HEADER] = csrf;
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      // Same-origin cookies. No Authorization header, because there is no token
      // in the browser to put in one.
      credentials: 'include',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    // A network failure is distinct from a server error and worth saying so:
    // "check your connection" is actionable, "something went wrong" is not.
    throw new ApiError(
      0,
      'network_error',
      'Could not reach the portal. Check your connection.',
      [],
    );
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const body = parsed as ApiErrorBody | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'internal_error',
      body?.error?.message ?? 'Request failed.',
      body?.fieldErrors ?? [],
    );
  }

  return parsed as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>(path),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'POST', ...(body === undefined ? {} : { body }) }),
  put: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'PUT', ...(body === undefined ? {} : { body }) }),
  delete: <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' }),
};

// --------------------------------------------------------------------------
// Response shapes
// --------------------------------------------------------------------------

export interface SessionResponse {
  authenticated: boolean;
  needsBootstrap: boolean;
  yahooMode: 'mock' | 'live';
  user?: {
    userId: string;
    displayName: string;
    displayNameConfirmed: boolean;
    role: 'commissioner' | 'manager' | 'readonly';
    isPrimaryCommissioner: boolean;
    status: string;
    email?: string;
  } | null;
}

export interface ConnectionResponse {
  connected: boolean;
  status?: 'active' | 'needs_reconnect' | 'revoked';
  yahooMode: 'mock' | 'live';
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  lastFailureReason?: string | null;
  lastRefreshedAt?: string | null;
  refreshTokenRotations?: number;
  grantedScope?: string | null;
  connectedAt?: string;
  capabilityMatrixReviewedAt: string;
}

export interface LeagueOption {
  yahooLeagueKey: string;
  yahooGameKey: string;
  name: string;
  season: number | null;
  teamCount: number | null;
  scoringType: string | null;
  isYahooCommissioner: boolean | null;
  isFinished: boolean | null;
}

export interface LeagueOverview {
  league: { leagueId: string; name: string; currentSeasonYear: number | null };
  linked: boolean;
  yahoo: {
    seasonYear: number;
    yahooLeagueKey: string;
    name: string;
    season: number | null;
    currentWeek: number | null;
    startWeek: number | null;
    endWeek: number | null;
    playoffStartWeek: number | null;
    scoringType: string | null;
    teamCount: number | null;
    draftStatus: string | null;
    teams: Array<{
      yahooTeamKey: string;
      name: string;
      logoUrl: string | null;
      managers: Array<{ nickname: string; isYahooCommissioner: boolean; isYou: boolean }>;
      leagueMemberId: string | null;
    }>;
  } | null;
  fetchedAt?: string;
}

export interface CapabilitiesResponse {
  lastReviewedAt: string;
  access: {
    selfService: boolean;
    approvalRequired: boolean;
    defaultPermission: string;
    applicationUrl: string;
  };
  writeOperationsSupported: boolean;
  commissionerActionsSupported: boolean;
  retention: { maxRetentionHours: number; storableIndefinitely: string[] };
  verifiedCapabilities: string[];
  resources: Array<{
    key: string;
    feature: string;
    resource: string;
    method: string;
    confidence: string;
    testStatus: string;
    limitations: string[];
  }>;
}

export interface ChallengeDefinitionSummary {
  challengeDefinitionId: string;
  slug: string;
  name: string;
  description: string;
  status: 'draft' | 'active' | 'blocked' | 'retired';
  blockedReason?: string;
  requiredYahooData: string[];
  benchCounts: boolean;
  decimalsCount: boolean;
  negativesCount: boolean;
  tieBreakers: string[];
  overridePolicy: string;
}

export interface AuditEntry {
  auditLogId: string;
  action: string;
  at: string;
  actorUserId: string | null;
  actorRole: string;
  summary: string;
  targetEntity?: string;
  targetId?: string;
}
