#!/usr/bin/env node
/**
 * Generates a self-signed certificate for local HTTPS.
 *
 * Yahoo requires an HTTPS redirect URI and will not accept plain
 * http://localhost, so local development needs TLS. The browser will warn about
 * the untrusted certificate — proceeding past that warning is expected and safe
 * for a loopback development server.
 *
 * Uses the openssl binary rather than a dependency: it ships with Git for Windows
 * and every macOS and Linux install, and this is a once-per-machine setup step.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const certDir = fileURLToPath(new URL('../certs/', import.meta.url));
const keyPath = `${certDir}localhost-key.pem`;
const certPath = `${certDir}localhost-cert.pem`;

if (existsSync(keyPath) && existsSync(certPath)) {
  console.log('Local certificate already exists:');
  console.log(`  ${certPath}`);
  console.log('\nDelete both files in certs/ and re-run to regenerate.');
  process.exit(0);
}

mkdirSync(certDir, { recursive: true });

// subjectAltName is required: modern browsers ignore the common name entirely and
// reject a certificate with no matching SAN.
const configPath = `${certDir}openssl.cnf`;
writeFileSync(
  configPath,
  `[req]
distinguished_name = dn
x509_extensions = v3_req
prompt = no

[dn]
C = US
ST = Local
L = Local
O = Dinkel Portal Local Development
CN = localhost

[v3_req]
subjectAltName = @alt_names
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
`,
  'utf8',
);

try {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-days',
      '825',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-config',
      configPath,
    ],
    { stdio: 'pipe' },
  );
} catch (error) {
  console.error('\nCould not generate a certificate with openssl.\n');
  console.error('openssl ships with Git for Windows, macOS, and most Linux distributions.');
  console.error('If it is missing, install it and re-run `npm run certs`.\n');
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}

console.log('Created a self-signed certificate for local HTTPS:');
console.log(`  ${keyPath}`);
console.log(`  ${certPath}`);
console.log('\nThese are git-ignored and never leave your machine.');
console.log('\nNext:');
console.log('  1. npm run dev');
console.log('  2. Open https://localhost:5173 and accept the browser warning.');
console.log('  3. Register https://localhost:5173/auth/yahoo/callback on your Yahoo app.');
console.log('     Yahoo requires HTTPS and matches the URI exactly.\n');
