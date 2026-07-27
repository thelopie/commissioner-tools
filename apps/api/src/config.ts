import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadServerEnv, type ServerEnv } from '@dinkel/shared';
import { setCapabilityMatrix, type CapabilityMatrix } from '@dinkel/yahoo-client';

/**
 * Application configuration, resolved once per process.
 *
 * Two things are loaded here and nowhere else: the validated environment, and the
 * Yahoo capability matrix that gates every Yahoo-dependent feature.
 */

let cached: AppConfig | null = null;

export interface AppConfig {
  env: ServerEnv;
  capabilities: CapabilityMatrix;
  /** Base URL for Yahoo API calls: the real API, or the local mock. */
  yahooApiBaseUrl: string;
  /** Base URL for Yahoo OAuth: the real endpoints, or the local mock. */
  yahooOAuthBaseUrl: string | null;
}

/**
 * Loads and validates configuration.
 *
 * Throws on a bad environment, which in Lambda surfaces as an init failure rather
 * than as a confusing 500 on the first request that happens to need the value.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;

  const env = loadServerEnv(source);
  const capabilities = loadCapabilityMatrix();
  setCapabilityMatrix(capabilities);

  cached = {
    env,
    capabilities,
    yahooApiBaseUrl:
      env.YAHOO_MODE === 'mock'
        ? `${env.YAHOO_MOCK_BASE_URL}/fantasy/v2`
        : 'https://fantasysports.yahooapis.com/fantasy/v2',
    yahooOAuthBaseUrl: env.YAHOO_MODE === 'mock' ? env.YAHOO_MOCK_BASE_URL : null,
  };

  return cached;
}

/** Test seam: clears the cache so a test can load a different environment. */
export function resetConfig(): void {
  cached = null;
}

/**
 * Reads `yahoo-capabilities.json` from the repository root.
 *
 * Bundled as a file rather than imported, so the deployed Lambda ships the same
 * reviewed matrix the repository records and a capability cannot be "verified" by
 * a build-time transform.
 */
function loadCapabilityMatrix(): CapabilityMatrix {
  for (const candidate of capabilityMatrixCandidates()) {
    try {
      const raw = readFileSync(candidate, 'utf8');
      return JSON.parse(raw) as CapabilityMatrix;
    } catch {
      continue;
    }
  }

  // Failing closed: with no matrix, nothing is verified and every Yahoo-dependent
  // feature reports blocked. That is strictly safer than assuming availability.
  return {
    lastReviewedAt: 'unknown',
    access: {
      selfService: false,
      approvalRequired: true,
      defaultPermission: 'read-only',
      applicationUrl: 'https://sports.yahoo.com/developer/access/',
    },
    writeOperations: { supported: false },
    commissionerActions: { supported: false },
    retention: { maxRetentionHours: 24, storableIndefinitely: ['yahoo_guid', 'token_value'] },
    resources: [],
    verifiedCapabilities: [],
  };
}

function capabilityMatrixCandidates(): string[] {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return [
    // Deployed: bundled next to the handler.
    `${here}yahoo-capabilities.json`,
    // Local dev from source: apps/api/src -> repository root.
    `${here}../../../yahoo-capabilities.json`,
    // Built output: apps/api/dist -> repository root.
    `${here}../../../../yahoo-capabilities.json`,
    process.env['YAHOO_CAPABILITIES_PATH'] ?? '',
  ].filter((path) => path.length > 0);
}
