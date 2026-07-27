#!/usr/bin/env node
/**
 * Starts everything needed for local development.
 *
 * Three processes: the mock Yahoo server, the API, and the frontend. Run together
 * so a single Ctrl-C stops all of them — a stray API process holding port 4300 is
 * a confusing way to lose ten minutes.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

if (!existsSync(`${root}.env`)) {
  console.error('\nNo .env file found.\n');
  console.error('  cp .env.example .env    (or copy it by hand on Windows)\n');
  console.error('Then generate the two required keys:\n');
  console.error(
    "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"\n",
  );
  console.error('...and put the output in SESSION_SECRET and TOKEN_ENCRYPTION_KEY.\n');
  process.exit(1);
}

if (!existsSync(`${root}certs/localhost-cert.pem`)) {
  // A warning rather than a failure: the app runs fine on HTTP for everything
  // except the Yahoo flow, which needs an HTTPS redirect URI.
  console.warn('\n⚠ No local HTTPS certificate. Run `npm run certs` before using the Yahoo flow.');
  console.warn('  Yahoo does not accept http://localhost as a redirect URI.\n');
}

const processes = [
  { name: 'mock-yahoo', args: ['run', 'dev:mock-yahoo'], color: '\x1b[35m' },
  { name: 'api', args: ['run', 'dev:api'], color: '\x1b[36m' },
  { name: 'web', args: ['run', 'dev:web'], color: '\x1b[32m' },
];

const children = processes.map(({ name, args, color }) => {
  const child = spawn('npm', args, {
    cwd: root,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = `${color}[${name}]\x1b[0m`;
  const write = (stream) => (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim().length > 0) console.log(`${prefix} ${line}`);
    }
    void stream;
  };

  child.stdout.on('data', write('out'));
  child.stderr.on('data', write('err'));

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`${prefix} exited with code ${code}`);
    }
  });

  return child;
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nStopping…');
  for (const child of children) child.kill();
  // Give them a moment to exit cleanly before the parent does.
  setTimeout(() => process.exit(0), 500);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('\nStarting the Dinkel Portal locally.');
console.log('  web         https://localhost:5173');
console.log('  api         http://127.0.0.1:4300');
console.log('  mock Yahoo  http://127.0.0.1:4310');
console.log('\nWith YAHOO_MODE=mock you need no Yahoo credentials at all.\n');
