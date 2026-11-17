// mcp.ts — the MCP surface (POST /mcp): JSON-RPC 2.0 Streamable HTTP.
//
// Verified against the suite's client (sdk/conformance/src/mcp-client.ts) and checks
// (sdk/conformance/src/checks-mcp.ts):
// - modern era 2026-07-28: `server/discover` answers supportedVersions (the preferred
//   revision first), capabilities.tools, and serverInfo both top-level and under
//   _meta['io.modelcontextprotocol/serverInfo'];
// - legacy handshake: `initialize` (the client offers 2025-11-25, 2025-06-18, 2025-03-26,
//   2024-11-05) answers the revision it chose, then `notifications/initialized` (202);
// - `tools/list` answers the same six tools every time (one frozen constant, so two
//   calls are byte-for-byte identical in the tools array);
// - `tools/call` echoes the request id exactly, so two concurrent calls keep their own;
// - argument names follow github-mcp-server (create_repo {name}, get_repo {owner, repo},
//   create_issue {owner, repo, title, body?}, list_issues {owner, repo, state?},
//   create_pull_request {owner, repo, title, head, base}, merge_pull_request
//   {owner, repo, pull_number}); a full_name "owner/repo" argument is accepted too;
// - required lists are minimal, so the suite can fill every required property;
// - unknown tools answer -32601 and missing required arguments answer isError:true —
//   never HTTP 500; a non-JSON body answers HTTP 400 with -32700 (handled in app.ts);
// - every tool acts on the same Store as REST and GraphQL, so MCP-created objects read
//   back through REST with the same ids.
//
// Plain JSON responses are used throughout (no SSE stream is required).

import { VIEWER_LOGIN, type Store } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SERVER_NAME = 'makefun-git-forge';
const SERVER_VERSION = '1.0.0';
export const MCP_REVISION = '2026-07-28';
const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Readonly<Record<string, { type: string; description: string }>>;
    required: readonly string[];
  };
}

const strProp = (description: string): { type: string; description: string } => ({ type: 'string', description });
const boolProp = (description: string): { type: string; description: string } => ({ type: 'boolean', description });

/** The six tools, frozen: two tools/list calls answer the identical array. */
export const MCP_TOOLS: readonly McpToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        name: strProp('The name of the repository to create.'),
        description: strProp('A short description of the repository.'),
        private: boolProp('Whether the repository is private.'),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by its owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: strProp('The login of the repository owner.'),
        repo: strProp('The name of the repository.'),
        full_name: strProp('The full name of the repository ("owner/repo"); used when owner and repo are not given.'),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: strProp('The login of the repository owner.'),
        repo: strProp('The name of the repository.'),
        full_name: strProp('The full name of the repository ("owner/repo"); used when owner and repo are not given.'),
        title: strProp('The title of the issue.'),
        body: strProp('The body of the issue.'),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: strProp('The login of the repository owner.'),
        repo: strProp('The name of the repository.'),
        full_name: strProp('The full name of the repository ("owner/repo"); used when owner and repo are not given.'),
        state: strProp('The state to filter by: open, closed, or all.'),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: strProp('The login of the repository owner.'),
        repo: strProp('The name of the repository.'),
        full_name: strProp('The full name of the repository ("owner/repo"); used when owner and repo are not given.'),
        title: strProp('The title of the pull request.'),
        body: strProp('The body of the pull request.'),
        head: strProp('The name of the branch with the changes.'),
        base: strProp('The name of the branch the changes merge into.'),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: strProp('The login of the repository owner.'),
        repo: strProp('The name of the repository.'),
        full_name: strProp('The full name of the repository ("owner/repo"); used when owner and repo are not given.'),
        pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

interface McpResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null, result: unknown): McpResult {
  return {
    status: 200,
    body: { jsonrpc: '2.0', id, result },
    headers: { 'Mcp-Protocol-Version': MCP_REVISION },
  };
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): McpResult {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return {
    status: 200,
    body: { jsonrpc: '2.0', id, error },
    headers: { 'Mcp-Protocol-Version': MCP_REVISION },
  };
}

function toolResult(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

/** Split "owner/repo" (or read owner + repo) into an owner/repo pair. */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const owner = typeof args.owner === 'string' ? args.owner : undefined;
  const repo = typeof args.repo === 'string' ? args.repo : undefined;
  if (owner !== undefined && repo !== undefined) return { owner, repo };
  const fullName = typeof args.full_name === 'string' ? args.full_name : undefined;
  if (fullName !== undefined) {
    const slash = fullName.indexOf('/');
    if (slash > 0) return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
  }
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const missing = (tool: McpToolDef): string[] =>
    tool.inputSchema.required.filter((property) => {
      // owner/repo may be supplied together as full_name.
      if ((property === 'owner' || property === 'repo') && typeof args.full_name === 'string') return false;
      return args[property] === undefined || args[property] === null || args[property] === '';
    });
  const tool = MCP_TOOLS.find((item) => item.name === name);
  if (tool === undefined) {
    // The caller turns this into a JSON-RPC -32601; this branch is unreachable from
    // handleMcp, which checks the name first.
    return toolError(`Unknown tool: ${name}`);
  }
  const missingArgs = missing(tool);
  if (missingArgs.length > 0) {
    return toolError(`Missing required argument(s): ${missingArgs.join(', ')}`);
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) {
        return toolError(`Repository "${repoName}" already exists`);
      }
      const repo = store.createRepo(repoName, {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      return toolResult(repoJson(store, repo));
    }
    case 'get_repo': {
      const target = resolveOwnerRepo(args);
      if (target === null) return toolError('get_repo needs owner and repo (or full_name)');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError(`Repository "${target.owner}/${target.repo}" not found`);
      return toolResult(repoJson(store, repo));
    }
    case 'create_issue': {
      const target = resolveOwnerRepo(args);
      if (target === null) return toolError('create_issue needs owner and repo (or full_name)');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError(`Repository "${target.owner}/${target.repo}" not found`);
      const result = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      if ('error' in result) return toolError(result.error);
      return toolResult(issueJson(store, repo, result.issue));
    }
    case 'list_issues': {
      const target = resolveOwnerRepo(args);
      if (target === null) return toolError('list_issues needs owner and repo (or full_name)');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError(`Repository "${target.owner}/${target.repo}" not found`);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const issues = state === 'all' ? repo.issues : repo.issues.filter((issue) => issue.state === state);
      return toolResult(issues.map((issue) => issueJson(store, repo, issue)));
    }
    case 'create_pull_request': {
      const target = resolveOwnerRepo(args);
      if (target === null) return toolError('create_pull_request needs owner and repo (or full_name)');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError(`Repository "${target.owner}/${target.repo}" not found`);
      const result = store.createPull(
        repo,
        String(args.title),
        typeof args.body === 'string' ? args.body : '',
        String(args.head),
        String(args.base),
      );
      if ('error' in result) return toolError(result.error);
      return toolResult(pullJson(store, repo, result.pull));
    }
    case 'merge_pull_request': {
      const target = resolveOwnerRepo(args);
      if (target === null) return toolError('merge_pull_request needs owner and repo (or full_name)');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError(`Repository "${target.owner}/${target.repo}" not found`);
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((item) => item.number === number);
      if (pull === undefined) return toolError(`Pull request #${args.pull_number} not found`);
      const result = store.mergePull(repo, pull);
      if ('error' in result) return toolError(result.error);
      return toolResult({ ...pullJson(store, repo, pull), sha: result.sha, merged: true });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

let sessionCounter = 0;

/**
 * Handle one POST /mcp request. `body` is the raw request bytes; a non-JSON body is
 * answered HTTP 400 with JSON-RPC -32700. Auth is decided by the caller (app.ts)
 * before this runs, so an unauthenticated call never reaches here.
 */
export function handleMcp(store: Store, body: Buffer): McpResult {
  let request: JsonRpcRequest;
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
    }
    request = parsed as JsonRpcRequest;
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const id = request.id === undefined ? null : request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = request.params ?? {};

  // Notifications carry no id and get no JSON-RPC response (HTTP 202).
  if (request.id === undefined) {
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      return { status: 202, body: '' };
    }
    return { status: 202, body: '' };
  }

  switch (method) {
    case 'server/discover': {
      const result = {
        supportedVersions: [...SUPPORTED_REVISIONS],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: 'A GitHub-compatible git forge: create repos, issues and pull requests over REST, GraphQL, git smart HTTP, or these MCP tools.',
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
          'io.modelcontextprotocol/protocolVersion': MCP_REVISION,
        },
      };
      return rpcResult(id, result);
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = SUPPORTED_REVISIONS.includes(offered) ? offered : MCP_REVISION;
      sessionCounter += 1;
      const sessionId = `session-${String(sessionCounter).padStart(6, '0')}`;
      const result = {
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      };
      return {
        status: 200,
        body: { jsonrpc: '2.0', id, result },
        headers: { 'Mcp-Protocol-Version': chosen, 'Mcp-Session-Id': sessionId },
      };
    }
    case 'ping': {
      return rpcResult(id, {});
    }
    case 'tools/list': {
      return rpcResult(id, { tools: MCP_TOOLS });
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        return rpcError(id, -32602, 'tools/call arguments must be an object');
      }
      if (MCP_TOOLS.find((item) => item.name === toolName) === undefined) {
        return rpcError(id, -32601, `Method not found: unknown tool "${toolName}"`);
      }
      return rpcResult(id, callTool(store, toolName, args));
    }
    default: {
      return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }
}
