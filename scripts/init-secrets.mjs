#!/usr/bin/env node
/**
 * Writes real cryptographic keys into the deployed secrets.
 *
 * The stack generates `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` with CDK's
 * `generateSecretString`, which produces a random alphanumeric string. The
 * application requires base64 that decodes to exactly 32 bytes, and a 44-character
 * alphanumeric string is not that — it has no padding and decodes to 33 bytes. So the
 * generated values could never satisfy the contract, and the function failed to start
 * on every cold start with `must be base64 that decodes to exactly 32 bytes`.
 *
 * Rather than loosen a deliberately strict key format, the keys are generated here
 * with `randomBytes(32)` and written once. Existing non-placeholder values are left
 * alone, so re-running this is safe and will not silently rotate a key — rotating
 * `TOKEN_ENCRYPTION_KEY` invalidates every stored Yahoo connection.
 *
 * Usage:
 *   node scripts/init-secrets.mjs <app-secret-arn> <token-key-secret-arn>
 */

import { randomBytes } from 'node:crypto';
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

const [appSecretArn, tokenSecretArn] = process.argv.slice(2);

if (!appSecretArn || !tokenSecretArn) {
  console.error('usage: node scripts/init-secrets.mjs <app-secret-arn> <token-key-secret-arn>');
  process.exit(1);
}

const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

/** A 32-byte key, base64 encoded — exactly what the application validates for. */
const key = () => randomBytes(32).toString('base64');

/**
 * True when a value is absent, a placeholder, or not a valid 32-byte key.
 *
 * Presence is not enough. CDK's generated alphanumeric string is present and wrong —
 * checking only for emptiness is what made the first run report "already set" while
 * the function carried on failing to start.
 */
function needsValue(value) {
  if (!value || value === 'replace-me') return true;
  try {
    return Buffer.from(value, 'base64').length !== 32;
  } catch {
    return true;
  }
}

async function read(arn) {
  const response = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  return response.SecretString ? JSON.parse(response.SecretString) : {};
}

async function ensure(arn, keysToSet) {
  const current = await read(arn);
  const updated = { ...current };
  const written = [];

  for (const name of keysToSet) {
    // Never overwrite a real value: this script is safe to re-run, and quietly
    // rotating the token key would disconnect every user.
    if (needsValue(current[name])) {
      updated[name] = key();
      written.push(name);
    }
  }

  if (written.length === 0) {
    console.log(`${arn.split(':').pop()}: already set, nothing changed`);
    return;
  }

  await client.send(
    new PutSecretValueCommand({ SecretId: arn, SecretString: JSON.stringify(updated) }),
  );
  console.log(`wrote ${written.join(', ')}`);
}

await ensure(appSecretArn, ['SESSION_SECRET']);
await ensure(tokenSecretArn, ['TOKEN_ENCRYPTION_KEY']);

console.log(
  '\nYahoo credentials are still placeholders. Set them with:\n' +
    `  aws secretsmanager put-secret-value --secret-id ${appSecretArn} --secret-string '{...}'\n` +
    'or in the console. The function reads secrets at cold start.',
);
