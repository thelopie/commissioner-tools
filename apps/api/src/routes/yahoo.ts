import { Hono } from 'hono';
import {
  AppError,
  generateId,
  seasonYearSchema,
  yahooGameKeySchema,
  yahooLeagueKeySchema,
  type InternalId,
  type YahooLeagueKey,
} from '@dinkel/shared';
import { getCapabilityMatrix } from '@dinkel/yahoo-client';
import { z } from 'zod';
import type { AppEnv } from '../context.js';
import { requireLeagueId } from '../context.js';
import { requireAuthenticated, requireCommissioner } from '../lib/authorization.js';
import { created } from '../repositories.js';
import { parseJson } from './auth.js';

/**
 * Yahoo connection status, league discovery, and the read-only league view.
 *
 * Everything Yahoo returns here is rendered live and cached briefly. Nothing is
 * persisted except the Yahoo identifiers needed to fetch again.
 */

export const yahooRoutes = new Hono<AppEnv>();

/** Connection status for the dashboard, including last success and last failure. */
yahooRoutes.get('/api/yahoo/connection', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireAuthenticated(ctx.principal);

  const connection = await ctx.repositories.connections.find(principal.userId as InternalId);

  if (!connection) {
    return c.json({
      connected: false,
      yahooMode: ctx.config.env.YAHOO_MODE,
      capabilityMatrixReviewedAt: getCapabilityMatrix().lastReviewedAt,
    });
  }

  return c.json({
    connected: connection.status === 'active',
    status: connection.status,
    yahooMode: ctx.config.env.YAHOO_MODE,
    // No token, no GUID, no encrypted material — only operational facts.
    lastSuccessAt: connection.lastSuccessAt ?? null,
    lastFailureAt: connection.lastFailureAt ?? null,
    lastFailureReason: connection.lastFailureReason ?? null,
    lastRefreshedAt: connection.lastRefreshedAt ?? null,
    refreshTokenRotations: connection.refreshTokenRotations,
    grantedScope: connection.grantedScope ?? null,
    connectedAt: connection.createdAt,
    capabilityMatrixReviewedAt: getCapabilityMatrix().lastReviewedAt,
  });
});

/**
 * Removes a Yahoo connection.
 *
 * Deletes the stored tokens and every cached Yahoo response for the user, so
 * disconnecting actually removes the data rather than merely hiding it.
 */
yahooRoutes.delete('/api/yahoo/connection', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireAuthenticated(ctx.principal);
  const userId = principal.userId as InternalId;

  const connection = await ctx.repositories.connections.find(userId);
  if (!connection) {
    return c.json({ ok: true, alreadyDisconnected: true });
  }

  await ctx.repositories.connections.delete(userId);

  // Cached Yahoo content for this user goes too. Leaving it would keep Yahoo data
  // after the user withdrew access, which the terms do not allow.
  const link = ctx.leagueId ? await currentLink(ctx) : null;
  const cacheKeys = [`user_leagues:${userId}`];
  if (link) {
    cacheKeys.push(`league_metadata:${link.yahooLeagueKey}`, `league_teams:${link.yahooLeagueKey}`);
  }
  await ctx.table.invalidateCache(cacheKeys);

  if (ctx.leagueId) {
    await ctx.repositories.audit.record({
      leagueId: ctx.leagueId,
      action: 'yahoo.connection_deleted',
      actorUserId: userId,
      actorRole: principal.role,
      summary: 'Removed their Yahoo connection and cleared cached Yahoo data.',
      correlationId: ctx.correlationId,
      targetEntity: 'YahooConnection',
      targetId: userId,
    });
  }

  ctx.logger.info('Yahoo connection removed', { userId, clearedCacheKeys: cacheKeys.length });

  return c.json({ ok: true });
});

/** The signed-in user's football leagues, for selection. */
yahooRoutes.get('/api/yahoo/leagues', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireAuthenticated(ctx.principal);

  const refresh = c.req.query('refresh') === '1';
  const leagues = await ctx.yahoo.getLeagues(principal.userId as InternalId, { refresh });

  return c.json({
    leagues: leagues.map((league) => ({
      yahooLeagueKey: league.leagueKey,
      yahooGameKey: league.gameKey,
      name: league.name,
      season: league.season ?? null,
      teamCount: league.teamCount ?? null,
      scoringType: league.scoringType ?? null,
      // A hint for the selection UI only. It grants nothing in this portal.
      isYahooCommissioner: league.isCommissioner ?? null,
      isFinished: league.isFinished ?? null,
    })),
  });
});

/**
 * Links a Yahoo league to a Dinkel season.
 *
 * Nothing about the league, game, team, or season is hardcoded: every identifier
 * arrives from the commissioner's selection and is stored separately from Dinkel's
 * own IDs, so the link can be changed or lost without touching league history.
 */
yahooRoutes.post('/api/yahoo/league-link', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);

  const body = await parseJson(
    c,
    z.object({
      yahooLeagueKey: yahooLeagueKeySchema,
      yahooGameKey: yahooGameKeySchema,
      seasonYear: seasonYearSchema,
    }),
  );

  const userId = principal.userId as InternalId;

  // Confirm the selection is actually readable before recording it, so a broken
  // link is caught here rather than on every later dashboard load.
  const metadata = await ctx.yahoo.getLeagueMetadata(userId, body.yahooLeagueKey, {
    refresh: true,
  });

  const existing = await ctx.repositories.leagues.findYahooLink(leagueId, body.seasonYear);

  await ctx.repositories.leagues.saveYahooLink(
    {
      entity: 'YahooLeagueLink',
      linkId: existing?.linkId ?? generateId(),
      leagueId,
      seasonYear: body.seasonYear,
      yahooGameKey: body.yahooGameKey,
      yahooLeagueKey: body.yahooLeagueKey,
      connectionUserId: userId,
      ...(metadata.isCommissioner === undefined
        ? {}
        : { yahooCommissionerHint: metadata.isCommissioner }),
      linkedAt: new Date().toISOString().replace(/\.\d{3}Z$/, ''),
      status: 'active',
      ...(existing
        ? {
            createdAt: existing.createdAt,
            createdBy: existing.createdBy,
            updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, ''),
            updatedBy: userId,
            version: existing.version + 1,
          }
        : created(userId)),
    },
    existing?.version,
  );

  // Ensure a season record exists, so the rest of the portal has something to
  // hang dues, challenges, and draft order from.
  const season = await ctx.repositories.leagues.findSeason(leagueId, body.seasonYear);
  if (!season) {
    await ctx.repositories.leagues.saveSeason({
      entity: 'Season',
      seasonId: generateId(),
      leagueId,
      seasonYear: body.seasonYear,
      status: 'in_progress',
      buyIn: { amountCents: 0, currency: 'USD' },
      finalFinishOrder: [],
      ...(metadata.teamCount === undefined ? {} : { teamCount: metadata.teamCount }),
      ...(metadata.playoffStartWeek === undefined
        ? {}
        : { playoffStartWeek: metadata.playoffStartWeek }),
      ...created(userId),
    });
  }

  const league = await ctx.repositories.leagues.find(leagueId);
  if (league && league.currentSeasonYear !== body.seasonYear) {
    await ctx.repositories.leagues.save(
      {
        ...league,
        currentSeasonYear: body.seasonYear,
        updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, ''),
        updatedBy: userId,
        version: league.version + 1,
      },
      league.version,
    );
  }

  await ctx.repositories.audit.record({
    leagueId,
    action: 'yahoo.league_linked',
    actorUserId: userId,
    actorRole: principal.role,
    summary: `Linked Yahoo league for the ${body.seasonYear} season.`,
    correlationId: ctx.correlationId,
    targetEntity: 'YahooLeagueLink',
    targetId: body.yahooLeagueKey,
    detail: { seasonYear: body.seasonYear, yahooGameKey: body.yahooGameKey },
  });

  return c.json({ ok: true, seasonYear: body.seasonYear }, 201);
});

yahooRoutes.delete('/api/yahoo/league-link/:seasonYear', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);

  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));

  const link = await ctx.repositories.leagues.findYahooLink(leagueId, seasonYear);
  if (!link)
    throw new AppError('not_found', {
      publicMessage: 'No Yahoo league is linked for that season.',
    });

  await ctx.repositories.leagues.deleteYahooLink(leagueId, seasonYear);
  await ctx.table.invalidateCache([
    `league_metadata:${link.yahooLeagueKey}`,
    `league_teams:${link.yahooLeagueKey}`,
  ]);

  await ctx.repositories.audit.record({
    leagueId,
    action: 'yahoo.league_unlinked',
    actorUserId: principal.userId as InternalId,
    actorRole: principal.role,
    summary: `Unlinked the Yahoo league for ${seasonYear}.`,
    correlationId: ctx.correlationId,
  });

  return c.json({ ok: true });
});

/**
 * The read-only league view: metadata, teams, and managers.
 *
 * Yahoo names come back live on every request and are cached for minutes, never
 * stored. That is why a manager who leaves the league still has a name on their
 * 2021 challenge win: that name is Dinkel's own profile field, not this response.
 */
yahooRoutes.get('/api/league/overview', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireAuthenticated(ctx.principal);
  const leagueId = requireLeagueId(ctx);

  const refresh = c.req.query('refresh') === '1';
  const league = await ctx.repositories.leagues.find(leagueId);
  const link = await currentLink(ctx);

  if (!league) throw new AppError('not_found', { publicMessage: 'League record missing.' });

  if (!link) {
    // Not an error: a freshly bootstrapped portal legitimately has no link yet.
    return c.json({
      league: { leagueId, name: league.name, currentSeasonYear: league.currentSeasonYear ?? null },
      linked: false,
      yahoo: null,
    });
  }

  const userId = principal.userId as InternalId;

  if (refresh) {
    await ctx.yahoo.invalidateLeague(link.yahooLeagueKey, userId);
  }

  const [metadata, teams] = await Promise.all([
    ctx.yahoo.getLeagueMetadata(userId, link.yahooLeagueKey, { refresh }),
    ctx.yahoo.getLeagueTeams(userId, link.yahooLeagueKey, { refresh }),
  ]);

  const members = await ctx.repositories.leagues.listMembers(leagueId, link.seasonYear);
  const memberByTeamKey = new Map(
    members.filter((member) => member.yahooTeamKey).map((member) => [member.yahooTeamKey, member]),
  );

  return c.json({
    league: { leagueId, name: league.name, currentSeasonYear: league.currentSeasonYear ?? null },
    linked: true,
    yahoo: {
      seasonYear: link.seasonYear,
      yahooLeagueKey: link.yahooLeagueKey,
      name: metadata.name,
      season: metadata.season ?? null,
      currentWeek: metadata.currentWeek ?? null,
      startWeek: metadata.startWeek ?? null,
      endWeek: metadata.endWeek ?? null,
      playoffStartWeek: metadata.playoffStartWeek ?? null,
      numPlayoffTeams: metadata.numPlayoffTeams ?? null,
      scoringType: metadata.scoringType ?? null,
      teamCount: metadata.teamCount ?? null,
      draftStatus: metadata.draftStatus ?? null,
      teams: teams.map((team) => ({
        yahooTeamKey: team.teamKey,
        name: team.name,
        logoUrl: team.logoUrl ?? null,
        managers: team.managers.map((manager) => ({
          nickname: manager.nickname,
          isYahooCommissioner: manager.isCommissioner ?? false,
          isYou: manager.isCurrentLogin ?? false,
        })),
        // Whether this Yahoo team has been mapped to a Dinkel member yet.
        leagueMemberId: memberByTeamKey.get(team.teamKey)?.leagueMemberId ?? null,
      })),
    },
    // Yahoo caps how long its data may be retained, so the portal shows when the
    // view was assembled rather than implying it is a stored snapshot.
    fetchedAt: new Date().toISOString(),
  });
});

/** Maps a Yahoo team to a Dinkel league member, so history survives the link. */
yahooRoutes.post('/api/league/members', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);

  const body = await parseJson(
    c,
    z.object({
      seasonYear: seasonYearSchema,
      yahooTeamKey: z.string().min(1).max(64).optional(),
      userId: z.string().length(26).optional(),
      legacyManagerName: z.string().min(1).max(80).optional(),
      leagueMemberId: z.string().length(26).optional(),
    }),
  );

  if (!body.userId && !body.legacyManagerName) {
    throw new AppError('validation_failed', {
      publicMessage: 'Provide either a portal user or a legacy manager name.',
    });
  }

  const members = await ctx.repositories.leagues.listMembers(leagueId, body.seasonYear);
  const existing = body.leagueMemberId
    ? members.find((member) => member.leagueMemberId === body.leagueMemberId)
    : undefined;

  // One Yahoo team maps to at most one member per season.
  if (body.yahooTeamKey) {
    const clash = members.find(
      (member) =>
        member.yahooTeamKey === body.yahooTeamKey &&
        member.leagueMemberId !== existing?.leagueMemberId,
    );
    if (clash) {
      throw new AppError('conflict', {
        publicMessage: 'That Yahoo team is already mapped to another member for this season.',
      });
    }
  }

  const actorId = principal.userId as InternalId;
  const leagueMemberId = existing?.leagueMemberId ?? generateId();

  await ctx.repositories.leagues.saveMember(
    {
      entity: 'LeagueMember',
      leagueMemberId,
      leagueId,
      seasonYear: body.seasonYear,
      userId: (body.userId as InternalId | undefined) ?? existing?.userId ?? null,
      isActive: true,
      ...(body.legacyManagerName ? { legacyManagerName: body.legacyManagerName } : {}),
      ...(body.yahooTeamKey ? { yahooTeamKey: body.yahooTeamKey as never } : {}),
      ...(existing
        ? {
            createdAt: existing.createdAt,
            createdBy: existing.createdBy,
            updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, ''),
            updatedBy: actorId,
            version: existing.version + 1,
          }
        : created(actorId)),
    },
    existing?.version,
  );

  return c.json({ leagueMemberId }, existing ? 200 : 201);
});

yahooRoutes.get('/api/league/members', async (c) => {
  const ctx = c.get('ctx');
  requireAuthenticated(ctx.principal);
  const leagueId = requireLeagueId(ctx);

  const league = await ctx.repositories.leagues.find(leagueId);
  const seasonYear = Number(c.req.query('seasonYear') ?? league?.currentSeasonYear ?? 0);
  if (!seasonYear) return c.json({ members: [] });

  const members = await ctx.repositories.leagues.listMembers(leagueId, seasonYear);
  const users = await ctx.repositories.users.listByLeague(leagueId);
  const userById = new Map(users.map((user) => [user.userId, user]));

  return c.json({
    members: members.map((member) => ({
      leagueMemberId: member.leagueMemberId,
      seasonYear: member.seasonYear,
      userId: member.userId,
      // Dinkel's own name: the portal user's confirmed display name, or the
      // legacy name from the CSV import. Never a Yahoo nickname.
      displayName:
        (member.userId ? userById.get(member.userId)?.displayName : undefined) ??
        member.legacyManagerName ??
        '(unnamed manager)',
      yahooTeamKey: member.yahooTeamKey ?? null,
      isActive: member.isActive,
    })),
  });
});

/** Exposes the reviewed capability matrix, so the UI can explain what is blocked. */
yahooRoutes.get('/api/yahoo/capabilities', async (c) => {
  const ctx = c.get('ctx');
  requireAuthenticated(ctx.principal);

  const matrix = getCapabilityMatrix();

  return c.json({
    lastReviewedAt: matrix.lastReviewedAt,
    access: matrix.access,
    writeOperationsSupported: matrix.writeOperations.supported,
    commissionerActionsSupported: matrix.commissionerActions.supported,
    retention: matrix.retention,
    verifiedCapabilities: matrix.verifiedCapabilities,
    resources: matrix.resources.map((resource) => ({
      key: resource.key,
      feature: resource.feature,
      resource: resource.resource,
      method: resource.method,
      confidence: resource.confidence,
      testStatus: resource.testStatus,
      limitations: resource.limitations,
    })),
  });
});

/** The active Yahoo link for the league's current season, if any. */
export async function currentLink(ctx: {
  leagueId: InternalId | null;
  repositories: {
    leagues: {
      find: (id: InternalId) => Promise<{ currentSeasonYear?: number } | null>;
      findYahooLink: (
        id: InternalId,
        year: number,
      ) => Promise<{
        yahooLeagueKey: YahooLeagueKey;
        seasonYear: number;
        linkId: string;
        connectionUserId: InternalId;
      } | null>;
      listSeasons: (id: InternalId) => Promise<Array<{ seasonYear: number }>>;
    };
  };
}): Promise<{
  yahooLeagueKey: YahooLeagueKey;
  seasonYear: number;
  linkId: string;
  connectionUserId: InternalId;
} | null> {
  if (!ctx.leagueId) return null;

  const league = await ctx.repositories.leagues.find(ctx.leagueId);
  if (league?.currentSeasonYear) {
    const link = await ctx.repositories.leagues.findYahooLink(
      ctx.leagueId,
      league.currentSeasonYear,
    );
    if (link) return link;
  }

  // Fall back to the most recent linked season, so an unset currentSeasonYear
  // does not make a working link invisible.
  const seasons = await ctx.repositories.leagues.listSeasons(ctx.leagueId);
  for (const season of [...seasons].sort((a, b) => b.seasonYear - a.seasonYear)) {
    const link = await ctx.repositories.leagues.findYahooLink(ctx.leagueId, season.seasonYear);
    if (link) return link;
  }

  return null;
}
