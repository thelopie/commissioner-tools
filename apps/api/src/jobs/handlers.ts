import { generateId, SYSTEM_ACTOR_ID } from '@dinkel/shared';
import { calculateWeek } from '../services/challenge-calculation.js';
import { currentLink } from '../routes/yahoo.js';
import { buildRecap } from './recap.js';
import type { JobContext, JobHandler, JobName, JobResult } from './types.js';

/**
 * The six scheduled jobs.
 *
 * Each one reuses the same repositories and services the HTTP routes use. None of
 * them decides anything a person has not already decided: they compute provisional
 * results, draft prose for review, and open tasks. Nothing is finalized, published,
 * or paid by a schedule.
 *
 * v1 sends no messages of any kind. "Reminder" here means a commissioner task
 * appears in the portal — which is honest, and avoids a commissioner believing an
 * email went out when none did.
 */

const isoNow = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, '');

/**
 * The Yahoo league link, resolved the same way the routes resolve it.
 *
 * `currentLink` takes a narrow structural shape rather than a request context, so a
 * job can reuse it instead of duplicating the season-resolution rules.
 */
async function linkFor(ctx: JobContext) {
  return currentLink({ leagueId: ctx.leagueId, repositories: ctx.repositories } as never);
}

/** The week a job should act on: the one Yahoo says is current, minus one. */
async function completedWeek(ctx: JobContext): Promise<number | null> {
  const link = await linkFor(ctx);
  if (!link) return null;

  const metadata = await ctx.yahoo.getLeagueMetadata(link.connectionUserId, link.yahooLeagueKey);
  const current = metadata.currentWeek ?? metadata.startWeek ?? 1;

  /**
   * The week just finished, not the one in progress.
   *
   * Running on Tuesday morning, Yahoo's "current week" has already advanced to the
   * upcoming one. Calculating that would produce a table of zeros.
   */
  const week = current - 1;
  return week >= (metadata.startWeek ?? 1) ? week : null;
}

/**
 * Runs the shared week calculation.
 *
 * The same function the HTTP route calls, so a schedule and a button cannot become
 * two implementations of the capability gate and the stat-correction guard. The
 * actor is the reserved system id: nobody clicked this.
 */
async function runCalculation(ctx: JobContext, week: number) {
  return calculateWeek(
    {
      repositories: ctx.repositories,
      yahoo: ctx.yahoo,
      correlationId: ctx.correlationId,
      leagueId: ctx.leagueId,
    },
    {
      leagueId: ctx.leagueId,
      seasonYear: await seasonOf(ctx),
      week,
      actorId: SYSTEM_ACTOR_ID,
      actorRole: 'system',
    },
  );
}

/**
 * Calculates the completed week's challenges.
 *
 * Everything it produces is provisional. A schedule must never finalize a result:
 * Yahoo issues stat corrections for days afterwards, and finalizing is the act that
 * makes a result payable.
 */
const calculateWeeklyChallenges: JobHandler = async (ctx): Promise<JobResult> => {
  const week = await completedWeek(ctx);
  if (week === null) {
    return { summary: 'No completed week to calculate yet.', skipped: true };
  }

  const outcome = await runCalculation(ctx, week);

  return {
    summary: `Calculated ${outcome.calculated.length} challenge(s) for week ${week}.`,
    detail: {
      week,
      calculated: outcome.calculated.length,
      conflicts: outcome.conflicts.length,
      blocked: outcome.blocked.length,
    },
  };
};

/**
 * Recalculates an earlier week once Yahoo has had time to correct stats.
 *
 * Runs two days after the first calculation, which is when most corrections have
 * landed. A change to a result whose payout has settled is refused by the engine and
 * raised as a task instead — the portal must never claim someone won money they were
 * never given.
 */
const recalculateAfterStatCorrections: JobHandler = async (ctx): Promise<JobResult> => {
  const week = await completedWeek(ctx);
  if (week === null) {
    return { summary: 'No completed week to recalculate.', skipped: true };
  }

  const outcome = await runCalculation(ctx, week);

  return {
    summary:
      outcome.conflicts.length > 0
        ? `Recalculated week ${week}; ${outcome.conflicts.length} result(s) need a decision.`
        : `Recalculated week ${week}; nothing changed.`,
    detail: {
      week,
      calculated: outcome.calculated.length,
      conflicts: outcome.conflicts.length,
      blocked: outcome.blocked.length,
    },
  };
};

/**
 * Drafts a recap for review.
 *
 * The fact pack is computed here, in code. Prose generation, when enabled, is given
 * only that fact pack — the model never computes a score, a ranking, or a winner.
 * The draft is never published: a commissioner reads it first.
 */
const draftWeeklyRecap: JobHandler = async (ctx): Promise<JobResult> => {
  const week = await completedWeek(ctx);
  if (week === null) {
    return { summary: 'No completed week to recap.', skipped: true };
  }

  const existing = await ctx.repositories.ops.findRecap(ctx.leagueId, await seasonOf(ctx), week);
  if (existing && existing.status !== 'draft') {
    // A commissioner has already reviewed or published this one; leave it alone.
    return { summary: `Week ${week} recap is already ${existing.status}.`, skipped: true };
  }

  const recap = await buildRecap(ctx, week, existing ?? null);

  return {
    summary: `Drafted the week ${week} recap with ${recap.facts.length} facts${
      recap.proseBody ? ' and model prose' : ''
    }. Awaiting review.`,
    detail: { week, factCount: recap.facts.length, hasProse: recap.proseBody !== null },
  };
};

/** Surfaces unpaid dues as a task. Sends nothing. */
const duesReminders: JobHandler = async (ctx): Promise<JobResult> => {
  const seasonYear = await seasonOf(ctx);
  const dues = await ctx.repositories.money.listDues(ctx.leagueId, seasonYear);

  const outstanding = dues.filter(
    (record) => record.status === 'unpaid' || record.status === 'partial',
  );

  if (outstanding.length === 0) {
    return { summary: 'Everyone has paid.', skipped: true };
  }

  const owedCents = outstanding.reduce(
    (total, record) => total + (record.amountOwed.amountCents - record.amountPaid.amountCents),
    0,
  );

  const opened = await ctx.repositories.ops.openSystemTask({
    entity: 'CommissionerTask',
    taskId: generateId(),
    leagueId: ctx.leagueId,
    seasonYear,
    title: `${outstanding.length} member(s) still owe dues`,
    detail:
      `$${(owedCents / 100).toFixed(2)} outstanding. The portal sends no messages — ` +
      `the dues page has the current ledger.`,
    category: 'dues',
    priority: 'normal',
    status: 'open',
    systemSource: 'dues_reminder',
    // One task per week, so a season of Mondays does not produce a wall of them.
    idempotencyKey: `dues-reminder:${seasonYear}:${ctx.scheduledAt.slice(0, 10)}`,
    createdAt: isoNow(),
    createdBy: SYSTEM_ACTOR_ID,
    updatedAt: isoNow(),
    updatedBy: SYSTEM_ACTOR_ID,
    version: 1,
  });

  return {
    summary: opened
      ? `Opened a task: ${outstanding.length} member(s) owe dues.`
      : 'Task already open for this period.',
    detail: { outstanding: outstanding.length, owedCents },
  };
};

/** Nudges whoever has an open draft-slot turn. Records a reminder; sends nothing. */
const draftOrderReminders: JobHandler = async (ctx): Promise<JobResult> => {
  const seasonYear = await seasonOf(ctx);
  const selections = await ctx.repositories.llws.listSelections(ctx.leagueId, seasonYear);

  const open = selections.find((selection) => selection.status === 'open');
  if (!open) {
    return { summary: 'Nobody has an open draft turn.', skipped: true };
  }

  const count = await ctx.repositories.llws.incrementReminders(
    ctx.leagueId,
    seasonYear,
    open.leagueMemberId,
  );

  const opened = await ctx.repositories.ops.openSystemTask({
    entity: 'CommissionerTask',
    taskId: generateId(),
    leagueId: ctx.leagueId,
    seasonYear,
    title: 'A draft slot is still unchosen',
    detail:
      `Selection turn ${open.selectionOrder} has been open and everyone behind it is waiting. ` +
      `Reminder ${count} recorded. The portal sends no messages, so tell them yourself — ` +
      `or pick on their behalf from the draft board.`,
    category: 'draft',
    priority: 'high',
    status: 'open',
    systemSource: 'draft_reminder',
    idempotencyKey: `draft-reminder:${seasonYear}:${open.leagueMemberId}:${ctx.scheduledAt.slice(0, 10)}`,
    createdAt: isoNow(),
    createdBy: SYSTEM_ACTOR_ID,
    updatedAt: isoNow(),
    updatedBy: SYSTEM_ACTOR_ID,
    version: 1,
  });

  return {
    summary: opened
      ? `Recorded reminder ${count} for the open draft turn.`
      : 'Already reminded for this turn today.',
    detail: { selectionOrder: open.selectionOrder, remindersSent: count },
  };
};

/**
 * Checks the Yahoo grant before a scheduled job needs it.
 *
 * A lapsed grant is the most common cause of every other job failing at once, and
 * it is silent until something tries to read. Catching it here turns a mystery into
 * a task with an obvious fix.
 */
const oauthHealthCheck: JobHandler = async (ctx): Promise<JobResult> => {
  const link = await linkFor(ctx);
  if (!link) {
    return { summary: 'No Yahoo league linked.', skipped: true };
  }

  try {
    /**
     * `refresh` is what makes this a health check.
     *
     * Reading through the cache would report healthy from data up to an hour old —
     * so a grant that lapsed five minutes ago would look fine, which is exactly the
     * window this job exists to catch. It must talk to Yahoo.
     */
    await ctx.yahoo.getLeagueMetadata(link.connectionUserId, link.yahooLeagueKey, {
      refresh: true,
    });
    return { summary: 'The Yahoo connection is healthy.' };
  } catch (error) {
    const code = error instanceof Error ? error.message : 'unknown';

    await ctx.repositories.ops.openSystemTask({
      entity: 'CommissionerTask',
      taskId: generateId(),
      leagueId: ctx.leagueId,
      title: 'Reconnect Yahoo',
      detail:
        `A health check could not read the league: ${code}. Until this is fixed the ` +
        `weekly challenge and recap jobs will fail too.`,
      category: 'yahoo_connection',
      priority: 'urgent',
      status: 'open',
      systemSource: 'oauth_health',
      // One task until it is resolved, not one every six hours.
      idempotencyKey: `oauth-health:${ctx.leagueId}`,
      createdAt: isoNow(),
      createdBy: SYSTEM_ACTOR_ID,
      updatedAt: isoNow(),
      updatedBy: SYSTEM_ACTOR_ID,
      version: 1,
    });

    /**
     * Deliberately NOT rethrown.
     *
     * A lapsed grant is a known state with a recorded task and an obvious remedy,
     * not an unexpected failure. Sending it to the DLQ every six hours would bury
     * the failures that do need investigating.
     */
    return { summary: `Yahoo is unreachable: ${code}. Opened a task.`, detail: { healthy: false } };
  }
};

/**
 * The season the jobs act on: the league's own current season.
 *
 * Not the calendar year. A job running in January is still working on the previous
 * autumn's season, and a `NODE_ENV` check — which is what this used to do — would
 * have made the tests pass while production silently drifted every new year.
 */
async function seasonOf(ctx: JobContext): Promise<number> {
  const league = await ctx.repositories.leagues.find(ctx.leagueId);
  return league?.currentSeasonYear ?? new Date(ctx.scheduledAt).getUTCFullYear();
}

export const JOB_HANDLERS: Record<JobName, JobHandler> = {
  'calculate-weekly-challenges': calculateWeeklyChallenges,
  'recalculate-after-stat-corrections': recalculateAfterStatCorrections,
  'draft-weekly-recap': draftWeeklyRecap,
  'dues-reminders': duesReminders,
  'draft-order-reminders': draftOrderReminders,
  'oauth-health-check': oauthHealthCheck,
};
