import { AppError, generateId, keys, SYSTEM_ACTOR_ID, type InternalId } from '@dinkel/shared';
import { createLogger, describeError, type Logger } from '../lib/logger.js';
import { Table } from '../lib/table.js';
import { createRepositories, type Repositories } from '../repositories.js';
import { YahooService } from '../services/yahoo-service.js';
import { loadConfig } from '../app.js';
import type { AppConfig } from '../config.js';
import { JOB_HANDLERS } from './handlers.js';
import { isJobName, type JobName, type JobResult, type ScheduledJobEvent } from './types.js';

/**
 * Runs one scheduled job.
 *
 * Three properties matter more than the jobs themselves:
 *
 * - **Idempotent.** EventBridge guarantees at-least-once delivery, so the same
 *   schedule can fire twice. Each run claims a key derived from the job and the
 *   period it covers; a duplicate claim is detected and the run exits without
 *   repeating the work.
 * - **Observable.** Every run writes an execution record and a structured log line
 *   carrying the same correlation ID, so one run is traceable end to end.
 * - **Retry-safe.** A failure is recorded and then rethrown. Swallowing it would
 *   leave the Lambda reporting success, and nothing would reach the dead-letter
 *   queue that exists precisely to catch this.
 */

/** Widened so the runner can be tested without an AWS client. */
export interface RunJobOptions {
  config?: AppConfig;
  table?: Table;
  repositories?: Repositories;
  yahoo?: YahooService;
  logger?: Logger;
  /** Injected in tests; production reads the clock. */
  now?: () => Date;
}

const isoNow = (now: Date): string => now.toISOString().replace(/\.\d{3}Z$/, '');

/** A one-line description for the execution record and the task. */
function errorSummary(described: Record<string, unknown>): string {
  const message = described['message'];
  return typeof message === 'string' && message.length > 0 ? message : 'Job failed.';
}

/**
 * The window a run covers, used as the idempotency key.
 *
 * Daily and weekly jobs collapse to the calendar day, which is the right grain:
 * two firings of Tuesday's challenge calculation are the same run, while next
 * Tuesday's is not. The six-hourly health check uses the hour block instead, so it
 * genuinely runs four times a day.
 */
export function executionKey(job: JobName, scheduledAt: string): string {
  const when = new Date(scheduledAt);
  const day = Number.isNaN(when.getTime())
    ? scheduledAt.slice(0, 10)
    : when.toISOString().slice(0, 10);

  if (job === 'oauth-health-check') {
    const hour = Number.isNaN(when.getTime()) ? '00' : when.toISOString().slice(11, 13);
    // Four blocks a day, matching the six-hourly schedule.
    const block = String(Math.floor(Number(hour) / 6) * 6).padStart(2, '0');
    return `${day}T${block}`;
  }

  return day;
}

export async function runScheduledJob(
  event: ScheduledJobEvent,
  options: RunJobOptions = {},
): Promise<JobResult> {
  const now = options.now ?? (() => new Date());
  const correlationId = generateId();

  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger({ level: config.env.LOG_LEVEL, correlationId });

  if (!isJobName(event.job)) {
    /**
     * An unknown job name means the infrastructure and the code disagree.
     * Thrown rather than logged, so it lands in the DLQ and somebody sees it —
     * a rule quietly doing nothing every week is the worst outcome here.
     */
    throw new AppError('internal_error', {
      publicMessage: `Unknown scheduled job "${event.job}".`,
      detail: { job: String(event.job) },
    });
  }

  const job: JobName = event.job;
  const scheduledAt = event.scheduledAt ?? isoNow(now());

  const table =
    options.table ??
    new Table({
      tableName: config.env.DYNAMODB_TABLE_NAME,
      region: config.env.AWS_REGION,
      ...(config.env.DYNAMODB_ENDPOINT ? { endpoint: config.env.DYNAMODB_ENDPOINT } : {}),
    });
  const repositories = options.repositories ?? createRepositories(table);
  const yahoo =
    options.yahoo ??
    new YahooService({ config, table, connections: repositories.connections, logger });

  const key = executionKey(job, scheduledAt);
  const jobLogger = logger.child({ job, executionKey: key });

  /**
   * Claims the run before doing any work.
   *
   * A conditional write on the execution key: the second firing of the same period
   * loses the race and returns instead of repeating the work. Doing this first
   * means a duplicate cannot half-run.
   */
  const claimed = await claimExecution(table, job, key, {
    startedAt: isoNow(now()),
    correlationId,
    scheduledAt,
  });

  if (!claimed) {
    jobLogger.info('Scheduled job already ran for this period; skipping');
    return { summary: 'Already ran for this period.', skipped: true };
  }

  const leagueId = await resolveLeagueId(repositories);
  if (!leagueId) {
    // Not an error: a fresh install has no league yet, and the schedules are live
    // from the moment the stack deploys.
    jobLogger.info('No league configured yet; nothing for the job to do');
    await finishExecution(table, job, key, {
      status: 'skipped',
      summary: 'No league configured.',
      finishedAt: isoNow(now()),
    });
    return { summary: 'No league configured.', skipped: true };
  }

  const startedAtMs = now().getTime();
  jobLogger.info('Scheduled job started', { scheduledAt });

  try {
    const result = await JOB_HANDLERS[job]({
      config,
      table,
      repositories,
      yahoo,
      logger: jobLogger,
      correlationId,
      scheduledAt,
      leagueId,
    });

    const durationMs = now().getTime() - startedAtMs;

    await finishExecution(table, job, key, {
      status: result.skipped ? 'skipped' : 'succeeded',
      summary: result.summary,
      finishedAt: isoNow(now()),
      durationMs,
      ...(result.detail ? { detail: result.detail } : {}),
    });

    jobLogger.info('Scheduled job finished', { summary: result.summary, durationMs });
    return result;
  } catch (error) {
    const durationMs = now().getTime() - startedAtMs;
    const described = describeError(error);

    await finishExecution(table, job, key, {
      status: 'failed',
      summary: errorSummary(described),
      finishedAt: isoNow(now()),
      durationMs,
    });

    /**
     * Opens a task so a repeated failure is visible in the portal, not only in
     * CloudWatch. The idempotency key is the job and the period, so a job failing
     * every week opens one task per week rather than a pile of duplicates.
     */
    await repositories.ops
      .openSystemTask({
        entity: 'CommissionerTask',
        taskId: generateId(),
        leagueId,
        title: `Scheduled job failed: ${job}`,
        detail: errorSummary(described),
        category: 'other',
        priority: 'high',
        status: 'open',
        systemSource: 'scheduled_job',
        idempotencyKey: `job-failed:${job}:${key}`,
        createdAt: isoNow(now()),
        createdBy: SYSTEM_ACTOR_ID,
        updatedAt: isoNow(now()),
        updatedBy: SYSTEM_ACTOR_ID,
        version: 1,
      })
      .catch((taskError: unknown) => {
        // Never let bookkeeping mask the original failure.
        jobLogger.error('Could not open a task for the job failure', describeError(taskError));
      });

    jobLogger.error('Scheduled job failed', { ...described, durationMs });

    // Rethrown on purpose: this is what routes the invocation to the DLQ.
    throw error;
  }
}

/** Which league the jobs act on. The portal manages exactly one. */
async function resolveLeagueId(repositories: Repositories): Promise<InternalId | null> {
  const pointer = await repositories.leagues.findCurrentLeagueId();
  return pointer;
}

interface ExecutionStart {
  startedAt: string;
  correlationId: string;
  scheduledAt: string;
}

interface ExecutionFinish {
  status: 'succeeded' | 'failed' | 'skipped';
  summary: string;
  finishedAt: string;
  durationMs?: number;
  detail?: Record<string, unknown>;
}

/**
 * Claims a run, returning false when this period already ran.
 *
 * `attribute_not_exists` on the primary key is the whole mechanism: two concurrent
 * firings cannot both succeed, without needing a lock or a queue.
 */
async function claimExecution(
  table: Table,
  job: JobName,
  key: string,
  start: ExecutionStart,
): Promise<boolean> {
  try {
    await table.putNew({
      ...keys.jobExecution(job, key),
      entity: 'JobExecution',
      job,
      executionKey: key,
      status: 'running',
      ...start,
    });
    return true;
  } catch (error) {
    // `duplicate` is what putNew raises when the conditional write loses.
    if (error instanceof AppError && error.code === 'duplicate') return false;
    throw error;
  }
}

async function finishExecution(
  table: Table,
  job: JobName,
  key: string,
  finish: ExecutionFinish,
): Promise<void> {
  const existing = await table.get<Record<string, unknown>>(keys.jobExecution(job, key));

  await table.put({
    ...(existing ?? {}),
    ...keys.jobExecution(job, key),
    entity: 'JobExecution',
    job,
    executionKey: key,
    ...finish,
  });
}
