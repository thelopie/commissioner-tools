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
      /*
        Placeholder Yahoo credentials do NOT stop the service starting.

        They used to, and that was the wrong trade. A deployment waiting on Yahoo
        approval — which is the normal state of a new install for days or weeks —
        could not serve a single page: standings, dues, the draft board and the sign-in
        screen all returned a 500, because two strings in a secret were unset.

        Refusing to boot only makes sense if the alternative is pretending to work.
        It is not: `isYahooConfigured` drives an explicit "not connected yet" state
        through the API and the interface, and the OAuth route refuses outright. That
        is louder than a 500 and considerably more useful, since everything the portal
        owns rather than reads from Yahoo keeps working.
      */

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
      /**
       * Mock mode must never reach the league.
       *
       * In mock mode every read is answered from synthetic fixtures — invented team
       * names, invented scores. Deployed, that would show the league a standings
       * table that looks entirely real and is entirely fictional, and nothing on the
       * page says so except a small chip. Refusing to boot is the only safe failure:
       * a portal that is obviously down is far better than one quietly lying.
       */
      if (env.YAHOO_MODE === 'mock') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['YAHOO_MODE'],
          message:
            'cannot be mock in production — it would serve synthetic teams and scores as if ' +
            'they were real. Set YAHOO_MODE=live once Yahoo credentials are in place.',
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
/** What the stack writes into a fresh secret, and what `.env.example` ships. */
export const YAHOO_CREDENTIAL_PLACEHOLDER = 'replace-me';

/**
 * Whether real Yahoo credentials are in place.
 *
 * False on a fresh deployment waiting on Yahoo's approval. Everything the portal owns
 * — dues, prizes, the draft order, announcements — works regardless; only reads of
 * Yahoo data and signing in are unavailable, and both say so.
 */
export function isYahooConfigured(env: ServerEnv): boolean {
  if (env.YAHOO_MODE === 'mock') return true;
  return (
    env.YAHOO_CLIENT_ID !== YAHOO_CREDENTIAL_PLACEHOLDER &&
    env.YAHOO_CLIENT_SECRET !== YAHOO_CREDENTIAL_PLACEHOLDER &&
    env.YAHOO_CLIENT_ID.length > 0 &&
    env.YAHOO_CLIENT_SECRET.length > 0
  );
}

export function publicConfig(env: ServerEnv): {
  yahooMode: YahooMode;
  yahooConfigured: boolean;
  appBaseUrl: string;
  recapProseEnabled: boolean;
} {
  return {
    yahooMode: env.YAHOO_MODE,
    yahooConfigured: isYahooConfigured(env),
    appBaseUrl: env.APP_BASE_URL,
    recapProseEnabled: Boolean(env.ANTHROPIC_API_KEY),
  };
}
