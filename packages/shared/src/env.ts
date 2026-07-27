import { z } from 'zod';

/**
 * Startup environment validation.
 *
 * The process refuses to boot on a missing or malformed variable rather than
 * discovering it mid-request. Error messages name the variable and what was
 * expected, and never echo the offending value — several of these are secrets.
 */

const base64Bytes = (bytes: number) =>
  z
    .string()
    .min(1)
    .refine(
      (value) => {
        try {
          return Buffer.from(value, 'base64').length === bytes;
        } catch {
          return false;
        }
      },
      { message: `must be base64 that decodes to exactly ${bytes} bytes` },
    );

const port = z.coerce.number().int().min(1).max(65535);

export const yahooModeSchema = z.enum(['mock', 'live']);
export type YahooMode = z.infer<typeof yahooModeSchema>;

export const logLevelSchema = z.enum(['error', 'warn', 'info', 'debug']);
export type LogLevel = z.infer<typeof logLevelSchema>;

/**
 * Server-side configuration. Never import this into the browser bundle — the
 * frontend receives configuration through API responses, not build-time
 * environment inlining, so no secret can end up in public JavaScript.
 */
export const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // Yahoo
    YAHOO_CLIENT_ID: z.string().min(1, 'required — see .env.example'),
    YAHOO_CLIENT_SECRET: z.string().min(1, 'required — see .env.example'),
    // HTTPS is required in live mode and checked below, once YAHOO_MODE is known.
    YAHOO_REDIRECT_URI: z.string().url(),
    YAHOO_MODE: yahooModeSchema.default('mock'),
    YAHOO_MOCK_BASE_URL: z.string().url().default('http://127.0.0.1:4310'),

    // Application
    APP_BASE_URL: z.string().url(),
    API_PORT: port.default(4300),

    // AWS
    AWS_REGION: z.string().min(1),
    DYNAMODB_TABLE_NAME: z.string().min(1),
    DYNAMODB_ENDPOINT: z.string().url().optional().or(z.literal('')),
    IMPORT_BUCKET_NAME: z.string().optional().or(z.literal('')),

    // Secrets
    SESSION_SECRET: base64Bytes(32),
    TOKEN_ENCRYPTION_KEY: base64Bytes(32),

    // Recap prose (optional — recaps fall back to templates without it)
    ANTHROPIC_API_KEY: z.string().optional().or(z.literal('')),
    ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),

    LOG_LEVEL: logLevelSchema.default('info'),
  })
  .superRefine((env, ctx) => {
    if (env.YAHOO_MODE === 'live') {
      // In live mode the placeholder credentials from .env.example are a
      // configuration error, not a usable value.
      for (const key of ['YAHOO_CLIENT_ID', 'YAHOO_CLIENT_SECRET'] as const) {
        if (env[key] === 'replace-me') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'still the .env.example placeholder, but YAHOO_MODE=live',
          });
        }
      }

      /**
       * Yahoo requires an HTTPS redirect URI and will not accept plain
       * http://localhost, so this is enforced whenever a real Yahoo is involved.
       *
       * Deliberately NOT enforced in mock mode: there is no Yahoo to satisfy, and
       * demanding HTTPS there would force every contributor through openssl and a
       * browser certificate warning just to click through a fake consent screen.
       */
      if (!env.YAHOO_REDIRECT_URI.startsWith('https://')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['YAHOO_REDIRECT_URI'],
          message:
            'Yahoo requires HTTPS, even for localhost. Run `npm run certs`, or set YAHOO_MODE=mock to develop over plain HTTP.',
        });
      }
    }

    // Cookies are Secure-only over HTTPS, so an HTTPS app origin with an HTTP
    // redirect URI would complete the OAuth flow and then drop the session.
    if (env.APP_BASE_URL.startsWith('https://') && env.YAHOO_REDIRECT_URI.startsWith('http://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['YAHOO_REDIRECT_URI'],
        message:
          'is HTTP while APP_BASE_URL is HTTPS — the session cookie is Secure-only and would be dropped. Use the same scheme for both.',
      });
    }

    if (env.NODE_ENV === 'production') {
      if (!env.APP_BASE_URL.startsWith('https://')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['APP_BASE_URL'],
          message: 'must be HTTPS in production — session cookies are Secure-only',
        });
      }
      if (env.DYNAMODB_ENDPOINT) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DYNAMODB_ENDPOINT'],
          message: 'must be unset in production so the SDK resolves the real regional endpoint',
        });
      }
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Validates and returns server configuration.
 *
 * @throws {EnvValidationError} listing every problem at once, so a misconfigured
 * deployment is fixed in one pass instead of one variable per restart.
 */
export function loadServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    return `${key}: ${issue.message}`;
  });
  throw new EnvValidationError(issues);
}

/**
 * Public, non-secret configuration safe to send to the browser. Deliberately an
 * allowlist: adding a field here is a visible decision, so a secret cannot
 * reach the frontend by being spread in accidentally.
 */
export function publicConfig(env: ServerEnv): {
  yahooMode: YahooMode;
  appBaseUrl: string;
  recapProseEnabled: boolean;
} {
  return {
    yahooMode: env.YAHOO_MODE,
    appBaseUrl: env.APP_BASE_URL,
    recapProseEnabled: Boolean(env.ANTHROPIC_API_KEY),
  };
}
