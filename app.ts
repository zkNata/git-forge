// app.ts — the HTTP server: routing, auth, and body handling for the four surfaces.
//
// Routing:
//   GET  /healthz                       -> 200 {"ok":true} (the env's boot probe; no auth)
//   /{owner}/{repo}.git/*              -> git smart HTTP (no auth; the git client sends none)
//   /api/v3/*                          -> REST v3 (Bearer auth; JSON in, JSON out)
//   POST /api/graphql                  -> GraphQL (Bearer auth; JSON in, JSON out)
//   POST /mcp                          -> MCP JSON-RPC 2.0 (Bearer auth)
//   anything else                      -> 404 JSON {message:"Not Found"}
//
// Auth: the Bearer token must equal MAKEFUN_SHOP_TOKEN when it is set; when it is
// unset (local development) any non-empty Bearer is accepted. A missing or wrong
// token answers 401 with a JSON message. Auth is decided before the route handler
// runs, so an unauthenticated MCP call answers 401 even for an unknown tool.
//
// Every JSON reply carries a non-empty X-GitHub-Request-Id (the REST protocol check
// requires it; the other surfaces get it for uniformity). The server never crashes
// on a bad request: an unexpected handler error answers 500 JSON and the process
// keeps serving.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest, type RestContext } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function lowerHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    out[key] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

function sendJson(res: ServerResponse, store: Store, status: number, body: unknown, headers?: Record<string, string>): void {
  const payload = status === 204 || body === null || body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': store.nextRequestId(),
    ...(headers ?? {}),
  });
  res.end(payload);
}

function sendBuffer(res: ServerResponse, store: Store, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'x-github-request-id': store.nextRequestId() });
  res.end(body);
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();
  const headers = lowerHeaders(req);

  // The boot probe: no auth, no body.
  if (pathname === '/healthz') {
    if (method !== 'GET') {
      sendJson(res, store, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, store, 200, { ok: true });
    return;
  }

  const isGitPath = pathname.includes('.git/');
  const isRest = pathname === '/api/v3' || pathname.startsWith('/api/v3/');
  const isGraphql = pathname === '/api/graphql';
  const isMcp = pathname === '/mcp';

  if (!isGitPath && !isRest && !isGraphql && !isMcp) {
    sendJson(res, store, 404, { message: 'Not Found' });
    return;
  }

  // Auth (REST, GraphQL, MCP only): the exact shop token when set, else any Bearer.
  if (!isGitPath) {
    const authorization = headers.authorization ?? '';
    const match = /^Bearer (.+)$/.exec(authorization);
    const token = match?.[1] ?? '';
    if (token === '' || (store.token !== '' && token !== store.token)) {
      sendJson(res, store, 401, { message: 'Requires authentication' });
      return;
    }
  }

  const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

  try {
    if (isGitPath) {
      const result = handleGit(store, method, pathname.slice(1), url.searchParams, headers, rawBody);
      sendBuffer(res, store, result.status, result.contentType, result.body);
      return;
    }
    if (isMcp) {
      if (method !== 'POST') {
        sendJson(res, store, 404, { message: 'Not Found' });
        return;
      }
      const result = handleMcp(store, rawBody);
      if (result.status === 202) {
        res.writeHead(202, { ...(result.headers ?? {}) });
        res.end();
        return;
      }
      sendJson(res, store, result.status, result.body, result.headers);
      return;
    }
    // REST and GraphQL: the body must be JSON when present.
    let jsonBody: unknown = null;
    if (rawBody.length > 0) {
      try {
        jsonBody = JSON.parse(rawBody.toString('utf8')) as unknown;
      } catch {
        sendJson(res, store, 400, { message: 'Problems parsing JSON' });
        return;
      }
    }
    if (isGraphql) {
      if (method !== 'POST') {
        sendJson(res, store, 404, { message: 'Not Found' });
        return;
      }
      const result = handleGraphQL(store, VIEWER_LOGIN, jsonBody);
      sendJson(res, store, result.status, result.body);
      return;
    }
    // REST.
    const ctx: RestContext = {
      store,
      viewer: VIEWER_LOGIN,
      origin: `http://${headers.host ?? 'localhost'}`,
    };
    const restPath = pathname.slice('/api/v3'.length);
    const result = handleRest(ctx, method, restPath, url.searchParams, jsonBody);
    if (result.status === 204) {
      res.writeHead(204, { 'x-github-request-id': store.nextRequestId(), ...(result.headers ?? {}) });
      res.end();
      return;
    }
    sendJson(res, store, result.status, result.body, result.headers);
  } catch (error) {
    // Never let one bad request take the server (and the trial) down.
    sendJson(res, store, 500, { message: error instanceof Error ? error.message : String(error) });
  }
}

/** Build the server. The store reads MAKEFUN_TRIAL_NOW and MAKEFUN_SHOP_TOKEN from the environment. */
export function createApp(): Server {
  const store = new Store(process.env);
  const server = createServer((req, res) => {
    void handleRequest(store, req, res).catch((error: unknown) => {
      try {
        sendJson(res, store, 500, { message: error instanceof Error ? error.message : String(error) });
      } catch {
        // The response is already gone; nothing left to do.
      }
    });
  });
  return server;
}
