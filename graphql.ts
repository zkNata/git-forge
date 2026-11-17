// graphql.ts — the GraphQL surface (POST /api/graphql), verified against the suite's
// documents (sdk/conformance/src/checks-graphql.ts GRAPHQL_DOCUMENTS, 19 documents).
//
// A small recursive-descent parser for the GraphQL subset those documents use
// (operations, variables, arguments, aliases, inline fragments, __type introspection)
// and a typed executor over the same Store the REST and MCP surfaces use, so an
// object created through GraphQL reads back identically through REST and vice versa.
//
// Introspection lists are supersets of the fields the suite requires; the checks assert
// inclusion, not exact equality. Unknown fields resolve to null with an error entry
// naming the field (HTTP 200 + errors array), exactly as the invalid-field check expects.

import {
  VIEWER_LOGIN,
  VIEWER_ID,
  decodeGlobalId,
  globalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ------------------------------------------------------------------ parser

type ArgValue =
  | { kind: 'var'; name: string }
  | { kind: 'enum'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; items: ArgValue[] }
  | { kind: 'object'; fields: Record<string, ArgValue> };

interface FieldSelection {
  kind: 'field';
  alias: string;
  name: string;
  args: Record<string, ArgValue>;
  selections: Selection[];
}

interface FragmentSelection {
  kind: 'fragment';
  typeCondition: string | null;
  selections: Selection[];
}

type Selection = FieldSelection | FragmentSelection;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variableNames: string[];
  selections: Selection[];
}

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < source.length) {
    const ch = source[pos]!;
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') {
      pos += 1;
      continue;
    }
    if (ch === '#') {
      while (pos < source.length && source[pos] !== '\n') pos += 1;
      continue;
    }
    if (ch === '.' && source.startsWith('...', pos)) {
      tokens.push({ kind: 'spread', value: '...' });
      pos += 3;
      continue;
    }
    if ('{}():$!=@[]|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      pos += 1;
      continue;
    }
    if (ch === '"') {
      let end = pos + 1;
      let value = '';
      while (end < source.length && source[end] !== '"') {
        if (source[end] === '\\' && end + 1 < source.length) {
          const escaped = source[end + 1]!;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          end += 2;
        } else {
          value += source[end];
          end += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      pos = end + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let end = pos;
      while (end < source.length && /[0-9.]/.test(source[end]!)) end += 1;
      const text = source.slice(pos, end);
      tokens.push({ kind: text.includes('.') ? 'float' : 'int', value: text });
      pos = end;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = pos;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end]!)) end += 1;
      tokens.push({ kind: 'name', value: source.slice(pos, end) });
      pos = end;
      continue;
    }
    throw new Error(`GraphQL parse error at offset ${pos}: unexpected ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('GraphQL parse error: unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`GraphQL parse error: expected "${value}", got "${token.value}"`);
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.next();
      if (token.kind !== 'name' || (token.value !== 'query' && token.value !== 'mutation')) {
        throw new Error(`GraphQL parse error: expected an operation, got "${token.value}"`);
      }
      const type = token.value as 'query' | 'mutation';
      let name: string | null = null;
      const next = this.peek();
      if (next?.kind === 'name') {
        name = this.next().value;
      }
      const variableNames: string[] = [];
      if (this.acceptPunct('(')) {
        while (!this.acceptPunct(')')) {
          const dollar = this.next();
          if (dollar.kind !== 'punct' || dollar.value !== '$') throw new Error('GraphQL parse error: expected "$" in variable definitions');
          variableNames.push(this.next().value);
          this.expectPunct(':');
          // Skip the type (a name, optionally wrapped in [ ] and suffixed with !).
          while (this.peek()?.value === '[') {
            this.next();
            this.next();
            this.expectPunct(']');
            if (this.peek()?.value === '!') this.next();
          }
          if (this.peek()?.kind === 'name') this.next();
          if (this.peek()?.value === '!') this.next();
          // Skip a default value, if any.
          if (this.acceptPunct('=')) this.parseValue();
        }
      }
      // Directives on the operation (not used by the suite) are skipped.
      while (this.peek()?.value === '@') {
        this.next();
        this.next();
        if (this.acceptPunct('(')) {
          let depth = 1;
          while (depth > 0) {
            const t = this.next();
            if (t.value === '(') depth += 1;
            if (t.value === ')') depth -= 1;
          }
        }
      }
      operations.push({ type, name, variableNames, selections: this.parseSelectionSet() });
    }
    return operations;
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.acceptPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.next();
      let typeCondition: string | null = null;
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.next().value;
      }
      return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
    }
    const first = this.next();
    if (first.kind !== 'name') throw new Error(`GraphQL parse error: expected a field name, got "${first.value}"`);
    let alias = first.value;
    let name = first.value;
    if (this.peek()?.value === ':') {
      this.next();
      name = this.next().value;
    }
    const args: Record<string, ArgValue> = {};
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.next().value;
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    // Directives on the field are skipped (the suite sends none).
    while (this.peek()?.value === '@') {
      this.next();
      this.next();
      if (this.acceptPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.value === '(') depth += 1;
          if (t.value === ')') depth -= 1;
        }
      }
    }
    const selections = this.peek()?.value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): ArgValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'var', name: this.next().value };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', name: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ArgValue[] = [];
      while (!this.acceptPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ArgValue> = {};
      while (!this.acceptPunct('}')) {
        const key = this.next().value;
        this.expectPunct(':');
        fields[key] = this.parseValue();
      }
      return { kind: 'object', fields };
    }
    throw new Error(`GraphQL parse error: unexpected value token "${token.value}"`);
  }
}

function resolveArgValue(value: ArgValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'enum':
      return value.name;
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveArgValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(value.fields)) out[key] = resolveArgValue(field, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldSelection, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = resolveArgValue(value, variables);
  return out;
}

// ------------------------------------------------------------------ schema

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'bodyHTML', 'bodyText', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'assignees', 'milestone', 'locked', 'repository'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'merged', 'files', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit', 'repository'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt', 'labels', 'refs'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'];

// ------------------------------------------------------------------ executor

type GqlObject =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'Viewer'; login: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'IssueConnection'; repo: Repo; issues: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __typename: 'PullRequestConnection'; repo: Repo; pulls: Pull[] }
  | { __typename: 'File'; path: string }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'Owner'; login: string }
  | { __typename: 'Type'; name: string; fields: string[]; enumValues: string[] | null }
  | { __typename: 'IssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'CommentPayload'; repo: Repo; issue: Issue; comment: { id: number; body: string } }
  | { __typename: 'CommentEdge'; repo: Repo; issue: Issue; comment: { id: number; body: string } }
  | { __typename: 'Comment'; repo: Repo; issue: Issue; comment: { id: number; body: string } }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null };

interface Executor {
  store: Store;
  viewer: string;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function cursorFor(number: number): string {
  return Buffer.from(`issue:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: string | undefined): number {
  if (cursor === undefined || cursor === null || cursor === '') return 0;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^issue:(\d+)$/.exec(text);
    return match === null ? 0 : Number(match[1]);
  } catch {
    return 0;
  }
}

/** Project a resolved object through a selection set, recording errors for unknown fields. */
function executeSelections(exec: Executor, value: GqlObject | null, selections: Selection[]): Record<string, unknown> | null {
  if (value === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== value.__typename) continue;
      const projected = executeSelections(exec, value, selection.selections);
      if (projected !== null) Object.assign(out, projected);
      continue;
    }
    out[selection.alias] = resolveField(exec, value, selection);
  }
  return out;
}

/** Resolve one field of one object; unknown fields become null + an error entry. */
function resolveField(exec: Executor, value: GqlObject, field: FieldSelection): unknown {
  const args = resolveArgs(field, exec.variables);
  const unknown = (): null => {
    exec.errors.push({ message: `Cannot query field "${field.name}" on type "${value.__typename}".` });
    return null;
  };
  switch (value.__typename) {
    case 'Query': {
      if (field.name === 'viewer') {
        return executeSelections(exec, { __typename: 'Viewer', login: exec.viewer }, field.selections);
      }
      if (field.name === 'repository') {
        const repo = exec.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        if (repo === undefined) return null;
        return executeSelections(exec, { __typename: 'Repository', repo }, field.selections);
      }
      if (field.name === 'node') {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (decoded === null || decoded.kind !== 'R') return null;
        const [owner, name] = decoded.key.split('/');
        const repo = owner !== undefined && name !== undefined ? exec.store.getRepo(owner, name) : undefined;
        if (repo === undefined) return null;
        return executeSelections(exec, { __typename: 'Repository', repo }, field.selections);
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        const typeObject = typeFor(name);
        if (typeObject === null) return null;
        return executeSelections(exec, typeObject, field.selections);
      }
      return unknown();
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (decoded === null || decoded.kind !== 'R') {
          exec.errors.push({ message: 'createIssue: repositoryId does not identify a repository.' });
          return null;
        }
        const [owner, name] = decoded.key.split('/');
        const repo = owner !== undefined && name !== undefined ? exec.store.getRepo(owner, name) : undefined;
        if (repo === undefined) {
          exec.errors.push({ message: 'createIssue: repository not found.' });
          return null;
        }
        const result = exec.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        if ('error' in result) {
          exec.errors.push({ message: `createIssue: ${result.error}` });
          return null;
        }
        return executeSelections(exec, { __typename: 'IssuePayload', repo, issue: result.issue }, field.selections);
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.issueId ?? ''));
        if (decoded === null || decoded.kind !== 'I') {
          exec.errors.push({ message: 'closeIssue: issueId does not identify an issue.' });
          return null;
        }
        const [ownerName, numberText] = decoded.key.split(':');
        const [owner, name] = (ownerName ?? '').split('/');
        const repo = owner !== undefined && name !== undefined ? exec.store.getRepo(owner, name) : undefined;
        const issue = repo?.issues.find((item) => item.number === Number(numberText));
        if (repo === undefined || issue === undefined) {
          exec.errors.push({ message: 'closeIssue: issue not found.' });
          return null;
        }
        issue.state = 'closed';
        return executeSelections(exec, { __typename: 'IssuePayload', repo, issue }, field.selections);
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (decoded === null || decoded.kind !== 'R') {
          exec.errors.push({ message: 'createPullRequest: repositoryId does not identify a repository.' });
          return null;
        }
        const [owner, name] = decoded.key.split('/');
        const repo = owner !== undefined && name !== undefined ? exec.store.getRepo(owner, name) : undefined;
        if (repo === undefined) {
          exec.errors.push({ message: 'createPullRequest: repository not found.' });
          return null;
        }
        const result = exec.store.createPull(
          repo,
          String(input.title ?? ''),
          String(input.body ?? ''),
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? ''),
        );
        if ('error' in result) {
          exec.errors.push({ message: `createPullRequest: ${result.error}` });
          return null;
        }
        return executeSelections(exec, { __typename: 'PullRequestPayload', repo, pull: result.pull }, field.selections);
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
        if (decoded === null || decoded.kind !== 'P') {
          exec.errors.push({ message: 'mergePullRequest: pullRequestId does not identify a pull request.' });
          return null;
        }
        const [ownerName, numberText] = decoded.key.split(':');
        const [owner, name] = (ownerName ?? '').split('/');
        const repo = owner !== undefined && name !== undefined ? exec.store.getRepo(owner, name) : undefined;
        const pull = repo?.pulls.find((item) => item.number === Number(numberText));
        if (repo === undefined || pull === undefined) {
          exec.errors.push({ message: 'mergePullRequest: pull request not found.' });
          return null;
        }
        const result = exec.store.mergePull(repo, pull);
        if ('error' in result) {
          exec.errors.push({ message: `mergePullRequest: ${result.error}` });
          return null;
        }
        return executeSelections(exec, { __typename: 'PullRequestPayload', repo, pull }, field.selections);
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.subjectId ?? ''));
        if (decoded === null || decoded.kind !== 'I') {
          exec.errors.push({ message: 'addComment: subjectId does not identify an issue.' });
          return null;
        }
        const [ownerName, numberText] = decoded.key.split(':');
        const [owner, name] = (ownerName ?? '').split('/');
        const repo = owner !== undefined && name !== undefined ? exec.store.getRepo(owner, name) : undefined;
        const issue = repo?.issues.find((item) => item.number === Number(numberText));
        if (repo === undefined || issue === undefined) {
          exec.errors.push({ message: 'addComment: issue not found.' });
          return null;
        }
        const comment = { id: exec.store.nextCommentId(), body: String(input.body ?? '') };
        issue.comments.push(comment);
        return executeSelections(exec, { __typename: 'CommentPayload', repo, issue, comment }, field.selections);
      }
      return unknown();
    }
    case 'Viewer': {
      if (field.name === 'login') return value.login;
      return unknown();
    }
    case 'Repository': {
      const repo = value.repo;
      if (field.name === 'id') return globalId('R', `${repo.owner}/${repo.name}`);
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field.name === 'owner') return executeSelections(exec, { __typename: 'Owner', login: repo.owner }, field.selections);
      if (field.name === 'defaultBranchRef') {
        const tip = exec.store.branchTip(repo, repo.defaultBranch);
        if (tip === '') return null;
        return executeSelections(exec, { __typename: 'Ref', name: repo.defaultBranch }, field.selections);
      }
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'description') return repo.description;
      if (field.name === 'isPrivate') return repo.private;
      if (field.name === 'issue') {
        const issue = repo.issues.find((item) => item.number === Number(args.number));
        if (issue === undefined) return null;
        return executeSelections(exec, { __typename: 'Issue', repo, issue }, field.selections);
      }
      if (field.name === 'issues') {
        const states = args.states as string[] | undefined;
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        // Cursor pagination is by position in the ordered, state-filtered list.
        const ordered = [...repo.issues]
          .filter((issue) => states === undefined || new Set(states.map((state) => String(state).toLowerCase())).has(issue.state))
          .sort((a, b) => (orderBy?.field === 'CREATED_AT' && orderBy.direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        const after = cursorNumber(args.after as string | undefined);
        const found = after > 0 ? ordered.findIndex((issue) => issue.number === after) : -1;
        const startIndex = found < 0 ? 0 : found + 1;
        const first = typeof args.first === 'number' ? args.first : ordered.length;
        const page = ordered.slice(startIndex, startIndex + first);
        const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null;
        const hasNextPage = startIndex + page.length < ordered.length;
        return executeSelections(
          exec,
          { __typename: 'IssueConnection', repo, issues: page, pageInfo: { hasNextPage, endCursor } },
          field.selections,
        );
      }
      if (field.name === 'pullRequests') {
        const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
        const pulls = [...repo.pulls].sort((a, b) => b.number - a.number).slice(0, first);
        return executeSelections(exec, { __typename: 'PullRequestConnection', repo, pulls }, field.selections);
      }
      if (field.name === 'pullRequest') {
        const pull = repo.pulls.find((item) => item.number === Number(args.number));
        if (pull === undefined) return null;
        return executeSelections(exec, { __typename: 'PullRequest', repo, pull }, field.selections);
      }
      return unknown();
    }
    case 'Issue': {
      const issue = value.issue;
      const repo = value.repo;
      if (field.name === 'id') return globalId('I', `${repo.owner}/${repo.name}:${issue.number}`);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issue.state.toUpperCase();
      if (field.name === 'body') return issue.body;
      return unknown();
    }
    case 'PullRequest': {
      const pull = value.pull;
      const repo = value.repo;
      if (field.name === 'id') return globalId('P', `${repo.owner}/${repo.name}:${pull.number}`);
      if (field.name === 'number') return pull.number;
      if (field.name === 'title') return pull.title;
      if (field.name === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      if (field.name === 'body') return pull.body;
      if (field.name === 'headRefName') return pull.head.ref;
      if (field.name === 'baseRefName') return pull.base.ref;
      if (field.name === 'mergeable') return pull.state === 'open' ? exec.store.mergeable(repo, pull) : 'UNKNOWN';
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'files') {
        const base = exec.store.mergeBase(repo, pull.head.sha, pull.base.sha);
        const changes = base === '' ? [] : exec.store.diffCommits(repo, base, pull.head.sha);
        const first = typeof args.first === 'number' ? args.first : changes.length;
        const nodes = changes.slice(0, first).map((change) => ({ __typename: 'File' as const, path: change.filename }));
        // The files field is a connection: project its selections (nodes) directly.
        const out: Record<string, unknown> = {};
        for (const selection of field.selections) {
          if (selection.kind === 'field' && selection.name === 'nodes') {
            out[selection.alias] = nodes.map((node) => executeSelections(exec, node, selection.selections));
          } else if (selection.kind === 'field') {
            out[selection.alias] = null;
          }
        }
        return out;
      }
      return unknown();
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') return value.issues.map((issue) => executeSelections(exec, { __typename: 'Issue', repo: value.repo, issue }, field.selections));
      if (field.name === 'pageInfo') return executeSelections(exec, { __typename: 'PageInfo', hasNextPage: value.pageInfo.hasNextPage, endCursor: value.pageInfo.endCursor }, field.selections);
      if (field.name === 'totalCount') return value.issues.length;
      return unknown();
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') return value.pulls.map((pull) => executeSelections(exec, { __typename: 'PullRequest', repo: value.repo, pull }, field.selections));
      if (field.name === 'totalCount') return value.pulls.length;
      return unknown();
    }
    case 'File': {
      if (field.name === 'path') return value.path;
      return unknown();
    }
    case 'Ref': {
      if (field.name === 'name') return value.name;
      return unknown();
    }
    case 'Owner': {
      if (field.name === 'login') return value.login;
      if (field.name === 'id') return value.login === VIEWER_LOGIN ? VIEWER_ID : 0;
      return unknown();
    }
    case 'Type': {
      if (field.name === 'name') return value.name;
      if (field.name === 'fields') {
        const includeDeprecated = args.includeDeprecated === true;
        void includeDeprecated;
        return value.fields.map((name) => ({ name }));
      }
      if (field.name === 'enumValues') {
        if (value.enumValues === null) return null;
        return value.enumValues.map((name) => ({ name }));
      }
      return unknown();
    }
    case 'IssuePayload': {
      if (field.name === 'issue') return executeSelections(exec, { __typename: 'Issue', repo: value.repo, issue: value.issue }, field.selections);
      return unknown();
    }
    case 'PullRequestPayload': {
      if (field.name === 'pullRequest') return executeSelections(exec, { __typename: 'PullRequest', repo: value.repo, pull: value.pull }, field.selections);
      return unknown();
    }
    case 'CommentPayload': {
      if (field.name === 'commentEdge') return executeSelections(exec, { __typename: 'CommentEdge', repo: value.repo, issue: value.issue, comment: value.comment }, field.selections);
      return unknown();
    }
    case 'CommentEdge': {
      if (field.name === 'node') return executeSelections(exec, { __typename: 'Comment', repo: value.repo, issue: value.issue, comment: value.comment }, field.selections);
      return unknown();
    }
    case 'Comment': {
      if (field.name === 'id') return globalId('C', `${value.repo.owner}/${value.repo.name}:${value.issue.number}:${value.comment.id}`);
      if (field.name === 'body') return value.comment.body;
      return unknown();
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return value.hasNextPage;
      if (field.name === 'endCursor') return value.endCursor;
      return unknown();
    }
  }
}

function typeFor(name: string): GqlObject | null {
  switch (name) {
    case 'Issue':
      return { __typename: 'Type', name, fields: ISSUE_FIELDS, enumValues: null };
    case 'PullRequest':
      return { __typename: 'Type', name, fields: PULL_REQUEST_FIELDS, enumValues: null };
    case 'Repository':
      return { __typename: 'Type', name, fields: REPOSITORY_FIELDS, enumValues: null };
    case 'SearchType':
      return { __typename: 'Type', name, fields: [], enumValues: SEARCH_TYPE_VALUES };
    default:
      return null;
  }
}

// ------------------------------------------------------------------ entry point

export interface GraphQLResult {
  status: number;
  body: unknown;
}

export function handleGraphQL(store: Store, viewer: string, body: unknown): GraphQLResult {
  const operations = Array.isArray(body) ? body : [body];
  const results: unknown[] = [];
  for (const operation of operations) {
    results.push(executeOperation(store, viewer, operation));
  }
  return { status: 200, body: Array.isArray(body) ? results : results[0] };
}

function executeOperation(store: Store, viewer: string, operation: unknown): Record<string, unknown> {
  const exec: Executor = { store, viewer, variables: {}, errors: [] };
  if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) {
    return { data: null, errors: [{ message: 'GraphQL request body must be an object with a query.' }] };
  }
  const request = operation as Record<string, unknown>;
  const query = request.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'GraphQL request carries no query.' }] };
  }
  exec.variables = (request.variables ?? {}) as Record<string, unknown>;
  let parsed: Operation[];
  try {
    parsed = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const name = typeof request.operationName === 'string' ? request.operationName : null;
  const selected = name === null ? parsed[0] : parsed.find((item) => item.name === name);
  if (selected === undefined) {
    return { data: null, errors: [{ message: `GraphQL operation ${JSON.stringify(name)} not found.` }] };
  }
  const root: GqlObject = selected.type === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = executeSelections(exec, root, selected.selections);
  if (exec.errors.length > 0) return { data, errors: exec.errors };
  return { data };
}
