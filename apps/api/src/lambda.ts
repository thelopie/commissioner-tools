import { Hono } from 'hono';
import { handle } from 'hono/aws-lambda';
import { createApp, loadConfig } from './app.js';
import { createLogger, describeError } from './lib/logger.js';

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

export const handler = handle(build());
