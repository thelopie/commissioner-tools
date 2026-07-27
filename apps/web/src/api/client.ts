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
    numPlayoffTeams: number | null;
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

export interface StandingsRow {
  rank: number | null;
  yahooTeamKey: string;
  name: string;
  record: string | null;
  wins: number | null;
  losses: number | null;
  ties: number | null;
  pointsFor: number | null;
  pointsAgainst: number | null;
  streak: string | null;
  managers: string[];
  isYou: boolean;
}

export interface StandingsResponse {
  seasonYear: number;
  standings: StandingsRow[];
  fetchedAt: string;
}

export interface MatchupTeam {
  yahooTeamKey: string;
  name: string;
  points: number | null;
  managers: string[];
  isYou: boolean;
  isWinner: boolean;
}

export interface MatchupsResponse {
  week: number;
  seasonYear: number;
  matchups: Array<{
    teams: MatchupTeam[];
    isTied: boolean;
    status: string | null;
    margin: number | null;
    involvesYou: boolean;
  }>;
  fetchedAt: string;
}

/** One player movement inside a transaction. */
export interface TransactionPlayer {
  name: string;
  position: string | null;
  nflTeam: string | null;
  movement: string | null;
  source: string | null;
  destination: string | null;
  sourceTeamName: string | null;
  destinationTeamName: string | null;
}

export interface TransactionsResponse {
  seasonYear: number;
  transactions: Array<{
    transactionKey: string;
    type: string;
    status: string | null;
    occurredAt: string | null;
    involvesYou: boolean;
    players: TransactionPlayer[];
  }>;
  fetchedAt: string;
}

export interface RosterSlot {
  playerName: string;
  selectedPosition: string;
  isStarter: boolean;
  displayPosition: string | null;
  nflTeam: string | null;
  injuryStatus: string | null;
  points: number | null;
}

export interface RosterResponse {
  week: number;
  seasonYear: number;
  /** Null when Yahoo marks no team as the signed-in user's. */
  team: {
    yahooTeamKey: string;
    name: string;
    managers: string[];
    isYou: boolean;
  } | null;
  slots: RosterSlot[];
  startersPoints?: number | null;
  benchPoints?: number | null;
  fetchedAt?: string;
}

/** The home-screen summary: one request rather than three loading states. */
export interface MeResponse {
  linked: boolean;
  seasonYear?: number;
  week?: number;
  leagueName?: string;
  teamCount?: number;
  playoffStartWeek?: number | null;
  you?: {
    yahooTeamKey: string;
    name: string;
    rank: number | null;
    record: string | null;
    pointsFor: number | null;
    pointsAgainst: number | null;
    streak: string | null;
  } | null;
  matchup?: {
    status: string | null;
    isTied: boolean;
    you: { name: string; points: number | null };
    opponent: { name: string; points: number | null; managers: string[] } | null;
    margin: number | null;
  } | null;
  leaders?: Array<{ rank: number | null; name: string; record: string | null; isYou: boolean }>;
  highestScore?: { name: string; points: number } | null;
  closestMatchup?: { margin: number; teams: string[] } | null;
  fetchedAt?: string;
}

// --------------------------------------------------------------------------
// LLWS draft order
// --------------------------------------------------------------------------

export interface LLWSTeam {
  llwsTeamId: string;
  name: string;
  region?: string;
  bracket: 'united_states' | 'international' | 'unknown';
  /** Where the team finished. Absent until the commissioner records it. */
  finishRank?: number;
  finishLabel?: string;
  eliminatedAt?: string;
}

export interface LLWSTeamsResponse {
  teams: LLWSTeam[];
}

export interface LLWSAssignmentRecord {
  assignmentId: string;
  leagueMemberId: string;
  llwsTeamId: string;
  /** Visible on purpose: anyone can re-run the draw and audit it. */
  randomizationSeed: string;
  assignedAt: string;
  publishedAt?: string;
}

export interface AssignmentsResponse {
  assignments: LLWSAssignmentRecord[];
  published: boolean;
  seed: string | null;
}

export interface DrawResponse {
  assignments: Array<{ leagueMemberId: string; llwsTeamId: string }>;
  seed: string;
  randomizationRunId: string;
  unassignedLeagueMemberIds: string[];
  unassignedLlwsTeamIds: string[];
  published: boolean;
  note: string;
}

export interface VerifyDrawResponse {
  verified: boolean;
  seed?: string;
  reason?: string;
  mismatches?: Array<{ leagueMemberId: string; recorded: string | null; expected: string | null }>;
  note?: string;
}

/** How a manager's place in the selection queue was arrived at. */
export interface SelectionDerivation {
  llwsTeamId?: string;
  llwsFinishRank?: number;
  appliedTieBreaker?: string;
  explanation: string;
}

export interface SelectionOrderResponse {
  order: Array<{
    leagueMemberId: string;
    selectionOrder: number;
    llwsFinishRank?: number;
    appliedTieBreaker?: string;
    explanation: string;
  }>;
  unplaced: Array<{ leagueMemberId: string; reason: string }>;
  seed?: string;
}

export type SelectionStatus = 'waiting' | 'open' | 'locked' | 'commissioner_assigned' | 'skipped';

export interface DraftStatusResponse {
  selections: Array<{
    leagueMemberId: string;
    displayName: string;
    selectionOrder: number;
    chosenDraftPosition: number | null;
    status: SelectionStatus;
    remindersSent: number;
    derivedFrom: SelectionDerivation;
  }>;
  availablePositions: number[];
  /** Null when nobody's turn is open — before the order is computed, or after all picks. */
  currentTurn: { leagueMemberId: string; displayName: string; isYou: boolean } | null;
  finalOrder: Array<{
    draftPosition: number;
    leagueMemberId: string | null;
    displayName: string | null;
  }>;
  complete: boolean;
  missingPositions: number[];
  /** Always false. Yahoo documents no endpoint that sets draft order. */
  yahooWriteSupported: boolean;
  note: string;
}

// --------------------------------------------------------------------------
// League members — Dinkel's own roster of people, mapped to Yahoo teams
// --------------------------------------------------------------------------

export interface LeagueMemberRecord {
  leagueMemberId: string;
  seasonYear: number;
  userId: string | null;
  /**
   * Dinkel's own name for this person: a portal user's confirmed display name, or
   * a name the commissioner typed. Never a Yahoo nickname.
   */
  displayName: string;
  yahooTeamKey: string | null;
  isActive: boolean;
}

export interface LeagueMembersResponse {
  members: LeagueMemberRecord[];
}

export interface PortalUserSummary {
  userId: string;
  displayName: string;
  role: 'commissioner' | 'manager' | 'readonly';
  status: string;
}

export interface PortalUsersResponse {
  users: PortalUserSummary[];
}

// --------------------------------------------------------------------------
// Weekly challenge results
// --------------------------------------------------------------------------

export type ChallengeResultStatus =
  'provisional' | 'finalized' | 'overridden' | 'not_calculable' | 'conflict';

export interface ChallengeResult {
  challengeResultId: string;
  challengeSlug: string;
  week: number;
  status: ChallengeResultStatus;
  /** Resolved server-side; the stored record holds member IDs, not names. */
  winners: Array<{ leagueMemberId: string; displayName: string }>;
  winningLeagueMemberIds: string[];
  winningValue?: number;
  /** The engine's sentence of arithmetic. This is what makes a result defensible. */
  explanation: string;
  competitorCount: number;
  wasTied: boolean;
  appliedTieBreaker?: string;
  calculatedAt: string;
  /** Bumped by a recalculation, e.g. after a Yahoo stat correction. */
  calculationCount: number;
  lastChangedAt?: string;
  finalizedAt?: string;
  notCalculableReason?: string;
  /** A settled payout is never silently rewritten. */
  payoutSettled: boolean;
}

export interface ChallengeResultsResponse {
  results: ChallengeResult[];
  members: Array<{ leagueMemberId: string; displayName: string }>;
}

export interface CalculateResponse {
  calculated: Array<{
    slug: string;
    status: string;
    winners: string[];
    value?: number;
  }>;
  /** Recalculations the engine refused to apply on its own. */
  conflicts?: Array<{ slug: string; reason: string }>;
  blocked: Array<{ slug: string; reason: string }>;
  note: string;
}

// --------------------------------------------------------------------------
// Money records — bookkeeping only. The portal never moves money.
// --------------------------------------------------------------------------

export type PaymentStatus = 'unpaid' | 'partial' | 'paid' | 'waived' | 'refunded';
export type PaymentMethod = 'cash' | 'venmo' | 'zelle' | 'paypal' | 'check' | 'other';

/** Integer cents. Floats would lose money a penny at a time. */
export interface Money {
  amountCents: number;
  currency: string;
}

export interface DuesRecord {
  duesRecordId: string;
  leagueMemberId: string;
  /** Resolved server-side from the portal member. */
  displayName: string;
  amountOwed: Money;
  amountPaid: Money;
  status: PaymentStatus;
  dueDate?: string;
  paidAt?: string;
  method?: PaymentMethod;
  note?: string;
}

export interface DuesResponse {
  dues: DuesRecord[];
  members: Array<{ leagueMemberId: string; displayName: string }>;
  summary: { totalOwedCents: number; totalPaidCents: number; unpaidCount: number };
  note: string;
}

export interface PayoutRecord {
  payoutRecordId: string;
  leagueMemberId: string;
  displayName: string;
  /** What the prize was for, in the league's own words. */
  reason: string;
  amount: Money;
  status: PaymentStatus;
  method?: PaymentMethod;
  week?: number;
  /** Set when the prize traces back to a finalized weekly challenge. */
  challengeResultId?: string;
  paidAt?: string;
  note?: string;
}

export interface PayoutsResponse {
  payouts: PayoutRecord[];
  members: Array<{ leagueMemberId: string; displayName: string }>;
  summary: { pendingCount: number; totalCents: number };
  note: string;
}

// --------------------------------------------------------------------------
// Commissioner tasks and announcements
// --------------------------------------------------------------------------

export type TaskCategory =
  | 'dues'
  | 'payouts'
  | 'draft'
  | 'challenges'
  | 'yahoo_connection'
  | 'import'
  | 'announcement'
  | 'other';

export interface CommissionerTask {
  taskId: string;
  title: string;
  detail?: string;
  category: TaskCategory;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: 'open' | 'in_progress' | 'done' | 'dismissed';
  dueDate?: string;
  completedAt?: string;
}

export interface TasksResponse {
  tasks: CommissionerTask[];
  openCount: number;
}

export interface Announcement {
  announcementId: string;
  title: string;
  body: string;
  status: 'draft' | 'published' | 'archived';
  pinned: boolean;
  publishedAt?: string;
  createdAt: string;
}

export interface AnnouncementsResponse {
  announcements: Announcement[];
}
