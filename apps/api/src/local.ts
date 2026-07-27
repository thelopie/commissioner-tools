import { serve } from '@hono/node-server';
import { EnvValidationError } from '@dinkel/shared';
import { createApp, loadConfig } from './app.js';
import { createLogger } from './lib/logger.js';

/**
 * Local development server.
 *
 * Plain HTTP on loopback. The frontend dev server terminates HTTPS (Yahoo requires
 * an HTTPS redirect URI) and proxies to this, so the browser only ever talks to
 * the HTTPS origin while this stays simple.
 */

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof EnvValidationError) {
    // A readable, actionable message rather than a stack trace: this is the first
    // thing a new contributor sees if their .env is incomplete.
    console.error('\nCannot start the API — the environment is not valid:\n');
    for (const issue of error.issues) console.error(`  • ${issue}`);
    console.error('\nCopy .env.example to .env and fill in the values.\n');
    process.exit(1);
  }
  throw error;
}

const logger = createLogger({ level: config.env.LOG_LEVEL, correlationId: 'local' });
const app = createApp({ config });

serve({ fetch: app.fetch, port: config.env.API_PORT, hostname: '127.0.0.1' }, (info) => {
  logger.info('API listening', {
    url: `http://127.0.0.1:${info.port}`,
    yahooMode: config.env.YAHOO_MODE,
    dynamodbEndpoint: config.env.DYNAMODB_ENDPOINT || '(aws)',
    verifiedYahooCapabilities: config.capabilities.verifiedCapabilities.length,
  });

  if (config.env.YAHOO_MODE === 'mock') {
    logger.info('running against the mock Yahoo server — no real Yahoo credentials needed', {
      mockBaseUrl: config.env.YAHOO_MOCK_BASE_URL,
    });
  }

  if (config.capabilities.verifiedCapabilities.length === 0) {
    // Worth saying loudly at startup: it explains why every challenge reports
    // blocked, which would otherwise look like a bug.
    logger.warn('no Yahoo capability is verified yet, so every challenge reports blocked', {
      hint: 'Run `npm run verify:yahoo` once Yahoo grants API access.',
    });
  }
});
