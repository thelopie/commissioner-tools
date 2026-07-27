import type { LogLevel } from '@dinkel/shared';

/**
 * Structured logging with redaction by default.
 *
 * Two requirements shape this:
 *
 *  1. No secret or token may ever reach a log. CloudWatch retains logs, and a
 *     Yahoo refresh token in a log line is a credential leak that outlives the
 *     request. So rather than trusting call sites to omit sensitive values, the
 *     serializer redacts by key name and by value shape on the way out.
 *
 *  2. Every line carries a correlation ID, so one request or one scheduled job
 *     execution can be reconstructed from interleaved Lambda output.
 *
 * Output is single-line JSON, which CloudWatch Logs Insights can query directly.
 */

const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** Keys whose values are always replaced, matched case-insensitively as substrings. */
const REDACTED_KEY_PATTERNS: readonly RegExp[] = [
  /token/i,
  /secret/i,
  /password/i,
  /authorization/i,
  /cookie/i,
  /credential/i,
  /api[-_]?key/i,
  /session[-_]?id/i,
  /csrf/i,
  /encryption/i,
];

/**
 * Value shapes redacted regardless of key name, for when a secret is logged
 * under an innocent-looking key.
 */
const REDACTED_VALUE_PATTERNS: readonly RegExp[] = [
  // Our AES-GCM envelope
  /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\./,
  // Bearer / Basic headers
  /^(Bearer|Basic)\s+\S+/i,
  // Anthropic keys
  /^sk-ant-/,
  // Yahoo OAuth tokens observed in the wild are long opaque strings
  /^[A-Za-z0-9]{40,}==$/,
];

export const REDACTED = '[redacted]';

export type LogValue =
  string | number | boolean | null | undefined | LogValue[] | { [key: string]: LogValue };

/**
 * Redacts a value tree.
 *
 * Exported so the redaction contract is directly testable rather than only
 * observable through log output.
 */
export function redact(value: LogValue, keyHint = '', depth = 0): LogValue {
  if (depth > 8) return '[truncated]';

  if (keyHint && REDACTED_KEY_PATTERNS.some((pattern) => pattern.test(keyHint))) {
    return REDACTED;
  }

  if (typeof value === 'string') {
    if (REDACTED_VALUE_PATTERNS.some((pattern) => pattern.test(value))) return REDACTED;
    // Cap length so a large Yahoo payload cannot be dumped through a log call.
    return value.length > 2000 ? `${value.slice(0, 2000)}…[truncated]` : value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redact(item, keyHint, depth + 1));
  }

  if (value !== null && typeof value === 'object') {
    const output: Record<string, LogValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = redact(nested as LogValue, key, depth + 1);
    }
    return output;
  }

  return value;
}

export interface LogFields {
  [key: string]: LogValue;
}

export interface Logger {
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  /** Derives a logger carrying additional context on every line. */
  child(fields: LogFields): Logger;
  readonly correlationId: string;
}

export interface LoggerOptions {
  level?: LogLevel;
  correlationId: string;
  base?: LogFields;
  /** Injectable sink, so tests capture output instead of writing to stdout. */
  sink?: (line: string) => void;
  /** Injectable clock, for deterministic assertions. */
  now?: () => string;
}

export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? 'info';
  const threshold = LEVEL_RANK[level];
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date().toISOString());
  const base = options.base ?? {};

  const emit = (entryLevel: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_RANK[entryLevel] > threshold) return;

    const entry = {
      timestamp: now(),
      level: entryLevel,
      message,
      correlationId: options.correlationId,
      ...(redact({ ...base, ...fields }) as Record<string, LogValue>),
    };

    try {
      sink(JSON.stringify(entry));
    } catch {
      // A value that cannot serialize (a cycle, a BigInt) must not take down the
      // request that was merely trying to log.
      sink(
        JSON.stringify({
          timestamp: now(),
          level: entryLevel,
          message,
          correlationId: options.correlationId,
          logError: 'fields_not_serializable',
        }),
      );
    }
  };

  return {
    correlationId: options.correlationId,
    error: (message, fields) => emit('error', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    info: (message, fields) => emit('info', message, fields),
    debug: (message, fields) => emit('debug', message, fields),
    child: (fields) =>
      createLogger({
        ...options,
        level,
        base: { ...base, ...fields },
      }),
  };
}

/**
 * Describes an error for logging without leaking internals to the user.
 *
 * The stack is included: this goes to CloudWatch, not to a browser. Response
 * bodies are built separately from `AppError.toResponseBody()`.
 */
export function describeError(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack ?? null,
      ...(error.cause instanceof Error
        ? { causeName: error.cause.name, causeMessage: error.cause.message }
        : {}),
    };
  }
  return { errorName: 'NonError', errorMessage: String(error) };
}
