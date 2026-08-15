import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/**
 * Loads deployed secrets into the environment before configuration is validated.
 *
 * The stack passes `APP_SECRET_ARN` and `TOKEN_KEY_SECRET_ARN` and grants the function
 * read access, deliberately keeping the values out of the Lambda's environment
 * configuration — anyone with `lambda:GetFunction` can read those, and a Yahoo client
 * secret should not be among them.
 *
 * Nothing was reading them. The infrastructure carried a comment describing this as
 * already happening, the grants and ARNs were in place, and the function simply failed
 * to start: `SESSION_SECRET: Required`, on every cold start, in every environment. It
 * took a real deployment to notice, because locally those values come from `.env`.
 *
 * Values already present in the environment win, so local development and tests keep
 * using `.env` and never reach for AWS.
 */

let client: SecretsManagerClient | null = null;

function secretsClient(): SecretsManagerClient {
  client ??= new SecretsManagerClient({
    region: process.env['AWS_REGION_OVERRIDE'] ?? process.env['AWS_REGION'] ?? 'us-east-1',
  });
  return client;
}

async function readSecret(arn: string): Promise<Record<string, string>> {
  const response = await secretsClient().send(new GetSecretValueCommand({ SecretId: arn }));
  if (!response.SecretString) return {};

  const parsed: unknown = JSON.parse(response.SecretString);
  if (typeof parsed !== 'object' || parsed === null) return {};

  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    // A secret holding a non-string would be a packaging mistake; skip rather than
    // coerce, so the resulting error names the missing variable instead of a bad cast.
    if (typeof value === 'string' && value.length > 0) values[key] = value;
  }
  return values;
}

/**
 * Merges both secrets into `process.env`.
 *
 * Safe to call repeatedly: it is idempotent, and a warm Lambda skips the fetch.
 *
 * @throws when a configured ARN cannot be read. Starting without secrets would only
 *   produce a confusing validation error a moment later, and an unreadable secret is
 *   an infrastructure problem worth surfacing exactly as itself.
 */
export async function loadSecretsIntoEnv(): Promise<void> {
  const arns = [process.env['APP_SECRET_ARN'], process.env['TOKEN_KEY_SECRET_ARN']].filter(
    (arn): arn is string => typeof arn === 'string' && arn.length > 0,
  );

  // No ARNs means local development, where `.env` already supplied everything.
  if (arns.length === 0) return;

  for (const arn of arns) {
    const values = await readSecret(arn);
    for (const [key, value] of Object.entries(values)) {
      // Never clobber an explicit environment variable: it is how a deployment is
      // overridden in an emergency without editing a secret.
      if (!process.env[key]) process.env[key] = value;
    }
  }
}
