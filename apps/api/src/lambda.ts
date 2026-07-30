import { Hono } from 'hono';
import { handle } from 'hono/aws-lambda';
import { createApp, loadConfig } from './app.js';
import { createLogger, describeError } from './lib/logger.js';
import { runScheduledJob } from './jobs/runner.js';
import { isScheduledJobEvent } from './jobs/types.js';

/**
 * Lambda entry point.
 *
 * Configuration is loaded and validated at module scope, so a misconfigured
 * deployment fails during initialization — visible immediately in CloudWatch —
 * rather than as a confusing 500 on whichever request first needs a missing value.
 *
 * The misconfiguration path is a Hono app rather than a hand-built response, so
 * the adapter owns the response shape in both cases and the two cannot drift.
 */

function misconfiguredApp(): Hono {
  const app = new Hono();

  app.all('*', (c) => {
    // Deliberately terse: an environment validation message names variables, and
    // the detail is already in the initialization log.
    c.header('Cache-Control', 'no-store');
    return c.json(
      { error: { code: 'internal_error', message: 'The service is misconfigured.' } },
      500,
    );
  });

  return app;
}

function build(): Hono {
  try {
    const config = loadConfig();

    createLogger({ level: config.env.LOG_LEVEL, correlationId: 'init' }).info('API initialized', {
      yahooMode: config.env.YAHOO_MODE,
      environment: config.env.NODE_ENV,
      capabilityMatrixReviewedAt: config.capabilities.lastReviewedAt,
      verifiedYahooCapabilities: config.capabilities.verifiedCapabilities.length,
    });

    return createApp({ config }) as unknown as Hono;
  } catch (error) {
    createLogger({ correlationId: 'init' }).error('API failed to initialize', describeError(error));
    return misconfiguredApp();
  }
}

const httpHandler = handle(build());

/**
 * The Lambda handler, for HTTP requests and for scheduled jobs.
 *
 * Six EventBridge rules invoke this same function with `{source: 'scheduled-job'}`.
 * Before this branch existed they were dispatched straight into the HTTP adapter,
 * which has no idea what to do with them — so every scheduled rule would have failed
 * from the moment the stack was deployed, weekly, silently, forever.
 *
 * A job's failure is rethrown by the runner and left to propagate here, because that
 * is what routes the invocation to the dead-letter queue.
 */
export const handler = async (event: unknown, lambdaContext?: unknown): Promise<unknown> => {
  if (isScheduledJobEvent(event)) {
    return runScheduledJob(event);
  }

  return (httpHandler as (event: unknown, context?: unknown) => Promise<unknown>)(
    event,
    lambdaContext,
  );
};
