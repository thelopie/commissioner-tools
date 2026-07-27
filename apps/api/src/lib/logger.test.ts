import { describe, expect, it } from 'vitest';
import { createLogger, describeError, redact, REDACTED } from './logger.js';
import { encryptToken } from './crypto.js';

function capture(level?: 'error' | 'warn' | 'info' | 'debug') {
  const lines: string[] = [];
  const logger = createLogger({
    correlationId: 'corr-1',
    ...(level ? { level } : {}),
    sink: (line) => lines.push(line),
    now: () => '2026-07-26T12:00:00.000Z',
  });
  return { logger, lines, parsed: () => lines.map((line) => JSON.parse(line)) };
}

describe('redact', () => {
  it('redacts by key name, whatever the value', () => {
    const output = redact({
      accessToken: 'abc',
      refreshToken: 'def',
      clientSecret: 'ghi',
      sessionId: 'jkl',
      csrfToken: 'mno',
      authorization: 'pqr',
      cookie: 'stu',
      apiKey: 'vwx',
      tokenEncryptionKey: 'yz',
    }) as Record<string, string>;

    for (const value of Object.values(output)) {
      expect(value).toBe(REDACTED);
    }
  });

  it('redacts nested fields', () => {
    const output = redact({
      connection: { userId: 'u1', encryptedRefreshToken: 'secret' },
    }) as { connection: Record<string, string> };

    expect(output.connection.userId).toBe('u1');
    expect(output.connection.encryptedRefreshToken).toBe(REDACTED);
  });

  it('redacts by value shape, catching a secret logged under an innocent key', () => {
    // Call sites cannot be trusted to name every field carefully, so the
    // serializer also recognizes secret-looking values.
    const envelope = encryptToken('yahoo-refresh-token', Buffer.alloc(32, 1).toString('base64'));

    const output = redact({
      note: envelope,
      header: 'Bearer ya29.someAccessTokenValue',
      key: 'sk-ant-api03-example',
    }) as Record<string, string>;

    expect(output.note).toBe(REDACTED);
    expect(output.header).toBe(REDACTED);
    expect(output.key).toBe(REDACTED);
  });

  it('leaves ordinary operational fields readable', () => {
    const output = redact({
      leagueId: '01JABCDEF0123456789ABCDEFG',
      week: 3,
      attempts: 2,
      ok: true,
      reason: null,
    });

    expect(output).toEqual({
      leagueId: '01JABCDEF0123456789ABCDEFG',
      week: 3,
      attempts: 2,
      ok: true,
      reason: null,
    });
  });

  it('truncates a long string, so a Yahoo payload cannot be dumped', () => {
    const output = redact({ body: 'x'.repeat(5000) }) as { body: string };
    expect(output.body.length).toBeLessThan(2100);
    expect(output.body).toContain('[truncated]');
  });

  it('caps array length and recursion depth', () => {
    const output = redact({ items: Array.from({ length: 500 }, (_, i) => i) }) as {
      items: number[];
    };
    expect(output.items).toHaveLength(50);

    let deep: Record<string, unknown> = { value: 'bottom' };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    expect(JSON.stringify(redact(deep as never))).toContain('[truncated]');
  });
});

describe('createLogger', () => {
  it('emits single-line JSON with a correlation ID', () => {
    const { logger, parsed } = capture();
    logger.info('league loaded', { leagueId: 'L1' });

    expect(parsed()[0]).toEqual({
      timestamp: '2026-07-26T12:00:00.000Z',
      level: 'info',
      message: 'league loaded',
      correlationId: 'corr-1',
      leagueId: 'L1',
    });
  });

  it('respects the level threshold', () => {
    const { logger, lines } = capture('warn');
    logger.debug('noise');
    logger.info('noise');
    logger.warn('kept');
    logger.error('kept');

    expect(lines).toHaveLength(2);
  });

  it('redacts fields on the way out', () => {
    const { logger, parsed } = capture();
    logger.info('refreshed', { refreshToken: 'real-token-value', userId: 'u1' });

    const entry = parsed()[0];
    expect(entry.refreshToken).toBe(REDACTED);
    expect(entry.userId).toBe('u1');
    expect(JSON.stringify(entry)).not.toContain('real-token-value');
  });

  it('carries child context on every line', () => {
    const { logger, parsed } = capture();
    logger.child({ route: 'GET /api/yahoo/leagues', userId: 'u1' }).info('ok');

    expect(parsed()[0]).toMatchObject({ route: 'GET /api/yahoo/leagues', userId: 'u1' });
  });

  it('redacts child context too', () => {
    const { logger, parsed } = capture();
    logger.child({ sessionId: 'secret-session' }).info('ok');

    expect(parsed()[0].sessionId).toBe(REDACTED);
  });

  it('survives a cyclic object by truncating at the depth cap', () => {
    const { logger, parsed } = capture();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    logger.error('failed', { cyclic: cyclic as never });

    // The depth cap cuts the cycle before serialization, so the line still
    // carries its message rather than degrading to the fallback.
    const entry = parsed()[0];
    expect(entry.message).toBe('failed');
    expect(JSON.stringify(entry)).toContain('[truncated]');
  });

  it('falls back rather than throwing when a value cannot serialize at all', () => {
    // A logging failure must never take down the request it was describing.
    const { logger, parsed } = capture();

    logger.error('failed', { big: BigInt(1) as never });

    expect(parsed()[0]).toMatchObject({ message: 'failed', logError: 'fields_not_serializable' });
  });
});

describe('describeError', () => {
  it('includes name, message, and stack for CloudWatch', () => {
    const fields = describeError(new TypeError('bad input'));
    expect(fields.errorName).toBe('TypeError');
    expect(fields.errorMessage).toBe('bad input');
    expect(fields.stack).toBeTypeOf('string');
  });

  it('includes a nested cause', () => {
    const error = new Error('outer', { cause: new Error('inner') });
    expect(describeError(error)).toMatchObject({ causeName: 'Error', causeMessage: 'inner' });
  });

  it('handles a thrown non-error', () => {
    expect(describeError('just a string')).toEqual({
      errorName: 'NonError',
      errorMessage: 'just a string',
    });
  });
});
