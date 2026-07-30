import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadServerEnv } from '@dinkel/shared';
import { setCapabilityMatrix, type CapabilityMatrix, type FetchLike } from '@dinkel/yahoo-client';
import type { AppConfig } from '../config.js';
import { InMemoryTable } from '../testing/in-memory-table.js';
import { createLogger } from '../lib/logger.js';
import { createApp } from '../app.js';
import { createRepositories } from '../repositories.js';
import { CSRF_COOKIE, CSRF_HEADER } from '../lib/cookies.js';
import { YahooService } from '../services/yahoo-service.js';
import { handleFantasyRequest, handleTokenRequest } from '../../../mock-yahoo/src/handlers.js';
import { executionKey, runScheduledJob } from './runner.js';
import { JOB_NAMES, isScheduledJobEvent } from './types.js';

/**
 * Scheduled job tests.
 *
 * The jobs themselves matter less than the runtime around them: EventBridge delivers
 * at least once, so a duplicate must not repeat work; a failure must reach the
 * dead-letter queue rather than being swallowed; and a rule pointing at a job name
 * the code does not implement would fail once a week, silently, forever.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');

const MATRIX: CapabilityMatrix = {
  lastReviewedAt: '2026-07-27',
  access: {
    selfService: false,
    approvalRequired: true,
    defaultPermission: 'read-only',
    applicationUrl: 'https://sports.yahoo.com/developer/access/',
  },
  writeOperations: { supported: false },
  commissionerActions: { supported: false },
  retention: { maxRetentionHours: 24, storableIndefinitely: ['yahoo_guid', 'token_value'] },
  resources: [],
  verifiedCapabilities: [],
};

function config(): AppConfig {
  const env = loadServerEnv({
    NODE_ENV: 'test',
    YAHOO_CLIENT_ID: 'test-client',
    YAHOO_CLIENT_SECRET: 'test-secret',
    YAHOO_REDIRECT_URI: 'https://localhost:5173/auth/yahoo/callback',
    YAHOO_MODE: 'mock',
    APP_BASE_URL: 'https://localhost:5173',
    AWS_REGION: 'us-east-1',
    DYNAMODB_TABLE_NAME: 'test',
    SESSION_SECRET: KEY,
    TOKEN_ENCRYPTION_KEY: KEY,
  });

  return {
    env,
    capabilities: MATRIX,
    yahooApiBaseUrl: 'http://mock.invalid/fantasy/v2',
    yahooOAuthBaseUrl: 'http://mock.invalid',
  };
}

const mockFetch: FetchLike = async (url, init) => {
  const parsed = new URL(url);
  const respond = (status: number, body: unknown) => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  });

  if (parsed.pathname === '/oauth2/get_token') {
    const result = handleTokenRequest(init.body ?? '');
    return respond(result.status, result.body);
  }
  if (parsed.pathname.startsWith('/fantasy/v2/')) {
    const result = handleFantasyRequest(parsed.pathname.slice('/fantasy/v2/'.length));
    return respond(result.status, result.body);
  }
  return respond(404, { error: 'no mock route' });
};

let table: InMemoryTable;

function options(overrides: { fetchImpl?: FetchLike } = {}) {
  const asTable = table.asTable();
  const repositories = createRepositories(asTable);
  const appConfig = config();
  const logger = createLogger({ correlationId: 'test', sink: () => {} });

  return {
    config: appConfig,
    table: asTable,
    repositories,
    yahoo: new YahooService({
      config: appConfig,
      table: asTable,
      connections: repositories.connections,
      logger,
      fetchImpl: overrides.fetchImpl ?? mockFetch,
    }),
    logger,
  };
}

beforeEach(() => {
  setCapabilityMatrix(MATRIX);
  table = new InMemoryTable();
});

describe('scheduled job dispatch', () => {
  it('recognises the event EventBridge actually sends', () => {
    // The shape comes from the CDK rule's RuleTargetInput. If this drifts, every
    // scheduled invocation falls through to the HTTP adapter and fails.
    expect(isScheduledJobEvent({ source: 'scheduled-job', job: 'dues-reminders' })).toBe(true);
    expect(isScheduledJobEvent({ source: 'aws.events' })).toBe(false);
    expect(isScheduledJobEvent({ requestContext: {}, rawPath: '/health' })).toBe(false);
    expect(isScheduledJobEvent(null)).toBe(false);
  });

  /**
   * The infrastructure and the code must name the same six jobs.
   *
   * A rule invoking a job the code does not implement would throw once a week and
   * only ever be visible in the dead-letter queue. Reading the CDK source is crude
   * but it is the only thing that couples the two deployment units.
   */
  it('implements exactly the jobs the CDK schedules', () => {
    const stack = readFileSync(
      new URL('../../../../infrastructure/src/portal-stack.ts', import.meta.url),
      'utf-8',
    );

    const scheduled = [...stack.matchAll(/job: '([a-z-]+)'/g)].map((match) => match[1]!);

    expect(scheduled.length).toBeGreaterThan(0);
    expect([...scheduled].sort()).toEqual([...JOB_NAMES].sort());
  });

  it('refuses an unknown job loudly rather than doing nothing', async () => {
    // Silence here would mean a misconfigured rule never gets noticed.
    await expect(
      runScheduledJob({ source: 'scheduled-job', job: 'not-a-job' }, options()),
    ).rejects.toThrow(/Unknown scheduled job/);
  });

  it('skips when no league exists yet', async () => {
    // The schedules are live from the moment the stack deploys, which is before
    // anybody has bootstrapped a league.
    const result = await runScheduledJob(
      { source: 'scheduled-job', job: 'dues-reminders', scheduledAt: '2026-09-07T13:00:00Z' },
      options(),
    );

    expect(result.skipped).toBe(true);
    expect(result.summary).toContain('No league');
  });
});

describe('scheduled job idempotency', () => {
  it('collapses two firings of the same period into one run', async () => {
    const event = {
      source: 'scheduled-job' as const,
      job: 'dues-reminders',
      scheduledAt: '2026-09-07T13:00:00Z',
    };

    const first = await runScheduledJob(event, options());
    const second = await runScheduledJob(event, options());

    // The second sees the claim and returns without repeating the work.
    expect(second.summary).toContain('Already ran');
    expect(second.skipped).toBe(true);
    expect(first.summary).not.toContain('Already ran');

    const executions = table.all().filter((item) => item['entity'] === 'JobExecution');
    expect(executions).toHaveLength(1);
  });

  it('treats the next day as a different run', async () => {
    const monday = {
      source: 'scheduled-job' as const,
      job: 'dues-reminders',
      scheduledAt: '2026-09-07T13:00:00Z',
    };
    const nextMonday = { ...monday, scheduledAt: '2026-09-14T13:00:00Z' };

    await runScheduledJob(monday, options());
    const later = await runScheduledJob(nextMonday, options());

    expect(later.summary).not.toContain('Already ran');
    expect(table.all().filter((item) => item['entity'] === 'JobExecution')).toHaveLength(2);
  });

  /**
   * The health check runs four times a day, so its key cannot be the day alone.
   */
  it('gives the six-hourly health check four keys a day', () => {
    const keys = ['02', '08', '14', '20'].map((hour) =>
      executionKey('oauth-health-check', `2026-09-07T${hour}:00:00Z`),
    );

    expect(new Set(keys).size).toBe(4);
    // A weekly job collapses to the day, so two firings an hour apart are one run.
    expect(executionKey('dues-reminders', '2026-09-07T13:00:00Z')).toBe(
      executionKey('dues-reminders', '2026-09-07T14:00:00Z'),
    );
  });
});

describe('scheduled job failure handling', () => {
  it('records the failure, opens a task, and rethrows for the dead-letter queue', async () => {
    await bootstrapLeague();

    /**
     * A table whose queries fail, standing in for DynamoDB being unavailable.
     *
     * Breaking the transport instead would not do it: with no verified capability the
     * challenge job short-circuits before it ever calls Yahoo — correct behaviour,
     * and a reminder that a test can pass for the wrong reason. Failing the store
     * exercises the runner's error path whichever job is running.
     */
    const base = table.asTable();
    const brokenTable = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
      query: async () => {
        throw new Error('DynamoDB unavailable');
      },
    });

    const repositories = createRepositories(brokenTable);

    await expect(
      runScheduledJob(
        {
          source: 'scheduled-job',
          job: 'dues-reminders',
          scheduledAt: '2026-09-07T13:00:00Z',
        },
        { ...options(), table: brokenTable, repositories },
      ),
      // Rethrown on purpose: swallowing it would report success to Lambda and nothing
      // would ever reach the DLQ.
    ).rejects.toThrow(/DynamoDB unavailable/);

    const execution = table.all().find((item) => item['entity'] === 'JobExecution');
    expect(execution?.['status']).toBe('failed');

    const task = table
      .all()
      .find(
        (item) =>
          item['entity'] === 'CommissionerTask' &&
          String(item['title']).includes('Scheduled job failed'),
      );

    // Visible in the portal, not only in CloudWatch.
    expect(task).toBeDefined();
    expect(task?.['priority']).toBe('high');
  });

  /**
   * A lapsed Yahoo grant is a known state, not an unexpected failure.
   *
   * It opens a task and returns. Sending it to the DLQ every six hours would bury
   * the failures that actually need investigating.
   */
  it('does not send a failing health check to the dead-letter queue', async () => {
    await bootstrapLeague();

    const brokenFetch: FetchLike = async () => {
      throw new Error('invalid_grant');
    };

    const result = await runScheduledJob(
      { source: 'scheduled-job', job: 'oauth-health-check', scheduledAt: '2026-09-08T08:00:00Z' },
      options({ fetchImpl: brokenFetch }),
    );

    expect(result.summary).toContain('unreachable');

    const task = table
      .all()
      .find(
        (item) =>
          item['entity'] === 'CommissionerTask' &&
          String(item['title']).includes('Reconnect Yahoo'),
      );
    expect(task?.['priority']).toBe('urgent');
  });
});

/**
 * Sets a league up the way production does: sign in, bootstrap, link Yahoo.
 *
 * Driven through the real HTTP app rather than by writing records directly. Jobs
 * resolve the league and its Yahoo link through the same helpers the routes use, so
 * hand-built fixtures would be testing a shape that production never produces.
 */
async function bootstrapLeague(): Promise<void> {
  const app = createApp({
    config: config(),
    table: table.asTable(),
    fetchImpl: mockFetch,
    logger: createLogger({ correlationId: 'setup', sink: () => {} }),
  });

  const start = await app.request('/auth/yahoo/start');
  const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
  const callback = await app.request(
    `/auth/yahoo/callback?code=mock-authorization-code&state=${encodeURIComponent(state)}`,
  );

  const jar: Record<string, string> = {};
  for (const header of callback.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const index = pair!.indexOf('=');
    jar[pair!.slice(0, index)] = decodeURIComponent(pair!.slice(index + 1));
  }

  const cookie = Object.entries(jar)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('; ');

  const headers = {
    'Content-Type': 'application/json',
    Cookie: cookie,
    [CSRF_HEADER]: jar[CSRF_COOKIE]!,
  };

  await app.request('/api/setup/bootstrap', {
    method: 'POST',
    headers,
    body: JSON.stringify({ leagueName: 'Test League' }),
  });

  await app.request('/api/yahoo/league-link', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      yahooLeagueKey: '999.l.100001',
      yahooGameKey: '999',
      seasonYear: 2026,
    }),
  });
}
