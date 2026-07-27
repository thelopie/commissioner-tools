import type { InternalId, SeasonYear, WeekNumber, YahooGuid } from './ids.js';
import type { ImportKind } from './entities/import.js';

/**
 * Single-table DynamoDB key design.
 *
 * One table, because every access pattern here is a lookup inside one league or
 * one user. Multiple tables would multiply IAM statements and CDK surface for a
 * ten-person league without buying anything.
 *
 * Conventions:
 *   PK  — the partition that owns the item, almost always `LEAGUE#{leagueId}`
 *   SK  — entity type then identifying suffix, so a `begins_with` query fetches
 *         one entity type cheaply and range keys sort chronologically
 *   GSI1 — lookups that do not start from a league: sign-in by Yahoo GUID, and
 *          idempotency lookups by external import key
 *   GSI2 — cross-cutting "what needs attention" reads: open tasks, unpaid dues,
 *          provisional results, by status
 *
 * Sortable ULIDs mean an ascending SK scan is already chronological, so no
 * separate created-at index is needed.
 */

export interface TableKey {
  PK: string;
  SK: string;
}

export interface Gsi1Key {
  GSI1PK: string;
  GSI1SK: string;
}

export interface Gsi2Key {
  GSI2PK: string;
  GSI2SK: string;
}

/** Zero-pads a week so `WEEK#02` sorts before `WEEK#10` lexically. */
const week = (value: WeekNumber): string => String(value).padStart(2, '0');

const league = (leagueId: InternalId): string => `LEAGUE#${leagueId}`;

export const keys = {
  /**
   * Singleton pointer to the league this deployment serves.
   *
   * The portal is single-league by design: one Dinkel league, one deployment.
   * Written once at bootstrap with `attribute_not_exists`, which is what makes
   * "the first authenticated user claims the league" safe against two people
   * running setup simultaneously.
   */
  portalPointer: (): TableKey => ({
    PK: 'PORTAL',
    SK: 'CURRENT_LEAGUE',
  }),

  // ---------------------------------------------------------------- users
  /**
   * Users live in their own partition rather than under a league: a user exists
   * before any league membership, and sign-in must find them without knowing
   * which league they belong to.
   */
  portalUser: (userId: InternalId): TableKey => ({
    PK: `USER#${userId}`,
    SK: 'PROFILE',
  }),

  /**
   * Sign-in lookup. Uniqueness of Yahoo GUID to user is enforced by a
   * conditional write on this GSI1PK plus a dedicated uniqueness item below.
   */
  portalUserByGuid: (yahooGuid: YahooGuid): Gsi1Key => ({
    GSI1PK: `YAHOO_GUID#${yahooGuid}`,
    GSI1SK: 'USER',
  }),

  /**
   * Uniqueness sentinel. Written with `attribute_not_exists(PK)` in the same
   * transaction as the user, so two concurrent first-time sign-ins by the same
   * Yahoo account cannot both create a user.
   */
  yahooGuidUniqueness: (yahooGuid: YahooGuid): TableKey => ({
    PK: `UNIQUE#YAHOO_GUID#${yahooGuid}`,
    SK: 'UNIQUE',
  }),

  /** Session records. TTL-expired by DynamoDB, and deletable for revocation. */
  session: (sessionId: string): TableKey => ({
    PK: `SESSION#${sessionId}`,
    SK: 'SESSION',
  }),

  /** All sessions for a user, so "sign out everywhere" is one query. */
  sessionsByUser: (userId: InternalId, sessionId: string): Gsi1Key => ({
    GSI1PK: `USER_SESSIONS#${userId}`,
    GSI1SK: `SESSION#${sessionId}`,
  }),

  /** OAuth state: single-use, TTL-expired, never reusable after consumption. */
  oauthState: (state: string): TableKey => ({
    PK: `OAUTH_STATE#${state}`,
    SK: 'STATE',
  }),

  yahooConnection: (userId: InternalId): TableKey => ({
    PK: `USER#${userId}`,
    SK: 'YAHOO_CONNECTION',
  }),

  // --------------------------------------------------------------- league
  leagueRecord: (leagueId: InternalId): TableKey => ({
    PK: league(leagueId),
    SK: 'LEAGUE',
  }),

  season: (leagueId: InternalId, seasonYear: SeasonYear): TableKey => ({
    PK: league(leagueId),
    SK: `SEASON#${seasonYear}`,
  }),

  leagueMember: (
    leagueId: InternalId,
    seasonYear: SeasonYear,
    leagueMemberId: InternalId,
  ): TableKey => ({
    PK: league(leagueId),
    SK: `MEMBER#${seasonYear}#${leagueMemberId}`,
  }),

  /** A user's memberships across leagues and seasons. */
  leagueMemberByUser: (userId: InternalId, seasonYear: SeasonYear): Gsi1Key => ({
    GSI1PK: `USER_MEMBERSHIP#${userId}`,
    GSI1SK: `SEASON#${seasonYear}`,
  }),

  yahooLeagueLink: (leagueId: InternalId, seasonYear: SeasonYear): TableKey => ({
    PK: league(leagueId),
    SK: `YAHOO_LINK#${seasonYear}`,
  }),

  invitation: (leagueId: InternalId, invitationId: InternalId): TableKey => ({
    PK: league(leagueId),
    SK: `INVITATION#${invitationId}`,
  }),

  /** Invite redemption looks up by token hash, not by league. */
  invitationByTokenHash: (tokenHash: string): Gsi1Key => ({
    GSI1PK: `INVITE_TOKEN#${tokenHash}`,
    GSI1SK: 'INVITATION',
  }),

  leagueRule: (leagueId: InternalId, ruleId: InternalId): TableKey => ({
    PK: league(leagueId),
    SK: `RULE#${ruleId}`,
  }),

  prizeRule: (leagueId: InternalId, seasonYear: SeasonYear, prizeRuleId: InternalId): TableKey => ({
    PK: league(leagueId),
    SK: `PRIZE_RULE#${seasonYear}#${prizeRuleId}`,
  }),

  // ---------------------------------------------------------------- money
  duesRecord: (
    leagueId: InternalId,
    seasonYear: SeasonYear,
    duesRecordId: InternalId,
  ): TableKey => ({
    PK: league(leagueId),
    SK: `DUES#${seasonYear}#${duesRecordId}`,
  }),

  /** "Who still owes?" — one query on status, no table scan. */
  duesByStatus: (leagueId: InternalId, seasonYear: SeasonYear, status: string): Gsi2Key => ({
    GSI2PK: `DUES_STATUS#${leagueId}#${status}`,
    GSI2SK: `SEASON#${seasonYear}`,
  }),

  payoutRecord: (
    leagueId: InternalId,
    seasonYear: SeasonYear,
    payoutRecordId: InternalId,
  ): TableKey => ({
    PK: league(leagueId),
    SK: `PAYOUT#${seasonYear}#${payoutRecordId}`,
  }),

  payoutByStatus: (leagueId: InternalId, seasonYear: SeasonYear, status: string): Gsi2Key => ({
    GSI2PK: `PAYOUT_STATUS#${leagueId}#${status}`,
    GSI2SK: `SEASON#${seasonYear}`,
  }),

  // ----------------------------------------------------------- challenges
  challengeDefinition: (leagueId: InternalId, seasonYear: SeasonYear, slug: string): TableKey => ({
    PK: league(leagueId),
    SK: `CHALLENGE_DEF#${seasonYear}#${slug}`,
  }),

  /**
   * One result per challenge per week. The slug in the sort key makes the write
   * naturally idempotent: recalculating overwrites rather than appending.
   */
  challengeResult: (
    leagueId: InternalId,
    seasonYear: SeasonYear,
    weekNumber: WeekNumber,
    slug: string,
  ): TableKey => ({
    PK: league(leagueId),
    SK: `CHALLENGE_RESULT#${seasonYear}#W${week(weekNumber)}#${slug}`,
  }),

  /** "What is still provisional and needs finalizing?" */
  challengeResultByStatus: (
    leagueId: InternalId,
    status: string,
    seasonYear: SeasonYear,
    weekNumber: WeekNumber,
  ): Gsi2Key => ({
    GSI2PK: `CHALLENGE_STATUS#${leagueId}#${status}`,
    GSI2SK: `${seasonYear}#W${week(weekNumber)}`,
  }),

  commissionerOverride: (leagueId: InternalId, overrideId: InternalId): TableKey => ({
    PK: league(leagueId),
    SK: `OVERRIDE#${overrideId}`,
  }),

  // ----------------------------------------------------------------- LLWS
  llwsTeam: (leagueId: InternalId, seasonYear: SeasonYear, llwsTeamId: InternalId): TableKey => ({
    PK: league(leagueId),
    SK: `LLWS_TEAM#${seasonYear}#${llwsTeamId}`,
  }),

  llwsAssignment: (
    leagueId: InternalId,
    seasonYear: SeasonYear,
    leagueMemberId: InternalId,
  ): TableKey => ({
    PK: league(leagueId),
    SK: `LLWS_ASSIGNMENT#${seasonYear}#${leagueMemberId}`,
  }),

  /**
   * Enforces one-team-per-manager in the other direction: writing this sentinel
   * with `attribute_not_exists` makes a double-assigned team impossible rather
   * than merely unlikely.
   */
  llwsTeamAssignmentUniqueness: (
    leagueId: InternalId,
    seasonYear: SeasonYear,
    llwsTeamId: InternalId,
  ): TableKey => ({
    PK: league(leagueId),
    SK: `UNIQUE#LLWS_TEAM_ASSIGNED#${seasonYear}#${llwsTeamId}`,
  }),

  draftPositionSelection: (
    leagueId: InternalId,
    seasonYear: SeasonYear,
    leagueMemberId: InternalId,
  ): TableKey => ({
    PK: league(leagueId),
    SK: `DRAFT_SELECTION#${seasonYear}#${leagueMemberId}`,
  }),

  /** Same trick for draft slots: a slot can be taken exactly once. */
  draftPositionUniqueness: (
    leagueId: InternalId,
    seasonYear: SeasonYear,
    position: number,
  ): TableKey => ({
    PK: league(leagueId),
    SK: `UNIQUE#DRAFT_POSITION#${seasonYear}#${String(position).padStart(2, '0')}`,
  }),

  // ------------------------------------------------------------------ ops
  commissionerTask: (leagueId: InternalId, taskId: InternalId): TableKey => ({
    PK: league(leagueId),
    SK: `TASK#${taskId}`,
  }),

  taskByStatus: (leagueId: InternalId, status: string, taskId: InternalId): Gsi2Key => ({
    GSI2PK: `TASK_STATUS#${leagueId}#${status}`,
    GSI2SK: `TASK#${taskId}`,
  }),

  /** Dedupe key for system-opened tasks, so a repeating check opens one task. */
  taskIdempotency: (leagueId: InternalId, idempotencyKey: string): TableKey => ({
    PK: league(leagueId),
    SK: `UNIQUE#TASK#${idempotencyKey}`,
  }),

  announcement: (leagueId: InternalId, announcementId: InternalId): TableKey => ({
    PK: league(leagueId),
    SK: `ANNOUNCEMENT#${announcementId}`,
  }),

  recap: (leagueId: InternalId, seasonYear: SeasonYear, weekNumber: WeekNumber): TableKey => ({
    PK: league(leagueId),
    SK: `RECAP#${seasonYear}#W${week(weekNumber)}`,
  }),

  historicalRecord: (leagueId: InternalId, recordKey: string): TableKey => ({
    PK: league(leagueId),
    SK: `RECORD#${recordKey}`,
  }),

  // -------------------------------------------------------------- imports
  importBatch: (leagueId: InternalId, importBatchId: InternalId): TableKey => ({
    PK: league(leagueId),
    SK: `IMPORT#${importBatchId}`,
  }),

  /** Row results live under the batch, so rollback is a single-partition query. */
  importRowResult: (
    leagueId: InternalId,
    importBatchId: InternalId,
    rowNumber: number,
  ): TableKey => ({
    PK: `${league(leagueId)}#IMPORT#${importBatchId}`,
    SK: `ROW#${String(rowNumber).padStart(7, '0')}`,
  }),

  /**
   * Idempotency lookup for imports: has this external key already been imported
   * for this kind of data? This is what makes re-running the same CSV a no-op
   * instead of a duplicate.
   */
  importExternalKey: (leagueId: InternalId, kind: ImportKind, externalKey: string): Gsi1Key => ({
    GSI1PK: `IMPORT_KEY#${leagueId}#${kind}`,
    GSI1SK: externalKey,
  }),

  // ---------------------------------------------------------------- audit
  /** ULID sort key means a descending query is "most recent first" for free. */
  auditLog: (leagueId: InternalId, auditLogId: InternalId): TableKey => ({
    PK: `${league(leagueId)}#AUDIT`,
    SK: `LOG#${auditLogId}`,
  }),

  auditLogByAction: (leagueId: InternalId, action: string, auditLogId: InternalId): Gsi2Key => ({
    GSI2PK: `AUDIT_ACTION#${leagueId}#${action}`,
    GSI2SK: `LOG#${auditLogId}`,
  }),

  /** Scheduled job runs, for observability and duplicate-execution protection. */
  jobExecution: (jobName: string, executionKey: string): TableKey => ({
    PK: `JOB#${jobName}`,
    SK: `EXEC#${executionKey}`,
  }),

  // ------------------------------------------------- Yahoo cache (TTL only)
  /**
   * Yahoo cache items sit in their own partition prefix with a mandatory TTL
   * attribute. Nothing else in the table carries Yahoo-derived content.
   */
  yahooCache: (cacheKey: string): TableKey => ({
    PK: `YAHOO_CACHE#${cacheKey}`,
    SK: 'CACHE',
  }),
} as const;

/** SK prefixes for `begins_with` queries. */
export const skPrefix = {
  season: 'SEASON#',
  member: (seasonYear: SeasonYear) => `MEMBER#${seasonYear}#`,
  rule: 'RULE#',
  prizeRule: (seasonYear: SeasonYear) => `PRIZE_RULE#${seasonYear}#`,
  dues: (seasonYear: SeasonYear) => `DUES#${seasonYear}#`,
  payout: (seasonYear: SeasonYear) => `PAYOUT#${seasonYear}#`,
  challengeDefinition: (seasonYear: SeasonYear) => `CHALLENGE_DEF#${seasonYear}#`,
  challengeResult: (seasonYear: SeasonYear) => `CHALLENGE_RESULT#${seasonYear}#`,
  challengeResultWeek: (seasonYear: SeasonYear, weekNumber: WeekNumber) =>
    `CHALLENGE_RESULT#${seasonYear}#W${week(weekNumber)}#`,
  llwsTeam: (seasonYear: SeasonYear) => `LLWS_TEAM#${seasonYear}#`,
  llwsAssignment: (seasonYear: SeasonYear) => `LLWS_ASSIGNMENT#${seasonYear}#`,
  draftSelection: (seasonYear: SeasonYear) => `DRAFT_SELECTION#${seasonYear}#`,
  task: 'TASK#',
  announcement: 'ANNOUNCEMENT#',
  recap: (seasonYear: SeasonYear) => `RECAP#${seasonYear}#`,
  record: 'RECORD#',
  importBatch: 'IMPORT#',
  importRow: 'ROW#',
  override: 'OVERRIDE#',
  auditLog: 'LOG#',
} as const;
