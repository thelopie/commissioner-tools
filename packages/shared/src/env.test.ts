import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadServerEnv, publicConfig } from './env.js';

const key = () => Buffer.alloc(32, 7).toString('base64');

const valid = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'development',
  YAHOO_CLIENT_ID: 'client-id',
  YAHOO_CLIENT_SECRET: 'client-secret',
  YAHOO_REDIRECT_URI: 'https://localhost:5173/auth/yahoo/callback',
  YAHOO_MODE: 'mock',
  APP_BASE_URL: 'https://localhost:5173',
  AWS_REGION: 'us-east-1',
  DYNAMODB_TABLE_NAME: 'dinkel-portal-dev',
  SESSION_SECRET: key(),
  TOKEN_ENCRYPTION_KEY: key(),
});

describe('loadServerEnv', () => {
  it('accepts a valid configuration and applies defaults', () => {
    const env = loadServerEnv(valid());
    expect(env.YAHOO_MODE).toBe('mock');
    expect(env.API_PORT).toBe(4300);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.ANTHROPIC_MODEL).toBe('claude-sonnet-5');
  });

  it('reports every problem at once rather than one per restart', () => {
    let caught: unknown;
    try {
      loadServerEnv({ NODE_ENV: 'development' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EnvValidationError);
    const { issues } = caught as EnvValidationError;
    expect(issues.length).toBeGreaterThan(5);
    expect(issues.some((i) => i.startsWith('YAHOO_CLIENT_ID'))).toBe(true);
    expect(issues.some((i) => i.startsWith('SESSION_SECRET'))).toBe(true);
  });

  it('never echoes a secret value in an error message', () => {
    const secret = 'super-secret-do-not-log';
    let caught: EnvValidationError | undefined;
    try {
      loadServerEnv({ ...valid(), TOKEN_ENCRYPTION_KEY: secret });
    } catch (error) {
      caught = error as EnvValidationError;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).not.toContain(secret);
  });

  it('rejects an http redirect URI because Yahoo requires https', () => {
    expect(() =>
      loadServerEnv({
        ...valid(),
        YAHOO_REDIRECT_URI: 'http://localhost:5173/auth/yahoo/callback',
      }),
    ).toThrow(/HTTPS redirect URI/);
  });

  it('rejects a token key that does not decode to 32 bytes', () => {
    expect(() =>
      loadServerEnv({ ...valid(), TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/32 bytes/);
  });

  it('rejects placeholder credentials when running in live mode', () => {
    expect(() =>
      loadServerEnv({
        ...valid(),
        YAHOO_MODE: 'live',
        YAHOO_CLIENT_ID: 'replace-me',
      }),
    ).toThrow(/placeholder/);
  });

  it('allows placeholder credentials in mock mode', () => {
    expect(() =>
      loadServerEnv({
        ...valid(),
        YAHOO_CLIENT_ID: 'replace-me',
        YAHOO_CLIENT_SECRET: 'replace-me',
      }),
    ).not.toThrow();
  });

  it('requires https and a real DynamoDB endpoint in production', () => {
    expect(() =>
      loadServerEnv({ ...valid(), NODE_ENV: 'production', APP_BASE_URL: 'http://portal.example' }),
    ).toThrow(/must be HTTPS in production/);

    expect(() =>
      loadServerEnv({
        ...valid(),
        NODE_ENV: 'production',
        DYNAMODB_ENDPOINT: 'http://localhost:8000',
      }),
    ).toThrow(/regional endpoint/);
  });
});

describe('publicConfig', () => {
  it('exposes only non-secret fields', () => {
    const env = loadServerEnv({ ...valid(), ANTHROPIC_API_KEY: 'sk-ant-test' });
    const config = publicConfig(env);

    expect(config).toEqual({
      yahooMode: 'mock',
      appBaseUrl: 'https://localhost:5173',
      recapProseEnabled: true,
    });

    // The allowlist is the guarantee: assert no secret leaked in by name or value.
    const serialized = JSON.stringify(config);
    for (const secret of [env.SESSION_SECRET, env.TOKEN_ENCRYPTION_KEY, 'sk-ant-test']) {
      expect(serialized).not.toContain(secret);
    }
    expect(Object.keys(config)).not.toContain('YAHOO_CLIENT_SECRET');
  });

  it('reports prose generation disabled when no API key is configured', () => {
    expect(publicConfig(loadServerEnv(valid())).recapProseEnabled).toBe(false);
  });
});
