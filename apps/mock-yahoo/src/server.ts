import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleFantasyRequest, handleTokenRequest } from './handlers.js';

/**
 * Local mock Yahoo server.
 *
 * Binds to loopback only. It serves synthetic fixtures and accepts any bearer
 * token, so exposing it on a network interface would be pointless at best.
 */

const PORT = Number(process.env['MOCK_YAHOO_PORT'] ?? 4310);
const HOST = '127.0.0.1';

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
    // Nothing legitimate posted here is large; refuse to buffer more.
    if (chunks.reduce((total, part) => total + part.length, 0) > 64 * 1024) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  response.end(payload);
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);
    const path = url.pathname;

    if (path === '/health') {
      send(response, 200, { ok: true, mode: 'mock' });
      return;
    }

    // Yahoo's token endpoint, mounted at the same path the real one uses so the
    // client needs no special-casing beyond its base URL.
    if (path === '/oauth2/get_token' && request.method === 'POST') {
      const result = handleTokenRequest(await readBody(request));
      send(response, result.status, result.body);
      return;
    }

    /**
     * The consent screen. A real browser redirect flow, so the portal's state
     * validation and callback handling are genuinely exercised: it immediately
     * redirects back with a code rather than asking a human to click Approve.
     */
    if (path === '/oauth2/request_auth') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');

      if (!redirectUri) {
        send(response, 400, {
          error: 'invalid_request',
          error_description: 'missing redirect_uri',
        });
        return;
      }

      const target = new URL(redirectUri);
      target.searchParams.set('code', 'mock-authorization-code');
      if (state) target.searchParams.set('state', state);

      response.writeHead(302, { Location: target.toString() });
      response.end();
      return;
    }

    if (path.startsWith('/fantasy/v2/')) {
      // Any bearer token is accepted: this server holds nothing worth guarding,
      // and rejecting tokens would only obstruct local development.
      if (!request.headers.authorization?.startsWith('Bearer ')) {
        send(response, 401, { error: { description: 'missing bearer token' } });
        return;
      }

      const result = handleFantasyRequest(path.slice('/fantasy/v2/'.length));
      send(response, result.status, result.body);
      return;
    }

    send(response, 404, { error: { description: `no mock route for ${path}` } });
  })().catch((error: unknown) => {
    send(response, 500, { error: { description: String(error) } });
  });
});

server.listen(PORT, HOST, () => {
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'mock Yahoo server listening',
      url: `http://${HOST}:${PORT}`,
      note: 'synthetic fixtures only — no real Yahoo data',
    }),
  );
});
