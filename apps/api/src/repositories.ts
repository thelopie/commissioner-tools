import {
  generateId,
  keys,
  skPrefix,
  type Announcement,
  type AuditAction,
  type AuditLog,
  type CommissionerOverride,
  type CommissionerTask,
  type DraftPositionSelection,
  type DuesRecord,
  type ImportBatch,
  type ImportRowResult,
  type InternalId,
  type Invitation,
  type League,
  type LeagueMember,
  type LeagueRecap,
  type LeagueRule,
  type LLWSAssignment,
  type LLWSTeam,
  type PayoutRecord,
  type PortalRole,
  type PortalUser,
  type PrizeRule,
  type Season,
  type SeasonYear,
  type WeekNumber,
  type WeeklyChallengeDefinition,
  type WeeklyChallengeResult,
  type YahooConnection,
  type YahooGuid,
  type YahooLeagueLink,
} from '@dinkel/shared';
import type { Table } from './lib/table.js';

/**
 * Repositories.
 *
 * Thin persistence for each entity. They own key construction and the audit
 * metadata every write carries; business rules live in the domain packages and the
 * route handlers, not here.
 */

const now = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, '');

/** Audit fields for a first write. */
function created(
  userId: InternalId,
): Pick<PortalUser, 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy' | 'version'> {
  const timestamp = now();
  return {
    createdAt: timestamp,
    createdBy: userId,
    updatedAt: timestamp,
    updatedBy: userId,
    version: 1,
  };
}

/** Audit fields for a subsequent write, bumping the version. */
function updated<T extends { createdAt: string; createdBy: InternalId; version: number }>(
  existing: T,
  userId: InternalId,
): Pick<T, 'createdAt' | 'createdBy'> & {
  updatedAt: string;
  updatedBy: InternalId;
  version: number;
} {
  return {
    createdAt: existing.createdAt,
    createdBy: existing.createdBy,
    updatedAt: now(),
    updatedBy: userId,
    version: existing.version + 1,
  };
}

type WithKeys<T> = T & {
  PK: string;
  SK: string;
  GSI1PK?: string;
  GSI1SK?: string;
  GSI2PK?: string;
  GSI2SK?: string;
};

export class UserRepository {
  constructor(private readonly table: Table) {}

  async findById(userId: InternalId): Promise<PortalUser | null> {
    return this.table.get<PortalUser>(keys.portalUser(userId));
  }

  async findByYahooGuid(yahooGuid: YahooGuid): Promise<PortalUser | null> {
    const index = keys.portalUserByGuid(yahooGuid);
    const results = await this.table.query<PortalUser>({
      pk: index.GSI1PK,
      indexName: 'GSI1',
      limit: 1,
    });
    return results[0] ?? null;
  }

  /**
   * Creates a user and claims their Yahoo GUID in one transaction.
   *
   * The uniqueness sentinel is what stops two simultaneous first-time sign-ins by
   * the same Yahoo account from creating two users â€” a read-then-write check would
   * race.
   */
  async create(
    user: Omit<PortalUser, 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy' | 'version'>,
  ): Promise<PortalUser> {
    const record: PortalUser = { ...user, ...created(user.userId) };
    const key = keys.portalUser(user.userId);
    const index = keys.portalUserByGuid(user.yahooGuid);

    await this.table.transactWrite(
      [
        { kind: 'put', item: { ...record, ...key, ...index }, mustNotExist: true },
        {
          kind: 'put',
          item: {
            ...keys.yahooGuidUniqueness(user.yahooGuid),
            entity: 'YahooGuidClaim',
            userId: user.userId,
          },
          mustNotExist: true,
        },
      ],
      'That Yahoo account is already linked to a portal user.',
    );

    return record;
  }

  async update(
    existing: PortalUser,
    changes: Partial<PortalUser>,
    actorUserId: InternalId,
  ): Promise<PortalUser> {
    const record: PortalUser = { ...existing, ...changes, ...updated(existing, actorUserId) };
    const key = keys.portalUser(existing.userId);
    const index = keys.portalUserByGuid(record.yahooGuid);

    await this.table.putVersioned({ ...record, ...key, ...index }, existing.version);
    return record;
  }

  async listByLeague(leagueId: InternalId): Promise<PortalUser[]> {
    // Users are queried through their league membership rather than scanned.
    const members = await this.table.query<LeagueMember>({
      pk: `LEAGUE#${leagueId}`,
      skPrefix: 'MEMBER#',
    });

    const userIds = [
      ...new Set(
        members.map((member) => member.userId).filter((id): id is InternalId => id !== null),
      ),
    ];
    const users = await Promise.all(userIds.map((userId) => this.findById(userId)));
    return users.filter((user): user is PortalUser => user !== null);
  }

  /**
   * Counts commissioners, so the last one cannot be demoted.
   *
   * A league with no commissioner cannot grant anyone access back, which would
   * require direct database surgery to recover from.
   */
  async countCommissioners(leagueId: InternalId): Promise<number> {
    const users = await this.listByLeague(leagueId);
    return users.filter((user) => user.role === 'commissioner' && user.status === 'active').length;
  }
}

export class SessionRepository {
  constructor(private readonly table: Table) {}

  async create(session: {
    sessionId: string;
    userId: InternalId;
    csrfToken: string;
    expiresAtEpochSeconds: number;
  }): Promise<void> {
    const index = keys.sessionsByUser(session.userId, session.sessionId);
    await this.table.put({
      ...keys.session(session.sessionId),
      ...index,
      entity: 'Session',
      ...session,
      // DynamoDB TTL expires the record; deleting it revokes early.
      expiresAt: session.expiresAtEpochSeconds,
      createdAt: now(),
    });
  }

  async find(sessionId: string): Promise<{
    sessionId: string;
    userId: InternalId;
    csrfToken: string;
    expiresAtEpochSeconds: number;
  } | null> {
    const record = await this.table.get<{
      sessionId: string;
      userId: InternalId;
      csrfToken: string;
      expiresAtEpochSeconds: number;
    }>(keys.session(sessionId));

    if (!record) return null;
    // TTL deletion is eventual, so expiry is enforced here too.
    if (record.expiresAtEpochSeconds <= Math.floor(Date.now() / 1000)) return null;
    return record;
  }

  async revoke(sessionId: string): Promise<void> {
    await this.table.delete(keys.session(sessionId));
  }

  /** Revokes every session for a user, e.g. when their access is removed. */
  async revokeAllForUser(userId: InternalId): Promise<number> {
    const index = keys.sessionsByUser(userId, '');
    const sessions = await this.table.query<{ sessionId: string }>({
      pk: index.GSI1PK,
      indexName: 'GSI1',
    });

    await Promise.all(sessions.map((session) => this.revoke(session.sessionId)));
    return sessions.length;
  }
}

export class OAuthStateRepository {
  constructor(private readonly table: Table) {}

  async create(state: {
    state: string;
    expiresAtEpochSeconds: number;
    returnTo: string;
    sessionId?: string;
  }): Promise<void> {
    await this.table.put({
      ...keys.oauthState(state.state),
      entity: 'OAuthState',
      ...state,
      expiresAt: state.expiresAtEpochSeconds,
      createdAt: now(),
    });
  }

  async find(state: string): Promise<{
    state: string;
    expiresAtEpochSeconds: number;
    returnTo: string;
    sessionId?: string;
    consumedAt?: string;
  } | null> {
    return this.table.get(keys.oauthState(state));
  }

  /**
   * Marks a state consumed and deletes it.
   *
   * Deleting rather than flagging: a state is single-use, and the record has no
   * value afterwards. A replayed callback then finds nothing and is rejected.
   */
  async consume(state: string): Promise<void> {
    await this.table.delete(keys.oauthState(state));
  }
}

export class ConnectionRepository {
  constructor(private readonly table: Table) {}

  async find(userId: InternalId): Promise<YahooConnection | null> {
    return this.table.get<YahooConnection>(keys.yahooConnection(userId));
  }

  async save(connection: YahooConnection, expectedVersion?: number): Promise<void> {
    await this.table.putVersioned(
      { ...connection, ...keys.yahooConnection(connection.userId) },
      expectedVersion,
    );
  }

  /** Unconditional write for token refresh, which must not fail on a version race. */
  async saveTokens(connection: YahooConnection): Promise<void> {
    await this.table.put({ ...connection, ...keys.yahooConnection(connection.userId) });
  }

  async delete(userId: InternalId): Promise<void> {
    await this.table.delete(keys.yahooConnection(userId));
  }
}

export class LeagueRepository {
  constructor(private readonly table: Table) {}

  async find(leagueId: InternalId): Promise<League | null> {
    return this.table.get<League>(keys.leagueRecord(leagueId));
  }

  /** The league this deployment serves, from the singleton pointer. */
  async findCurrentLeagueId(): Promise<InternalId | null> {
    const pointer = await this.table.get<{ leagueId: InternalId }>(keys.portalPointer());
    return pointer?.leagueId ?? null;
  }

  /**
   * Claims the deployment for a league.
   *
   * Conditional on the pointer not existing, so two people running setup at the
   * same time cannot both become the founding commissioner â€” the loser gets a
   * conflict rather than a silently overwritten league.
   *
   * @throws {import('@dinkel/shared').AppError} `duplicate` when already claimed.
   */
  async claimPortal(leagueId: InternalId): Promise<void> {
    await this.table.putNew({
      ...keys.portalPointer(),
      entity: 'PortalPointer',
      leagueId,
      claimedAt: now(),
    });
  }

  async save(league: League, expectedVersion?: number): Promise<void> {
    await this.table.putVersioned(
      { ...league, ...keys.leagueRecord(league.leagueId) },
      expectedVersion,
    );
  }

  async findSeason(leagueId: InternalId, seasonYear: SeasonYear): Promise<Season | null> {
    return this.table.get<Season>(keys.season(leagueId, seasonYear));
  }

  async listSeasons(leagueId: InternalId): Promise<Season[]> {
    return this.table.query<Season>({
      pk: `LEAGUE#${leagueId}`,
      skPrefix: skPrefix.season,
    });
  }

  async saveSeason(season: Season, expectedVersion?: number): Promise<void> {
    await this.table.putVersioned(
      { ...season, ...keys.season(season.leagueId, season.seasonYear) },
      expectedVersion,
    );
  }

  async findYahooLink(
    leagueId: InternalId,
    seasonYear: SeasonYear,
  ): Promise<YahooLeagueLink | null> {
    return this.table.get<YahooLeagueLink>(keys.yahooLeagueLink(leagueId, seasonYear));
  }

  async saveYahooLink(link: YahooLeagueLink, expectedVersion?: number): Promise<void> {
    await this.table.putVersioned(
      { ...link, ...keys.yahooLeagueLink(link.leagueId, link.seasonYear) },
      expectedVersion,
    );
  }

  async deleteYahooLink(leagueId: InternalId, seasonYear: SeasonYear): Promise<void> {
    await this.table.delete(keys.yahooLeagueLink(leagueId, seasonYear));
  }

  async listMembers(leagueId: InternalId, seasonYear: SeasonYear): Promise<LeagueMember[]> {
    return this.table.query<LeagueMember>({
      pk: `LEAGUE#${leagueId}`,
      skPrefix: skPrefix.member(seasonYear),
    });
  }

  async saveMember(member: LeagueMember, expectedVersion?: number): Promise<void> {
    await this.table.putVersioned(
      {
        ...member,
        ...keys.leagueMember(member.leagueId, member.seasonYear, member.leagueMemberId),
        ...(member.userId ? keys.leagueMemberByUser(member.userId, member.seasonYear) : {}),
      },
      expectedVersion,
    );
  }

  async listRules(leagueId: InternalId): Promise<LeagueRule[]> {
    return this.table.query<LeagueRule>({ pk: `LEAGUE#${leagueId}`, skPrefix: skPrefix.rule });
  }

  async saveRule(rule: LeagueRule, expectedVersion?: number): Promise<void> {
    await this.table.putVersioned(
      { ...rule, ...keys.leagueRule(rule.leagueId, rule.ruleId) },
      expectedVersion,
    );
  }

  async listPrizeRules(leagueId: InternalId, seasonYear: SeasonYear): Promise<PrizeRule[]> {
    return this.table.query<PrizeRule>({
      pk: `LEAGUE#${leagueId}`,
      skPrefix: skPrefix.prizeRule(seasonYear),
    });
  }

  async savePrizeRule(rule: PrizeRule, expectedVersion?: number): Promise<void> {
    await this.table.putVersioned(
      { ...rule, ...keys.prizeRule(rule.leagueId, rule.seasonYear, rule.prizeRuleId) },
      expectedVersion,
    );
  }
}

export class MoneyRepository {
  constructor(private readonly table: Table) {}

  async listDues(leagueId: InternalId, seasonYear: SeasonYear): Promise<DuesRecord[]> {
    return this.table.query<DuesRecord>({
      pk: `LEAGUE#${leagueId}`,
      skPrefix: skPrefix.dues(seasonYear),
    });
  }

  async findDues(
    leagueId: InternalId,
    seasonYear: SeasonYear,
    duesRecordId: InternalId,
  ): Promise<DuesRecord | null> {
    return this.table.get<DuesRecord>(keys.duesRecord(leagueId, seasonYear, duesRecordId));
  }

  async saveDues(record: DuesRecord, expectedVersion?: number): Promise<void> {
    await this.table.putVersioned(
      {
        ...record,
        ...keys.duesRecord(record.leagueId, record.seasonYear, record.duesRecordId),
        ...keys.duesByStatus(record.leagueId, record.seasonYear, record.status),
      },
      expectedVersion,
    );
  }

  async listPayouts(leagueId: InternalId, seasonYear: SeasonYear): Promise<PayoutRecord[]> {
    return this.table.query<PayoutRecord>({
      pk: `LEAGUE#${leagueId}`,
      skPrefix: skPrefix.payout(seasonYear),
    });
  }

  async findPayout(
    leagueId: InternalId,
    seasonYear: SeasonYear,
    payoutRecordId: InternalId,
  ): Promise<PayoutRecord | null> {
    return this.table.get<PayoutRecord>(keys.payoutRecord(leagueId, seasonYear, payoutRecordId));
  }

  async savePayout(record: PayoutRecord, expectedVersion?: number): Promise<void> {
    await this.table.putVersioned(
      {
        ...record,
        ...keys.payoutRecord(record.leagueId, record.seasonYear, record.payoutRecordId),
        ...keys.payoutByStatus(record.leagueId, record.seasonYear, record.status),
      },
      expectedVersion,
    );
  }
}

export class ChallengeRepository {
  constructor(private readonly table: Table) {}

  async listDefinitions(
    leagueId: InternalId,
    seasonYear: SeasonYear,
  ): Promise<WeeklyChallengeDefinition[]> {
    return this.table.query<WeeklyChallengeDefinition>({
      pk: `LEAGUE#${leagueId}`,
      skPrefix: skPrefix.challengeDefinition(seasonYear),
    });
  }

  async findDefinition(
    leagueId: InternalId,
    seasonYear: SeasonYear,
    slug: string,
  ): Promise<WeeklyChallengeDefinition | null> {
    return this.table.get<WeeklyChallengeDefinition>(
      keys.challengeDefinition(leagueId, seasonYear, slug),
    );
  }

  async saveDefinition(
    definition: WeeklyChallengeDefinition,
    expectedVersion?: number,
  ): Promise<void> {
    await this.table.putVersioned(
      {
        ...definition,
        ...keys.challengeDefinition(definition.leagueId, definition.seasonYear, definition.slug),
      },
      expectedVersion,
    );
  }

  async listResults(
    leagueId: InternalId,
    seasonYear: SeasonYear,
    week?: WeekNumber,
  ): Promise<WeeklyChallengeResult[]> {
    return this.table.query<WeeklyChallengeResult>({
      pk: `LEAGUE#${leagueId}`,
      skPrefix:
        week === undefined
          ? skPrefix.challengeResult(seasonYear)
          : skPrefix.challengeResultWeek(seasonYear, week),
    });
  }

  async findResult(
    leagueId: InternalId,
    seasonYear: SeasonYear,
    week: WeekNumber,
    slug: string,
  ): Promise<WeeklyChallengeResult | null> {
    return this.table.get<WeeklyChallengeResult>(
      keys.challengeResult(leagueId, seasonYear, week, slug),
    );
  }

  async saveResult(result: WeeklyChallengeResult, expectedVersion?: number): Promise<void> {
    await this.table.putVersioned(
      {
        ...result,
        ...keys.challengeResult(
          result.leagueId,
          result.seasonYear,
          result.week,
          result.challengeSlug,
        ),
        ...keys.challengeResultByStatus(
          result.leagueId,
          result.status,
          result.seasonYear,
          result.week,
        ),
      },
      expectedVersion,
    );
  }

  async saveOverride(override: CommissionerOverride): Promise<void> {
    await this.table.put({
      ...override,
      ...keys.commissionerOverride(override.leagueId, override.overrideId),
    });
  }

  async listOverrides(leagueId: InternalId): Promise<CommissionerOverride[]> {
    return this.table.query<CommissionerOverride>({
      pk: `LEAGUE#${leagueId}`,
      skPrefix: skPrefix.override,
    });
  }
}

export class LlwsRepository {
  constructor(private readonly table: Table) {}

  async listTeams(leagueId: InternalId, seasonYear: SeasonYear): Promise<LLWSTeam[]> {
    return this.table.query<LLWSTeam>({
      pk: `LEAGUE#${leagueId}`,
      skPrefix: skPrefix.llwsTeam(seasonYear),
    });
  }

  async findTeam(
    leagueId: InternalId,
    seasonYear: SeasonYear,
    llwsTeamId: InternalId,
  ): Promise<LLWSTeam | null> {
    return this.table.get<LLWSTeam>(keys.llwsTeam(leagueId, seasonYear, llwsTeamId));
  }

  async saveTeam(team: LLWSTeam, expectedVersion?: number): Promise<void> {
    await this.table.putVersioned(
      { ...team, ...keys.llwsTeam(team.leagueId, team.seasonYear, team.llwsTeamId) },
      expectedVersion,
    );
  }

  async listAssignments(leagueId: InternalId, seasonYear: SeasonYear): Promise<LLWSAssignment[]> {
    return this.table.query<LLWSAssignment>({
      pk: `LEAGUE#${leagueId}`,
      skPrefix: skPrefix.llwsAssignment(seasonYear),
    });
  }

  /**
   * Writes a whole draw atomically, claiming each LLWS team.
   *
   * The per-team sentinels make a double-assigned team impossible rather than
   * merely unlikely: if any claim already exists the entire draw fails and nothing
   * is written, so a partially-applied draw cannot exist.
   */
  async saveDraw(assignments: readonly LLWSAssignment[]): Promise<void> {
    const operations = assignments.flatMap((assignment) => [
      {
        kind: 'put' as const,
        item: {
          ...assignment,
          ...keys.llwsAssignment(
            assignment.leagueId,
            assignment.seasonYear,
            assignment.leagueMemberId,
          ),
        },
      },
      {
        kind: 'put' as const,
        item: {
          ...keys.llwsTeamAssignmentUniqueness(
            assignment.leagueId,
            assignment.seasonYear,
            assignment.llwsTeamId,
          ),
          entity: 'LLWSTeamClaim',
          leagueMemberId: assignment.leagueMemberId,
        },
        mustNotExist: true,
      },
    ]);

    await this.table.transactWrite(
      operations,
      'One or more LLWS teams are already assigned. Clear the existing draw before redrawing.',
    );
  }

  /** Clears a draw, including the team claims, so a redraw is possible. */
  async clearDraw(leagueId: InternalId, seasonYear: SeasonYear): Promise<number> {
    const assignments = await this.listAssignments(leagueId, seasonYear);

    await this.table.transactWrite(
      assignments.flatMap((assignment) => [
        {
          kind: 'delete' as const,
          key: keys.llwsAssignment(leagueId, seasonYear, assignment.leagueMemberId),
        },
        {
          kind: 'delete' as const,
          key: keys.llwsTeamAssignmentUniqueness(leagueId, seasonYear, assignment.llwsTeamId),
        },
      ]),
      'Could not clear the existing draw.',
    );

    return assignments.length;
  }

  async saveAssignment(assignment: LLWSAssignment, expectedVersion?: number): Promise<void> {
    await this.table.putVersioned(
      {
        ...assignment,
        ...keys.llwsAssignment(
          assignment.leagueId,
          assignment.seasonYear,
          assignment.leagueMemberId,
        ),
      },
      expectedVersion,
    );
  }

  async listSelections(
    leagueId: InternalId,
    seasonYear: SeasonYear,
  ): Promise<DraftPositionSelection[]> {
    return this.table.query<DraftPositionSelection>({
      pk: `LEAGUE#${leagueId}`,
      skPrefix: skPrefix.draftSelection(seasonYear),
    });
  }

  async findSelection(
    leagueId: InternalId,
    seasonYear: SeasonYear,
    leagueMemberId: InternalId,
  ): Promise<DraftPositionSelection | null> {
    return this.table.get<DraftPositionSelection>(
      keys.draftPositionSelection(leagueId, seasonYear, leagueMemberId),
    );
  }

  async saveSelection(selection: DraftPositionSelection, expectedVersion?: number): Promise<void> {
    await this.table.putVersioned(
      {
        ...selection,
        ...keys.draftPositionSelection(
          selection.leagueId,
          selection.seasonYear,
          selection.leagueMemberId,
        ),
      },
      expectedVersion,
    );
  }

  /**
   * Locks a pick and claims the slot atomically.
   *
   * The slot claim is what makes two simultaneous picks of the same slot
   * impossible. The in-memory check in `assertCanSelect` catches the ordinary
   * case; this catches the race.
   */
  async lockSelection(selection: DraftPositionSelection, position: number): Promise<void> {
    await this.table.transactWrite(
      [
        {
          kind: 'put',
          item: {
            ...selection,
            ...keys.draftPositionSelection(
              selection.leagueId,
              selection.seasonYear,
              selection.leagueMemberId,
            ),
          },
        },
        {
          kind: 'put',
          item: {
            ...keys.draftPositionUniqueness(selection.leagueId, selection.seasonYear, position),
            entity: 'DraftPositionClaim',
            leagueMemberId: selection.leagueMemberId,
          },
          mustNotExist: true,
        },
      ],
      `Draft slot ${position} was just taken by someone else. Choose another.`,
    );
  }

  async incrementReminders(
    leagueId: InternalId,
    seasonYear: SeasonYear,
    leagueMemberId: InternalId,
  ): Promise<number> {
    return this.table.increment(
      keys.draftPositionSelection(leagueId, seasonYear, leagueMemberId),
      'remindersSent',
    );
  }
}

export class OpsRepository {
  constructor(private readonly table: Table) {}

  async listTasks(leagueId: InternalId): Promise<CommissionerTask[]> {
    return this.table.query<CommissionerTask>({
      pk: `LEAGUE#${leagueId}`,
      skPrefix: skPrefix.task,
    });
  }

  async findTask(leagueId: InternalId, taskId: InternalId): Promise<CommissionerTask | null> {
    return this.table.get<CommissionerTask>(keys.commissionerTask(leagueId, taskId));
  }

  async saveTask(task: CommissionerTask, expectedVersion?: number): Promise<void> {
    await this.table.putVersioned(
      {
        ...task,
        ...keys.commissionerTask(task.leagueId, task.taskId),
        ...keys.taskByStatus(task.leagueId, task.status, task.taskId),
      },
      expectedVersion,
    );
  }

  /**
   * Opens a system task at most once per idempotency key.
   *
   * Without this, an hourly OAuth health check that keeps failing would open a new
   * task every hour and bury the dashboard.
   */
  async openSystemTask(task: CommissionerTask): Promise<boolean> {
    if (!task.idempotencyKey) {
      await this.saveTask(task);
      return true;
    }

    try {
      await this.table.transactWrite(
        [
          {
            kind: 'put',
            item: {
              ...keys.taskIdempotency(task.leagueId, task.idempotencyKey),
              entity: 'TaskClaim',
              taskId: task.taskId,
            },
            mustNotExist: true,
          },
          {
            kind: 'put',
            item: {
              ...task,
              ...keys.commissionerTask(task.leagueId, task.taskId),
              ...keys.taskByStatus(task.leagueId, task.status, task.taskId),
            },
          },
        ],
        'That task already exists.',
      );
      return true;
    } catch {
      // Already open. Not an error: the condition is still true and the
      // commissioner already has one task about it.
      return false;
    }
  }

  async listAnnouncements(leagueId: InternalId): Promise<Announcement[]> {
    return this.table.query<Announcement>({
      pk: `LEAGUE#${leagueId}`,
      skPrefix: skPrefix.announcement,
    });
  }

  async findAnnouncement(
    leagueId: InternalId,
    announcementId: InternalId,
  ): Promise<Announcement | null> {
    return this.table.get<Announcement>(keys.announcement(leagueId, announcementId));
  }

  async saveAnnouncement(announcement: Announcement, expectedVersion?: number): Promise<void> {
    await this.table.putVersioned(
      { ...announcement, ...keys.announcement(announcement.leagueId, announcement.announcementId) },
      expectedVersion,
    );
  }

  async findRecap(
    leagueId: InternalId,
    seasonYear: SeasonYear,
    week: WeekNumber,
  ): Promise<LeagueRecap | null> {
    return this.table.get<LeagueRecap>(keys.recap(leagueId, seasonYear, week));
  }

  async listRecaps(leagueId: InternalId, seasonYear: SeasonYear): Promise<LeagueRecap[]> {
    return this.table.query<LeagueRecap>({
      pk: `LEAGUE#${leagueId}`,
      skPrefix: skPrefix.recap(seasonYear),
    });
  }

  async saveRecap(recap: LeagueRecap, expectedVersion?: number): Promise<void> {
    await this.table.putVersioned(
      { ...recap, ...keys.recap(recap.leagueId, recap.seasonYear, recap.week) },
      expectedVersion,
    );
  }
}

export class ImportRepository {
  constructor(private readonly table: Table) {}

  async listBatches(leagueId: InternalId): Promise<ImportBatch[]> {
    return this.table.query<ImportBatch>({
      pk: `LEAGUE#${leagueId}`,
      skPrefix: skPrefix.importBatch,
    });
  }

  async findBatch(leagueId: InternalId, importBatchId: InternalId): Promise<ImportBatch | null> {
    return this.table.get<ImportBatch>(keys.importBatch(leagueId, importBatchId));
  }

  async saveBatch(batch: ImportBatch, expectedVersion?: number): Promise<void> {
    await this.table.putVersioned(
      { ...batch, ...keys.importBatch(batch.leagueId, batch.importBatchId) },
      expectedVersion,
    );
  }

  async saveRows(rows: readonly ImportRowResult[]): Promise<void> {
    // Written individually rather than transactionally: a transaction caps at 100
    // items and a legacy spreadsheet can be longer. Row results are diagnostic, so
    // a partial write is recoverable by re-running the dry run.
    for (const row of rows) {
      await this.table.put({
        ...row,
        ...keys.importRowResult(row.leagueId, row.importBatchId, row.rowNumber),
      });
    }
  }

  async listRows(leagueId: InternalId, importBatchId: InternalId): Promise<ImportRowResult[]> {
    return this.table.query<ImportRowResult>({
      pk: `LEAGUE#${leagueId}#IMPORT#${importBatchId}`,
      skPrefix: skPrefix.importRow,
    });
  }
}

export class AuditRepository {
  constructor(private readonly table: Table) {}

  /**
   * Appends an audit record.
   *
   * Append-only: no route updates or deletes these. Detail values pass through the
   * same redaction the logger uses before reaching here, so no token or raw Yahoo
   * payload can land in the audit trail.
   */
  async record(entry: {
    leagueId: InternalId;
    action: AuditAction;
    actorUserId: InternalId | null;
    actorRole: 'commissioner' | 'manager' | 'readonly' | 'system';
    summary: string;
    correlationId: string;
    targetEntity?: string;
    targetId?: string;
    detail?: Record<string, string | number | boolean | null>;
    sourceIpPrefix?: string;
  }): Promise<AuditLog> {
    const auditLogId = generateId();
    const record: AuditLog = {
      entity: 'AuditLog',
      auditLogId,
      at: now(),
      detail: {},
      ...entry,
    };

    await this.table.put({
      ...record,
      ...keys.auditLog(entry.leagueId, auditLogId),
      ...keys.auditLogByAction(entry.leagueId, entry.action, auditLogId),
    });

    return record;
  }

  /** Most recent first, which is what a dashboard wants. */
  async list(leagueId: InternalId, limit = 100): Promise<AuditLog[]> {
    return this.table.query<AuditLog>({
      pk: `LEAGUE#${leagueId}#AUDIT`,
      skPrefix: skPrefix.auditLog,
      ascending: false,
      limit,
    });
  }

  async listByAction(leagueId: InternalId, action: AuditAction, limit = 50): Promise<AuditLog[]> {
    const index = keys.auditLogByAction(leagueId, action, '' as InternalId);
    return this.table.query<AuditLog>({
      pk: index.GSI2PK,
      indexName: 'GSI2',
      ascending: false,
      limit,
    });
  }
}

export class InvitationRepository {
  constructor(private readonly table: Table) {}

  async create(invitation: Invitation): Promise<void> {
    const index = keys.invitationByTokenHash(invitation.tokenHash);
    await this.table.putNew({
      ...invitation,
      ...keys.invitation(invitation.leagueId, invitation.invitationId),
      ...index,
    });
  }

  async findByTokenHash(tokenHash: string): Promise<Invitation | null> {
    const index = keys.invitationByTokenHash(tokenHash);
    const results = await this.table.query<Invitation>({
      pk: index.GSI1PK,
      indexName: 'GSI1',
      limit: 1,
    });
    return results[0] ?? null;
  }

  async list(leagueId: InternalId): Promise<Invitation[]> {
    return this.table.query<Invitation>({ pk: `LEAGUE#${leagueId}`, skPrefix: 'INVITATION#' });
  }

  async save(invitation: Invitation, expectedVersion?: number): Promise<void> {
    await this.table.putVersioned(
      {
        ...invitation,
        ...keys.invitation(invitation.leagueId, invitation.invitationId),
        ...keys.invitationByTokenHash(invitation.tokenHash),
      },
      expectedVersion,
    );
  }
}

export interface Repositories {
  users: UserRepository;
  sessions: SessionRepository;
  oauthStates: OAuthStateRepository;
  connections: ConnectionRepository;
  leagues: LeagueRepository;
  money: MoneyRepository;
  challenges: ChallengeRepository;
  llws: LlwsRepository;
  ops: OpsRepository;
  imports: ImportRepository;
  audit: AuditRepository;
  invitations: InvitationRepository;
}

export function createRepositories(table: Table): Repositories {
  return {
    users: new UserRepository(table),
    sessions: new SessionRepository(table),
    oauthStates: new OAuthStateRepository(table),
    connections: new ConnectionRepository(table),
    leagues: new LeagueRepository(table),
    money: new MoneyRepository(table),
    challenges: new ChallengeRepository(table),
    llws: new LlwsRepository(table),
    ops: new OpsRepository(table),
    imports: new ImportRepository(table),
    audit: new AuditRepository(table),
    invitations: new InvitationRepository(table),
  };
}

export { created, updated, now };
export type { WithKeys };
export type { PortalRole };
