import type { InternalId } from '@dinkel/shared';
import type { AppConfig } from '../config.js';
import type { Logger } from '../lib/logger.js';
import type { Table } from '../lib/table.js';
import type { Repositories } from '../repositories.js';
import type { YahooService } from '../services/yahoo-service.js';

/**
 * The six scheduled jobs, named exactly as the CDK EventBridge rules name them.
 *
 * The list is duplicated between here and `infrastructure`, which is unavoidable —
 * they are separate deployment units — so a test asserts the two agree. A rule
 * pointing at a job that does not exist would fail silently once a week.
 */
export const JOB_NAMES = [
  'calculate-weekly-challenges',
  'recalculate-after-stat-corrections',
  'draft-weekly-recap',
  'dues-reminders',
  'draft-order-reminders',
  'oauth-health-check',
] as const;

export type JobName = (typeof JOB_NAMES)[number];

export function isJobName(value: unknown): value is JobName {
  return typeof value === 'string' && (JOB_NAMES as readonly string[]).includes(value);
}

/** The event shape EventBridge sends, per the rule's `RuleTargetInput`. */
export interface ScheduledJobEvent {
  source: 'scheduled-job';
  job: string;
  scheduledAt?: string;
}

export function isScheduledJobEvent(event: unknown): event is ScheduledJobEvent {
  if (typeof event !== 'object' || event === null) return false;
  const candidate = event as Record<string, unknown>;
  return candidate['source'] === 'scheduled-job' && typeof candidate['job'] === 'string';
}

/**
 * What a job is given.
 *
 * Deliberately the same repositories and services the HTTP routes use, so a job
 * cannot drift into its own parallel implementation of a rule that already exists.
 */
export interface JobContext {
  config: AppConfig;
  table: Table;
  repositories: Repositories;
  yahoo: YahooService;
  logger: Logger;
  correlationId: string;
  /** When the schedule fired. Passed in rather than read from the clock. */
  scheduledAt: string;
  /** The league this run is for. Every job is league-scoped. */
  leagueId: InternalId;
}

/**
 * What a job reports.
 *
 * `summary` is written to the execution record and the log, so a person reading
 * CloudWatch a month later can tell what happened without re-deriving it.
 */
export interface JobResult {
  summary: string;
  /** Structured detail for the execution record. Never Yahoo content. */
  detail?: Record<string, unknown>;
  /** Set when the job deliberately did nothing, e.g. out of season. */
  skipped?: boolean;
}

export type JobHandler = (ctx: JobContext) => Promise<JobResult>;
