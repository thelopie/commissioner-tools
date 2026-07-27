/**
 * Application error taxonomy.
 *
 * Every error carries a stable `code` the frontend can branch on and a `status`
 * for the HTTP layer. `publicMessage` is what a user may see; `cause` and
 * internal detail stay in structured logs. This split is what keeps a stack
 * trace or a Yahoo error body from reaching a browser.
 */

export type AppErrorCode =
  // Authentication and authorization
  | 'unauthenticated'
  | 'session_expired'
  | 'forbidden'
  | 'commissioner_required'
  | 'already_bootstrapped'
  | 'invitation_invalid'

  // OAuth
  | 'oauth_state_missing'
  | 'oauth_state_invalid'
  | 'oauth_state_expired'
  | 'oauth_state_reused'
  | 'oauth_denied'
  | 'oauth_exchange_failed'
  | 'oauth_redirect_mismatch'

  // Yahoo
  | 'yahoo_not_connected'
  | 'yahoo_needs_reconnect'
  | 'yahoo_rate_limited'
  | 'yahoo_unavailable'
  | 'yahoo_unexpected_response'
  | 'yahoo_capability_unverified'
  | 'yahoo_league_not_linked'

  // Validation and state
  | 'validation_failed'
  | 'not_found'
  | 'conflict'
  | 'version_conflict'
  | 'duplicate'
  | 'precondition_failed'

  // Domain rules
  | 'challenge_blocked'
  | 'challenge_already_finalized'
  | 'settled_payout_protected'
  | 'override_reason_required'
  | 'llws_team_already_assigned'
  | 'draft_position_taken'
  | 'draft_turn_not_open'
  | 'import_rollback_blocked'
  | 'import_conflicts_unresolved'

  // Infrastructure
  | 'rate_limited'
  | 'internal_error';

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  unauthenticated: 401,
  session_expired: 401,
  forbidden: 403,
  commissioner_required: 403,
  already_bootstrapped: 409,
  invitation_invalid: 400,

  oauth_state_missing: 400,
  oauth_state_invalid: 400,
  oauth_state_expired: 400,
  oauth_state_reused: 400,
  oauth_denied: 400,
  oauth_exchange_failed: 502,
  oauth_redirect_mismatch: 400,

  yahoo_not_connected: 409,
  yahoo_needs_reconnect: 409,
  yahoo_rate_limited: 429,
  yahoo_unavailable: 503,
  yahoo_unexpected_response: 502,
  yahoo_capability_unverified: 409,
  yahoo_league_not_linked: 409,

  validation_failed: 400,
  not_found: 404,
  conflict: 409,
  version_conflict: 409,
  duplicate: 409,
  precondition_failed: 412,

  challenge_blocked: 409,
  challenge_already_finalized: 409,
  settled_payout_protected: 409,
  override_reason_required: 400,
  llws_team_already_assigned: 409,
  draft_position_taken: 409,
  draft_turn_not_open: 409,
  import_rollback_blocked: 409,
  import_conflicts_unresolved: 409,

  rate_limited: 429,
  internal_error: 500,
};

export interface AppErrorOptions {
  /** Message safe to show a user. Defaults to a generic per-code message. */
  publicMessage?: string;
  /** Structured detail for logs. Must not contain secrets or raw Yahoo bodies. */
  detail?: Record<string, string | number | boolean | null>;
  cause?: unknown;
  /** Overrides the default status for the code, e.g. a Yahoo 503 vs 502. */
  status?: number;
}

const DEFAULT_MESSAGES: Partial<Record<AppErrorCode, string>> = {
  unauthenticated: 'Sign in to continue.',
  session_expired: 'Your session expired. Sign in again.',
  forbidden: 'You do not have access to this.',
  commissioner_required: 'This action requires commissioner access.',
  yahoo_not_connected: 'Connect your Yahoo account to load league data.',
  yahoo_needs_reconnect:
    'Your Yahoo connection needs to be renewed. Reconnect to continue loading league data.',
  yahoo_rate_limited: 'Yahoo is rate limiting requests. Try again shortly.',
  yahoo_unavailable: 'Yahoo is not responding right now. Try again shortly.',
  yahoo_unexpected_response: 'Yahoo returned something unexpected. Nothing was changed.',
  yahoo_capability_unverified:
    'This depends on Yahoo data that has not been verified against a real league yet.',
  challenge_blocked: 'This challenge is blocked because required Yahoo data is unavailable.',
  settled_payout_protected:
    'This result has already been paid. Changing it requires an explicit commissioner override.',
  internal_error: 'Something went wrong. Nothing was changed.',
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly publicMessage: string;
  readonly detail: Record<string, string | number | boolean | null>;

  constructor(code: AppErrorCode, options: AppErrorOptions = {}) {
    const publicMessage = options.publicMessage ?? DEFAULT_MESSAGES[code] ?? 'Request failed.';
    super(publicMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? STATUS_BY_CODE[code];
    this.publicMessage = publicMessage;
    this.detail = options.detail ?? {};
  }

  /** The response body. Deliberately excludes stack traces and internal detail. */
  toResponseBody(): { error: { code: AppErrorCode; message: string } } {
    return { error: { code: this.code, message: this.publicMessage } };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Field-level validation failures, shaped for form display. */
export class ValidationError extends AppError {
  constructor(
    public readonly fieldErrors: ReadonlyArray<{ field: string; message: string }>,
    publicMessage = 'Some fields need attention.',
  ) {
    super('validation_failed', { publicMessage });
    this.name = 'ValidationError';
  }

  override toResponseBody(): {
    error: { code: AppErrorCode; message: string };
    fieldErrors: ReadonlyArray<{ field: string; message: string }>;
  } {
    return { ...super.toResponseBody(), fieldErrors: this.fieldErrors };
  }
}
