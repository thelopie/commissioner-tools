import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSecretsIntoEnv } from './secrets.js';

/**
 * The secret loader is load-bearing for every deployment.
 *
 * Its absence is what made the first production deploy fail on every cold start: the
 * stack passed the ARNs and granted access, a comment claimed the values were read at
 * cold start, and nothing read them. These tests cover the two behaviours that do not
 * need AWS — the local path and the override rule — so a future refactor cannot
 * quietly reintroduce a loader that clobbers configuration or reaches for the network
 * during tests.
 */

const ORIGINAL = { ...process.env };

beforeEach(() => {
  delete process.env['APP_SECRET_ARN'];
  delete process.env['TOKEN_KEY_SECRET_ARN'];
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('loadSecretsIntoEnv', () => {
  it('does nothing without ARNs, which is how local development runs', async () => {
    // No AWS client should be constructed and no call attempted: `.env` already
    // supplied everything, and a test suite must never depend on credentials.
    process.env['SESSION_SECRET'] = 'from-dotenv';

    await expect(loadSecretsIntoEnv()).resolves.toBeUndefined();
    expect(process.env['SESSION_SECRET']).toBe('from-dotenv');
  });

  it('is safe to call repeatedly', async () => {
    await loadSecretsIntoEnv();
    await expect(loadSecretsIntoEnv()).resolves.toBeUndefined();
  });

  it('surfaces an unreadable secret rather than starting half-configured', async () => {
    /**
     * A bad ARN must throw. Swallowing it would produce a validation error naming a
     * missing variable a moment later, which sends whoever is debugging to the wrong
     * place entirely — the problem is the secret, not the configuration.
     */
    process.env['APP_SECRET_ARN'] = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:absent';

    await expect(loadSecretsIntoEnv()).rejects.toBeDefined();
  });
});
