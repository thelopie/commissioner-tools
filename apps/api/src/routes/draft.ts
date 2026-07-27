import { Hono } from 'hono';
import {
  AppError,
  generateId,
  seasonYearSchema,
  type InternalId,
  type LLWSAssignment,
} from '@dinkel/shared';
import {
  assertAssignmentsUnique,
  assertCanSelect,
  availablePositions,
  computeSelectionOrder,
  drawAssignments,
  finalDraftOrder,
  nextTurn,
  verifyDraw,
  type SelectionState,
} from '@dinkel/draft-order';
import { z } from 'zod';
import type { AppEnv } from '../context.js';
import { requireLeagueId } from '../context.js';
import { requireAuthenticated, requireCommissioner } from '../lib/authorization.js';
import { generateRandomizationSeed } from '../lib/crypto.js';
import { created } from '../repositories.js';
import { parseJson } from './auth.js';

/**
 * The LLWS draft-order workflow.
 *
 * Nothing here writes to Yahoo. No documented Yahoo endpoint sets draft order, so
 * the workflow ends in a printable order the commissioner enters manually in
 * Yahoo's own interface.
 */

export const draftRoutes = new Hono<AppEnv>();

const isoNow = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, '');

// ---------------------------------------------------------------- LLWS field

draftRoutes.get('/api/llws/:seasonYear/teams', async (c) => {
  const ctx = c.get('ctx');
  requireAuthenticated(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));

  const teams = await ctx.repositories.llws.listTeams(leagueId, seasonYear);
  return c.json({ teams });
});

draftRoutes.post('/api/llws/:seasonYear/teams', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));

  const body = await parseJson(
    c,
    z.object({
      teams: z
        .array(
          z.object({
            name: z.string().min(1).max(160),
            region: z.string().max(80).optional(),
            bracket: z.enum(['united_states', 'international', 'unknown']).default('unknown'),
          }),
        )
        .min(1)
        .max(64),
    }),
  );

  const actorId = principal.userId as InternalId;
  const createdIds: InternalId[] = [];

  for (const team of body.teams) {
    const llwsTeamId = generateId();
    await ctx.repositories.llws.saveTeam({
      entity: 'LLWSTeam',
      llwsTeamId,
      leagueId,
      seasonYear,
      name: team.name,
      bracket: team.bracket,
      ...(team.region === undefined ? {} : { region: team.region }),
      ...created(actorId),
    });
    createdIds.push(llwsTeamId);
  }

  await ctx.repositories.audit.record({
    leagueId,
    action: 'llws.team_created',
    actorUserId: actorId,
    actorRole: principal.role,
    summary: `Entered ${createdIds.length} LLWS teams for ${seasonYear}.`,
    correlationId: ctx.correlationId,
    detail: { teamCount: createdIds.length },
  });

  return c.json({ llwsTeamIds: createdIds }, 201);
});

/** Records how far a team advanced. This is what drives selection order. */
draftRoutes.put('/api/llws/:seasonYear/teams/:llwsTeamId/finish', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));
  const llwsTeamId = c.req.param('llwsTeamId') as InternalId;

  const body = await parseJson(
    c,
    z.object({
      finishRank: z.number().int().min(1).max(64),
      finishLabel: z.string().max(120).optional(),
    }),
  );

  const team = await ctx.repositories.llws.findTeam(leagueId, seasonYear, llwsTeamId);
  if (!team) throw new AppError('not_found', { publicMessage: 'No such LLWS team.' });

  const actorId = principal.userId as InternalId;

  await ctx.repositories.llws.saveTeam(
    {
      ...team,
      finishRank: body.finishRank,
      ...(body.finishLabel === undefined ? {} : { finishLabel: body.finishLabel }),
      eliminatedAt: isoNow(),
      updatedAt: isoNow(),
      updatedBy: actorId,
      version: team.version + 1,
    },
    team.version,
  );

  await ctx.repositories.audit.record({
    leagueId,
    action: 'llws.finish_recorded',
    actorUserId: actorId,
    actorRole: principal.role,
    summary: `Recorded ${team.name} finishing ${body.finishRank}.`,
    correlationId: ctx.correlationId,
    targetEntity: 'LLWSTeam',
    targetId: llwsTeamId,
    detail: { finishRank: body.finishRank },
  });

  return c.json({ ok: true });
});

// ------------------------------------------------------------------ the draw

draftRoutes.get('/api/llws/:seasonYear/assignments', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireAuthenticated(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));

  const assignments = await ctx.repositories.llws.listAssignments(leagueId, seasonYear);

  // Unpublished assignments are commissioner-only: the draw is not league news
  // until it is published, and a leaked half-drawn field invites arguments.
  const published = assignments.filter((assignment) => assignment.publishedAt !== undefined);
  const visible = principal.role === 'commissioner' ? assignments : published;

  return c.json({
    assignments: visible,
    published: published.length > 0,
    // The seed is deliberately visible so anyone can audit the draw.
    seed: visible[0]?.randomizationSeed ?? null,
  });
});

/**
 * Draws LLWS team assignments.
 *
 * The seed is generated here and stored with every assignment, so the draw is
 * reproducible: any manager can re-run it and confirm nothing was swapped later.
 */
draftRoutes.post('/api/llws/:seasonYear/draw', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));

  const body = await parseJson(
    c,
    z.object({
      /** Supply a seed to reproduce a previous draw; omit to generate a fresh one. */
      seed: z.string().min(1).max(200).optional(),
      /** Required to redraw over an existing draw, so it cannot happen by accident. */
      replaceExisting: z.boolean().default(false),
    }),
  );

  const actorId = principal.userId as InternalId;

  const existing = await ctx.repositories.llws.listAssignments(leagueId, seasonYear);
  if (existing.length > 0) {
    if (!body.replaceExisting) {
      throw new AppError('conflict', {
        publicMessage:
          'Assignments already exist for this season. Redrawing replaces them — confirm explicitly.',
      });
    }
    if (existing.some((assignment) => assignment.publishedAt)) {
      // Redrawing after publication would change a manager's team after they were
      // told what it was.
      throw new AppError('conflict', {
        publicMessage:
          'These assignments have already been published. Redrawing after publication needs a ' +
          'commissioner override with a recorded reason.',
      });
    }
    await ctx.repositories.llws.clearDraw(leagueId, seasonYear);
  }

  const members = await ctx.repositories.leagues.listMembers(leagueId, seasonYear);
  const activeMembers = members.filter((member) => member.isActive);
  const teams = await ctx.repositories.llws.listTeams(leagueId, seasonYear);

  if (activeMembers.length === 0 || teams.length === 0) {
    throw new AppError('precondition_failed', {
      publicMessage: 'Add league members and the LLWS field before drawing assignments.',
    });
  }

  const seed = body.seed ?? generateRandomizationSeed(`llws-${seasonYear}`);
  const randomizationRunId = generateId();

  const draw = drawAssignments({
    leagueMemberIds: activeMembers.map((member) => member.leagueMemberId),
    llwsTeamIds: teams.map((team) => team.llwsTeamId),
    seed,
  });

  assertAssignmentsUnique(draw.assignments);

  const records: LLWSAssignment[] = draw.assignments.map((assignment) => ({
    entity: 'LLWSAssignment',
    assignmentId: generateId(),
    leagueId,
    seasonYear,
    leagueMemberId: assignment.leagueMemberId,
    llwsTeamId: assignment.llwsTeamId,
    randomizationSeed: seed,
    randomizationRunId,
    assignedAt: isoNow(),
    ...created(actorId),
  }));

  await ctx.repositories.llws.saveDraw(records);

  await ctx.repositories.audit.record({
    leagueId,
    action: 'llws.assignments_drawn',
    actorUserId: actorId,
    actorRole: principal.role,
    summary: `Drew ${records.length} LLWS assignments for ${seasonYear}.`,
    correlationId: ctx.correlationId,
    detail: {
      // The seed in the audit trail is the permanent record of how the draw ran.
      randomizationSeed: seed,
      randomizationRunId,
      assignmentCount: records.length,
      unassignedManagers: draw.unassignedLeagueMemberIds.length,
      unassignedTeams: draw.unassignedLlwsTeamIds.length,
    },
  });

  return c.json(
    {
      assignments: records.map((record) => ({
        leagueMemberId: record.leagueMemberId,
        llwsTeamId: record.llwsTeamId,
      })),
      seed,
      randomizationRunId,
      unassignedLeagueMemberIds: draw.unassignedLeagueMemberIds,
      unassignedLlwsTeamIds: draw.unassignedLlwsTeamIds,
      published: false,
      note: 'Not yet visible to managers. Publish when you are ready.',
    },
    201,
  );
});

/** Re-runs a recorded draw and confirms it reproduces. The audit in practice. */
draftRoutes.get('/api/llws/:seasonYear/verify-draw', async (c) => {
  const ctx = c.get('ctx');
  requireAuthenticated(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));

  const assignments = await ctx.repositories.llws.listAssignments(leagueId, seasonYear);
  if (assignments.length === 0) {
    return c.json({ verified: false, reason: 'No assignments recorded for this season.' });
  }

  const seed = assignments[0]!.randomizationSeed;
  const members = await ctx.repositories.leagues.listMembers(leagueId, seasonYear);
  const teams = await ctx.repositories.llws.listTeams(leagueId, seasonYear);

  const verification = verifyDraw(
    assignments.map((assignment) => ({
      leagueMemberId: assignment.leagueMemberId,
      llwsTeamId: assignment.llwsTeamId,
    })),
    {
      leagueMemberIds: members
        .filter((member) => member.isActive)
        .map((member) => member.leagueMemberId),
      llwsTeamIds: teams.map((team) => team.llwsTeamId),
      seed,
    },
  );

  return c.json({
    verified: verification.reproduces,
    seed,
    mismatches: verification.mismatches,
    note: verification.reproduces
      ? 'The recorded assignments reproduce exactly from the stored seed.'
      : 'The recorded assignments do NOT match the stored seed — they were changed after the draw.',
  });
});

draftRoutes.post('/api/llws/:seasonYear/publish', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));

  const assignments = await ctx.repositories.llws.listAssignments(leagueId, seasonYear);
  if (assignments.length === 0) {
    throw new AppError('precondition_failed', {
      publicMessage: 'Draw assignments before publishing.',
    });
  }

  const actorId = principal.userId as InternalId;
  const publishedAt = isoNow();

  for (const assignment of assignments) {
    if (assignment.publishedAt) continue;
    await ctx.repositories.llws.saveAssignment(
      {
        ...assignment,
        publishedAt,
        updatedAt: publishedAt,
        updatedBy: actorId,
        version: assignment.version + 1,
      },
      assignment.version,
    );
  }

  await ctx.repositories.audit.record({
    leagueId,
    action: 'llws.assignments_published',
    actorUserId: actorId,
    actorRole: principal.role,
    summary: `Published LLWS assignments for ${seasonYear}.`,
    correlationId: ctx.correlationId,
  });

  return c.json({ ok: true, publishedAt });
});

// ------------------------------------------------------------ selection order

/**
 * Computes selection order from LLWS finishes.
 *
 * Selection order is who CHOOSES first, not who drafts first — the manager whose
 * team won the LLWS picks first, and may well pick slot six.
 */
draftRoutes.post('/api/draft/:seasonYear/selection-order', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));

  const body = await parseJson(
    c,
    z.object({
      tieBreakers: z
        .array(
          z.enum([
            'worse_prior_season_finish',
            'better_prior_season_finish',
            'seeded_random',
            'commissioner_decides',
          ]),
        )
        .default(['worse_prior_season_finish', 'seeded_random']),
      seed: z.string().min(1).max(200).optional(),
    }),
  );

  const actorId = principal.userId as InternalId;

  const assignments = await ctx.repositories.llws.listAssignments(leagueId, seasonYear);
  const teams = await ctx.repositories.llws.listTeams(leagueId, seasonYear);
  const teamById = new Map(teams.map((team) => [team.llwsTeamId, team]));

  // Prior-season finish comes from Dinkel's own record, not Yahoo standings,
  // which cannot be retained past 24 hours.
  const priorSeason = await ctx.repositories.leagues.findSeason(leagueId, seasonYear - 1);
  const priorFinish = new Map(
    (priorSeason?.finalFinishOrder ?? []).map((memberId, index) => [memberId, index + 1]),
  );

  const seed =
    body.seed ??
    (body.tieBreakers.includes('seeded_random')
      ? generateRandomizationSeed(`draft-order-${seasonYear}`)
      : undefined);

  const computed = computeSelectionOrder(
    assignments.map((assignment) => {
      const team = teamById.get(assignment.llwsTeamId);
      return {
        leagueMemberId: assignment.leagueMemberId,
        llwsTeamId: assignment.llwsTeamId,
        ...(team?.finishRank === undefined ? {} : { llwsFinishRank: team.finishRank }),
        ...(priorFinish.has(assignment.leagueMemberId)
          ? { priorSeasonFinish: priorFinish.get(assignment.leagueMemberId)! }
          : {}),
      };
    }),
    body.tieBreakers,
    seed,
  );

  for (const entry of computed.order) {
    const existing = await ctx.repositories.llws.findSelection(
      leagueId,
      seasonYear,
      entry.leagueMemberId,
    );

    // A locked pick is never re-derived: recomputing order must not move a slot
    // somebody already chose.
    if (existing && (existing.status === 'locked' || existing.status === 'commissioner_assigned')) {
      continue;
    }

    await ctx.repositories.llws.saveSelection(
      {
        entity: 'DraftPositionSelection',
        selectionId: existing?.selectionId ?? generateId(),
        leagueId,
        seasonYear,
        leagueMemberId: entry.leagueMemberId,
        selectionOrder: entry.selectionOrder,
        chosenDraftPosition: null,
        status: entry.selectionOrder === 1 ? 'open' : 'waiting',
        ...(entry.selectionOrder === 1 ? { openedAt: isoNow() } : {}),
        remindersSent: existing?.remindersSent ?? 0,
        derivedFrom: {
          ...(entry.llwsTeamId ? { llwsTeamId: entry.llwsTeamId } : {}),
          ...(entry.llwsFinishRank === undefined ? {} : { llwsFinishRank: entry.llwsFinishRank }),
          ...(entry.appliedTieBreaker ? { appliedTieBreaker: entry.appliedTieBreaker } : {}),
          explanation: entry.explanation,
        },
        ...(existing
          ? {
              createdAt: existing.createdAt,
              createdBy: existing.createdBy,
              updatedAt: isoNow(),
              updatedBy: actorId,
              version: existing.version + 1,
            }
          : created(actorId)),
      },
      existing?.version,
    );
  }

  await ctx.repositories.audit.record({
    leagueId,
    action: 'draft_order.calculated',
    actorUserId: actorId,
    actorRole: principal.role,
    summary: `Computed selection order for ${seasonYear}: ${computed.order.length} placed, ${computed.unplaced.length} unplaced.`,
    correlationId: ctx.correlationId,
    detail: {
      ...(seed ? { randomizationSeed: seed } : {}),
      placed: computed.order.length,
      unplaced: computed.unplaced.length,
    },
  });

  return c.json({
    order: computed.order,
    unplaced: computed.unplaced,
    ...(seed ? { seed } : {}),
  });
});

draftRoutes.get('/api/draft/:seasonYear/status', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireAuthenticated(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));

  const selections = await ctx.repositories.llws.listSelections(leagueId, seasonYear);
  const season = await ctx.repositories.leagues.findSeason(leagueId, seasonYear);
  const totalPositions = season?.teamCount ?? selections.length;

  const states: SelectionState[] = selections.map((selection) => ({
    leagueMemberId: selection.leagueMemberId,
    selectionOrder: selection.selectionOrder,
    chosenDraftPosition: selection.chosenDraftPosition,
    status: selection.status,
  }));

  const current = nextTurn(states);
  const final = finalDraftOrder(states, totalPositions);

  const members = await ctx.repositories.leagues.listMembers(leagueId, seasonYear);
  const users = await ctx.repositories.users.listByLeague(leagueId);
  const userById = new Map(users.map((user) => [user.userId, user]));
  const nameOf = (memberId: string): string => {
    const member = members.find((candidate) => candidate.leagueMemberId === memberId);
    if (!member) return '(unknown manager)';
    return (
      (member.userId ? userById.get(member.userId)?.displayName : undefined) ??
      member.legacyManagerName ??
      '(unnamed manager)'
    );
  };

  return c.json({
    selections: selections.map((selection) => ({
      leagueMemberId: selection.leagueMemberId,
      displayName: nameOf(selection.leagueMemberId),
      selectionOrder: selection.selectionOrder,
      chosenDraftPosition: selection.chosenDraftPosition,
      status: selection.status,
      remindersSent: selection.remindersSent,
      derivedFrom: selection.derivedFrom,
    })),
    availablePositions: availablePositions(states, totalPositions),
    currentTurn: current
      ? {
          leagueMemberId: current.leagueMemberId,
          displayName: nameOf(current.leagueMemberId),
          isYou: isOwn(ctx, principal.userId, members, current.leagueMemberId),
        }
      : null,
    finalOrder: final.order.map((entry) => ({
      draftPosition: entry.draftPosition,
      leagueMemberId: entry.leagueMemberId,
      displayName: entry.leagueMemberId ? nameOf(entry.leagueMemberId) : null,
    })),
    complete: final.complete,
    missingPositions: final.missingPositions,
    // Yahoo documents no endpoint for setting draft order, so the final step is
    // always manual entry in Yahoo's own interface.
    yahooWriteSupported: false,
    note: 'Enter this order manually in Yahoo — no Yahoo API endpoint sets draft order.',
  });
});

/** A manager takes their draft slot. Locked on write, with a slot claim. */
draftRoutes.post('/api/draft/:seasonYear/select', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireAuthenticated(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));

  const body = await parseJson(
    c,
    z.object({
      draftPosition: z.number().int().min(1).max(32),
      /** A commissioner may pick on someone's behalf. */
      leagueMemberId: z.string().length(26).optional(),
    }),
  );

  const members = await ctx.repositories.leagues.listMembers(leagueId, seasonYear);
  const own = members.find((member) => member.userId === principal.userId);

  const targetMemberId = body.leagueMemberId
    ? ((): InternalId => {
        // Picking for someone else is a commissioner action.
        requireCommissioner(ctx.principal);
        return body.leagueMemberId as InternalId;
      })()
    : own?.leagueMemberId;

  if (!targetMemberId) {
    throw new AppError('not_found', {
      publicMessage: 'You are not mapped to a league member for this season.',
    });
  }

  const selections = await ctx.repositories.llws.listSelections(leagueId, seasonYear);
  const season = await ctx.repositories.leagues.findSeason(leagueId, seasonYear);
  const totalPositions = season?.teamCount ?? selections.length;

  const states: SelectionState[] = selections.map((selection) => ({
    leagueMemberId: selection.leagueMemberId,
    selectionOrder: selection.selectionOrder,
    chosenDraftPosition: selection.chosenDraftPosition,
    status: selection.status,
  }));

  const actingForSelf = body.leagueMemberId === undefined;
  if (actingForSelf) {
    assertCanSelect(states, targetMemberId, body.draftPosition, totalPositions);
  } else if (!availablePositions(states, totalPositions).includes(body.draftPosition)) {
    // A commissioner may pick out of turn but still cannot double-book a slot.
    throw new AppError('draft_position_taken', {
      publicMessage: `Draft slot ${body.draftPosition} is already taken.`,
    });
  }

  const selection = await ctx.repositories.llws.findSelection(leagueId, seasonYear, targetMemberId);
  if (!selection) throw new AppError('not_found', { publicMessage: 'No selection turn found.' });

  const actorId = principal.userId as InternalId;

  // Transactional: the slot claim is what makes two simultaneous picks of the
  // same slot impossible, not merely unlikely.
  await ctx.repositories.llws.lockSelection(
    {
      ...selection,
      chosenDraftPosition: body.draftPosition,
      status: actingForSelf ? 'locked' : 'commissioner_assigned',
      selectedAt: isoNow(),
      lockedAt: isoNow(),
      updatedAt: isoNow(),
      updatedBy: actorId,
      version: selection.version + 1,
    },
    body.draftPosition,
  );

  // Open the next turn so the queue advances without a separate request.
  const remaining = states
    .filter((state) => state.leagueMemberId !== targetMemberId)
    .filter((state) => state.status === 'waiting')
    .sort((a, b) => a.selectionOrder - b.selectionOrder);

  const next = remaining[0];
  if (next) {
    const nextSelection = await ctx.repositories.llws.findSelection(
      leagueId,
      seasonYear,
      next.leagueMemberId,
    );
    if (nextSelection && nextSelection.status === 'waiting') {
      await ctx.repositories.llws.saveSelection(
        {
          ...nextSelection,
          status: 'open',
          openedAt: isoNow(),
          updatedAt: isoNow(),
          updatedBy: actorId,
          version: nextSelection.version + 1,
        },
        nextSelection.version,
      );

      await ctx.repositories.audit.record({
        leagueId,
        action: 'draft_order.turn_opened',
        actorUserId: null,
        actorRole: 'system',
        summary: `Opened draft selection turn ${nextSelection.selectionOrder}.`,
        correlationId: ctx.correlationId,
      });
    }
  }

  await ctx.repositories.audit.record({
    leagueId,
    action: 'draft_order.selection_locked',
    actorUserId: actorId,
    actorRole: principal.role,
    summary: `Locked draft slot ${body.draftPosition} for member ${targetMemberId}.`,
    correlationId: ctx.correlationId,
    targetEntity: 'DraftPositionSelection',
    targetId: selection.selectionId,
    detail: { draftPosition: body.draftPosition, onBehalfOf: !actingForSelf },
  });

  return c.json({ ok: true, draftPosition: body.draftPosition, locked: true });
});

/** Records that a reminder is due. This version does not send messages. */
draftRoutes.post('/api/draft/:seasonYear/remind', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const seasonYear = seasonYearSchema.parse(Number(c.req.param('seasonYear')));

  const selections = await ctx.repositories.llws.listSelections(leagueId, seasonYear);
  const states: SelectionState[] = selections.map((selection) => ({
    leagueMemberId: selection.leagueMemberId,
    selectionOrder: selection.selectionOrder,
    chosenDraftPosition: selection.chosenDraftPosition,
    status: selection.status,
  }));

  const current = nextTurn(states);
  if (!current) return c.json({ reminded: false, reason: 'No turn is currently open.' });

  const count = await ctx.repositories.llws.incrementReminders(
    leagueId,
    seasonYear,
    current.leagueMemberId,
  );

  await ctx.repositories.audit.record({
    leagueId,
    action: 'draft_order.reminder_recorded',
    actorUserId: principal.userId as InternalId,
    actorRole: principal.role,
    summary: `Recorded reminder ${count} for the open draft turn.`,
    correlationId: ctx.correlationId,
    detail: { remindersSent: count },
  });

  return c.json({
    reminded: true,
    remindersSent: count,
    delivered: false,
    // Honest about what happened: the portal recorded the reminder, it did not
    // send anything. Message delivery is deferred deliberately.
    note: 'Recorded only — this version sends no email or SMS. Contact them yourself.',
  });
});

function isOwn(
  ctx: unknown,
  userId: string,
  members: ReadonlyArray<{ leagueMemberId: InternalId; userId: InternalId | null }>,
  memberId: InternalId,
): boolean {
  void ctx;
  return members.some((member) => member.leagueMemberId === memberId && member.userId === userId);
}
