import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Cryptographic primitives.
 *
 * Yahoo refresh tokens are the most sensitive thing this application stores: one
 * grants read access to a user's fantasy account until revoked. They are
 * encrypted with AES-256-GCM before touching DynamoDB, so a table export or a
 * stray backup does not hand over live credentials.
 *
 * GCM rather than CBC: it authenticates the ciphertext, so a tampered record
 * fails to decrypt instead of yielding attacker-influenced plaintext.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the value GCM is specified for
const KEY_BYTES = 32;
const TAG_BYTES = 16;

/** Envelope version, so a future key or algorithm change stays decryptable. */
const ENVELOPE_VERSION = 'v1';

export class DecryptionError extends Error {
  constructor(reason: string, cause?: unknown) {
    // No ciphertext, key material, or plaintext in the message: this string ends
    // up in logs.
    super(`Could not decrypt stored value: ${reason}`);
    this.name = 'DecryptionError';
    if (cause !== undefined) this.cause = cause;
  }
}

function decodeKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `Encryption key must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  return key;
}

/**
 * Encrypts a value for storage.
 *
 * @returns `v1.{iv}.{tag}.{ciphertext}`, all base64url. Self-describing so
 *   decryption needs no out-of-band parameters.
 */
export function encryptToken(plaintext: string, base64Key: string): string {
  const key = decodeKey(base64Key);
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    ENVELOPE_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Decrypts a stored value.
 *
 * @throws {DecryptionError} on a malformed envelope, a wrong key, or tampering.
 *   Callers treat this as "the connection is unusable, ask the user to
 *   reconnect" rather than a retryable fault — notably after a key rotation.
 */
export function decryptToken(envelope: string, base64Key: string): string {
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new DecryptionError('unrecognized envelope format');
  }

  const [, ivPart, tagPart, ciphertextPart] = parts;
  const iv = Buffer.from(ivPart!, 'base64url');
  const tag = Buffer.from(tagPart!, 'base64url');
  const ciphertext = Buffer.from(ciphertextPart!, 'base64url');

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new DecryptionError('envelope has malformed IV or authentication tag');
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, decodeKey(base64Key), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (cause) {
    // Authentication failure and wrong key are indistinguishable here by design.
    throw new DecryptionError('authentication failed — wrong key or tampered value', cause);
  }
}

/**
 * Generates an opaque session identifier.
 *
 * 32 bytes of CSPRNG output. Not a JWT: sessions must be revocable the instant a
 * commissioner is removed, and a self-contained token cannot be withdrawn before
 * it expires. The record lives in DynamoDB, so deleting it ends the session.
 */
export function generateSessionId(): string {
  return randomBytes(32).toString('base64url');
}

/** Generates a CSRF token for the double-submit pattern. */
export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Generates an invitation token. Only its hash is stored. */
export function generateInviteToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * SHA-256 hex digest.
 *
 * Used for invitation tokens and CSV file fingerprints — not for passwords,
 * which this application does not have: identity comes from Yahoo OAuth, so
 * there is no password to store badly.
 */
export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time comparison of two secrets of equal expected length. */
export function safeCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    // timingSafeEqual throws on length mismatch. Still compare something so the
    // work done does not depend on which input was longer.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Deterministic seed for the LLWS draw.
 *
 * The seed is recorded alongside the assignments so anyone can re-run the draw
 * and confirm nobody's team was quietly swapped afterwards. It embeds a caller
 * supplied label plus randomness, making it unique per run and self-documenting.
 */
export function generateRandomizationSeed(label: string): string {
  return `${label}:${randomBytes(16).toString('hex')}`;
}
