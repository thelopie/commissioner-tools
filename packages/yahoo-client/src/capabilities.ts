import { AppError, type YahooCapabilityKey } from '@dinkel/shared';

/**
 * The capability gate.
 *
 * `yahoo-capabilities.json` at the repository root records, for each Yahoo
 * capability, whether it has actually been observed working against a real
 * league. Features consult this before running. A capability that is merely
 * plausible, or documented only in Yahoo's archived guide, does not pass.
 *
 * The point is to make "we have not verified this" a runtime state rather than a
 * comment someone forgets. Until Yahoo grants API access and
 * `npm run verify:yahoo` confirms a capability, anything depending on it reports
 * blocked instead of producing a number nobody can defend.
 */

export interface CapabilityMatrix {
  lastReviewedAt: string;
  access: {
    selfService: boolean;
    approvalRequired: boolean;
    defaultPermission: string;
    applicationUrl: string;
  };
  writeOperations: { supported: boolean };
  commissionerActions: { supported: boolean };
  retention: { maxRetentionHours: number; storableIndefinitely: string[] };
  resources: Array<{
    key: string;
    feature: string;
    resource: string;
    method: string;
    confidence: 'documented' | 'documented-legacy' | 'inferred' | 'unknown';
    testStatus: 'untested' | 'mock-only' | 'verified' | 'failed';
    provides: string[];
    limitations: string[];
  }>;
  verifiedCapabilities: string[];
}

let matrix: CapabilityMatrix | null = null;

/**
 * Installs the capability matrix.
 *
 * Injected rather than imported so this package stays free of filesystem access
 * (it runs in Lambda) and so tests can supply a matrix with specific
 * capabilities verified.
 */
export function setCapabilityMatrix(next: CapabilityMatrix): void {
  matrix = next;
}

export function getCapabilityMatrix(): CapabilityMatrix {
  if (!matrix) {
    throw new AppError('internal_error', {
      publicMessage: 'Server configuration incomplete.',
      detail: { reason: 'capability_matrix_not_loaded' },
    });
  }
  return matrix;
}

/** True when this capability has been observed working against a real league. */
export function isCapabilityVerified(capability: YahooCapabilityKey): boolean {
  if (!matrix) return false;
  return matrix.verifiedCapabilities.includes(capability);
}

/** The subset of the requested capabilities that are not yet verified. */
export function unverifiedCapabilities(
  required: readonly YahooCapabilityKey[],
): YahooCapabilityKey[] {
  return required.filter((capability) => !isCapabilityVerified(capability));
}

/**
 * @throws {AppError} `yahoo_capability_unverified` naming what is missing, so the
 *   message a commissioner sees is actionable rather than a generic failure.
 */
export function assertCapabilities(required: readonly YahooCapabilityKey[]): void {
  const missing = unverifiedCapabilities(required);
  if (missing.length === 0) return;

  throw new AppError('yahoo_capability_unverified', {
    publicMessage:
      `This needs Yahoo data that has not been verified against a real league yet: ` +
      `${missing.join(', ')}. It stays blocked until it is confirmed.`,
    detail: { missing: missing.join(','), count: missing.length },
  });
}

/**
 * Whether Yahoo mutation is permitted. Always false as documented.
 *
 * Exists as a function rather than a constant so the answer comes from the
 * reviewed matrix, and so any future code path that wants to write must consult
 * it explicitly instead of quietly assuming.
 */
export function canWriteToYahoo(): boolean {
  return matrix?.writeOperations.supported === true;
}

export function canPerformCommissionerActions(): boolean {
  return matrix?.commissionerActions.supported === true;
}
