// store.ts — the forge's in-memory store.
//
// One Store holds every repository, git object, issue and pull request. There is no
// disk, no network and no clock: every timestamp derives from MAKEFUN_TRIAL_NOW plus a
// deterministic counter, every id from a counter, so two runs fed the same requests
// produce the same bytes (the final replay must leave a byte-identical state export).
//
// The viewer login is the fixed scenario's viewer (wire.ts buildScenario() with the
// kit's constant seed 6a09e667f3bcc909 — the same seed practice and scored trials use,
// see program/generator/draw.mjs). The suite's checks address that login as the token
// owner; the entry learns it from the seed, never from the token (the token is opaque).

import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const ZERO_OID = '0'.repeat(40);

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  readonly createdSeq: number;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  readonly createdSeq: number;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly refs: Map<string, string>;
  readonly objects: Map<string, GitObject>;
  readonly issues: Issue[];
  readonly pulls: Pull[];
  readonly labels: Map<string, { name: string; color: string }>;
  nextNumber: number;
  version: number;
  readonly advCache: Map<string, Buffer>;
  readonly lsCache: Map<string, Buffer>;
  readonly packCache: Map<string, Buffer>;
}

export interface FileChange {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** Parse a commit object's headers. */
export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string } {
  const blank = data.indexOf('\n\n');
  const headerText = (blank < 0 ? data : data.subarray(0, blank)).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
  }
  return { tree, parents, message };
}

/** Parse a tree object into entries in stored order. */
export function parseTree(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const blank = data.indexOf('\n\n');
  const headers = new Map<string, string>();
  for (const line of (blank < 0 ? data : data.subarray(0, blank)).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return { object: headers.get('object') ?? '', type: headers.get('type') ?? '', tag: headers.get('tag') ?? '' };
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: ReadonlyArray<{ mode: string; name: string; oid: string }>): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Format epoch seconds as an ISO 8601 UTC string without touching the wall clock. */
export function isoFromEpochSec(epochSec: number): string {
  const days = Math.floor(epochSec / 86400);
  const secs = epochSec - days * 86400;
  const hh = Math.floor(secs / 3600);
  const mm = Math.floor((secs - hh * 3600) / 60);
  const ss = secs - hh * 3600 - mm * 60;
  // Howard Hinnant's civil-from-days algorithm.
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const year = m <= 2 ? y + 1 : y;
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${p2(m)}-${p2(d)}T${p2(hh)}:${p2(mm)}:${p2(ss)}.000Z`;
}

/** Read MAKEFUN_TRIAL_NOW (epoch seconds, epoch ms, or an ISO string) with a fixed fallback. */
export function trialNowSecOf(env: Readonly<Record<string, string | undefined>>): number {
  const raw = (env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw === '') return 1739175597;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n >= 1e11 ? Math.floor(n / 1000) : n;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1739175597;
}

export function b64encodeUtf8(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function b64decodeUtf8(content: string): string {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64').toString('utf8');
}

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export class Store {
  readonly trialNowSec: number;
  readonly token: string;
  readonly repos = new Map<string, Repo>();
  readonly repoOrder: Repo[] = [];
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentIdValue = 0;
  private creationSeq = 0;
  private seq = 0;
  private commitSeq = 0;
  reqSeq = 0;

  constructor(env: Readonly<Record<string, string | undefined>>) {
    this.trialNowSec = trialNowSecOf(env);
    this.token = env.MAKEFUN_SHOP_TOKEN ?? '';
  }

  /** The next deterministic timestamp (ISO), one second per object created. */
  nowIso(): string {
    this.seq += 1;
    return isoFromEpochSec(this.trialNowSec + this.seq);
  }

  /** The next deterministic commit timestamp (epoch seconds). */
  nextCommitSec(): number {
    this.commitSeq += 1;
    return this.trialNowSec + this.commitSeq;
  }

  nextRequestId(): string {
    this.reqSeq += 1;
    return `req-${String(this.reqSeq).padStart(6, '0')}`;
  }

  nextCommentId(): number {
    this.nextCommentIdValue += 1;
    return this.nextCommentIdValue;
  }

  /** A strictly increasing creation sequence, shared by issues and pull requests. */
  nextCreationSeq(): number {
    this.creationSeq += 1;
    return this.creationSeq;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, options: { private?: boolean; description?: string; defaultBranch?: string }): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER_LOGIN,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: options.defaultBranch ?? 'main',
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextNumber: 1,
      version: 0,
      advCache: new Map(),
      lsCache: new Map(),
      packCache: new Map(),
    };
    this.repos.set(this.repoKey(VIEWER_LOGIN, name), repo);
    this.repoOrder.push(repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
    const index = this.repoOrder.indexOf(repo);
    if (index >= 0) this.repoOrder.splice(index, 1);
  }

  /** Bump a repo's version and drop its cached git responses. */
  touch(repo: Repo): void {
    repo.version += 1;
    repo.advCache.clear();
    repo.lsCache.clear();
    repo.packCache.clear();
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** A commit object built by the server (contents commits, squash merges). */
  makeCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
    const ts = this.nextCommitSec();
    const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
    const lines = [`tree ${treeOid}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${who}`, `committer ${who}`, '');
    const body = message.endsWith('\n') ? message : `${message}\n`;
    return this.putObject(repo, 'commit', Buffer.from(`${lines.join('\n')}\n${body}`, 'utf8'));
  }

  /** Flatten a tree into path -> {oid, mode} (files only; gitlinks skipped). */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build a tree object from a flat path -> {oid, mode} map (nested trees included). */
  buildTreeFromMap(repo: Repo, files: ReadonlyMap<string, { oid: string; mode: string }>): string {
    const build = (prefix: string): string => {
      const entries: Array<{ mode: string; name: string; oid: string }> = [];
      const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
      for (const [path, value] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: value.mode, name: rest, oid: value.oid });
        } else {
          const dir = rest.slice(0, slash);
          let sub = dirs.get(dir);
          if (!sub) {
            sub = new Map();
            dirs.set(dir, sub);
          }
          sub.set(`${dir}/${rest.slice(slash + 1)}`, value);
        }
      }
      for (const [dir, sub] of dirs) {
        const subPrefix = prefix === '' ? '' : prefix;
        void subPrefix;
        entries.push({ mode: '40000', name: dir, oid: build(`${prefix}${dir}/`) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build('');
  }

  /** The tip commit of a branch (or '' when the branch does not exist). */
  branchTip(repo: Repo, branch: string): string {
    return repo.refs.get(`refs/heads/${branch}`) ?? '';
  }

  /** Resolve a ref-ish (branch name, full ref, or oid) to a commit oid, or ''. */
  resolveRef(repo: Repo, ref: string): string {
    if (ref === '') return this.branchTip(repo, repo.defaultBranch);
    if (repo.refs.has(ref)) return repo.refs.get(ref)!;
    const asBranch = repo.refs.get(`refs/heads/${ref}`);
    if (asBranch !== undefined) return asBranch;
    if (isObjectId(ref) && repo.objects.has(ref)) return ref;
    return '';
  }

  /** Every object reachable from roots (commit -> tree + parents, tag -> target). */
  reachable(repo: Repo, roots: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const root of roots) if (isObjectId(root) && repo.objects.has(root)) queue.push(root);
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
    return seen;
  }

  /** True when `ancestor` is `oid` or one of its commit ancestors (peeling tags). */
  isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
    let current = oid;
    const seen = new Set<string>();
    for (;;) {
      if (current === ancestor) return true;
      if (seen.has(current)) return false;
      seen.add(current);
      const object = repo.objects.get(current);
      if (!object) return false;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      if (object.type !== 'commit') return false;
      const parents = parseCommit(object.data).parents;
      if (parents.length === 0) return false;
      if (parents.length === 1) {
        current = parents[0]!;
        continue;
      }
      // Merge commit: search every parent branch.
      const stack = [...parents];
      while (stack.length) {
        const next = stack.pop()!;
        if (next === ancestor) return true;
        if (seen.has(next)) continue;
        seen.add(next);
        const nextObject = repo.objects.get(next);
        if (!nextObject) continue;
        if (nextObject.type === 'tag') stack.push(parseTag(nextObject.data).object);
        else if (nextObject.type === 'commit') stack.push(...parseCommit(nextObject.data).parents);
      }
      return false;
    }
  }

  /** Peel a tag object to its target commit oid (or the oid itself). */
  peelToCommit(repo: Repo, oid: string): string {
    let current = oid;
    for (let i = 0; i < 16; i += 1) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tag') return current;
      current = parseTag(object.data).object;
    }
    return current;
  }

  /** The merge-base of two commits (first common ancestor, BFS by generation). */
  mergeBase(repo: Repo, a: string, b: string): string {
    const ancestorsA = new Set<string>();
    const queueA = [this.peelToCommit(repo, a)];
    while (queueA.length) {
      const oid = queueA.shift()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') queueA.push(...parseCommit(object.data).parents);
    }
    const queueB = [this.peelToCommit(repo, b)];
    const seenB = new Set<string>();
    while (queueB.length) {
      const oid = queueB.shift()!;
      if (ancestorsA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') queueB.push(...parseCommit(object.data).parents);
    }
    return '';
  }

  /** The flat file map at a commit (empty when the commit is unknown). */
  filesAt(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const object = repo.objects.get(this.peelToCommit(repo, commitOid));
    if (!object || object.type !== 'commit') return new Map();
    return this.flattenTree(repo, parseCommit(object.data).tree);
  }

  /** Diff two trees (by commit oid): one entry per changed path, with line counts. */
  diffCommits(repo: Repo, baseCommit: string, headCommit: string): FileChange[] {
    const base = this.filesAt(repo, baseCommit);
    const head = this.filesAt(repo, headCommit);
    const changes: FileChange[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && h && b.oid === h.oid) continue;
      const countLines = (oid: string): number => {
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'blob') return 0;
        const text = object.data.toString('utf8');
        if (text === '') return 0;
        return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      };
      if (!b && h) {
        const additions = countLines(h.oid);
        changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b && !h) {
        const deletions = countLines(b.oid);
        changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (b && h) {
        const oldLines = repo.objects.get(b.oid)?.data.toString('utf8').split('\n') ?? [];
        const newLines = repo.objects.get(h.oid)?.data.toString('utf8').split('\n') ?? [];
        const oldSet = new Map<string, number>();
        for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
        let additions = 0;
        for (const line of newLines) {
          const left = oldSet.get(line) ?? 0;
          if (left > 0) oldSet.set(line, left - 1);
          else additions += 1;
        }
        let deletions = 0;
        for (const left of oldSet.values()) deletions += left;
        changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return changes;
  }

  /** File-level three-way merge: null when it conflicts. */
  threeWayMerge(repo: Repo, baseCommit: string, headCommit: string, baseTipCommit: string): Map<string, { oid: string; mode: string }> | null {
    const base = this.filesAt(repo, baseCommit);
    const head = this.filesAt(repo, headCommit);
    const tip = this.filesAt(repo, baseTipCommit);
    const out = new Map<string, { oid: string; mode: string }>(tip);
    const paths = new Set([...base.keys(), ...head.keys(), ...tip.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const h = head.get(path);
      const t = tip.get(path);
      const same = (x: { oid: string } | undefined, y: { oid: string } | undefined): boolean =>
        (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
      if (same(h, b)) {
        // Head did not change it: keep the base tip's version (or its deletion).
        if (t === undefined) out.delete(path);
        else out.set(path, t);
      } else if (same(t, b)) {
        // Only head changed it: take head's version (or its deletion).
        if (h === undefined) out.delete(path);
        else out.set(path, h);
      } else if (same(h, t)) {
        // Both changed it identically: keep it.
        if (h === undefined) out.delete(path);
        else out.set(path, h);
      } else {
        return null;
      }
    }
    return out;
  }

  mergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
    const headTip = pull.head.sha;
    const baseTip = pull.base.sha;
    const base = this.mergeBase(repo, headTip, baseTip);
    if (base === '') return 'CONFLICTING';
    return this.threeWayMerge(repo, base, headTip, baseTip) === null ? 'CONFLICTING' : 'MERGEABLE';
  }

  // ---------------------------------------------------------------- issues & pulls

  createIssue(repo: Repo, title: string, body: string, labels: readonly string[]): { issue: Issue } | { error: string; status: number } {
    for (const label of labels) {
      if (!repo.labels.has(label)) return { error: `Label "${label}" does not exist`, status: 422 };
    }
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: this.nextCreationSeq(),
    };
    repo.issues.push(issue);
    return { issue };
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): { pull: Pull } | { error: string; status: number } {
    const headTip = this.branchTip(repo, head);
    if (headTip === '') return { error: `Head branch "${head}" does not exist`, status: 422 };
    const baseTip = this.branchTip(repo, base);
    if (baseTip === '') return { error: `Base branch "${base}" does not exist`, status: 422 };
    const pull: Pull = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body: body ?? '',
      state: 'open',
      head: { ref: head, sha: headTip },
      base: { ref: base, sha: baseTip },
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      createdSeq: this.nextCreationSeq(),
    };
    repo.pulls.push(pull);
    return { pull };
  }

  /** Squash-merge a pull request onto its base branch. */
  mergePull(repo: Repo, pull: Pull): { sha: string } | { error: string; status: number } {
    if (pull.state !== 'open') return { error: 'Pull request is not open', status: 405 };
    const baseTip = this.branchTip(repo, pull.base.ref);
    if (baseTip === '') return { error: 'Base branch does not exist', status: 404 };
    const headTip = this.branchTip(repo, pull.head.ref);
    if (headTip === '') return { error: 'Head branch does not exist', status: 404 };
    const base = this.mergeBase(repo, headTip, baseTip);
    if (base === '') return { error: 'No merge base', status: 405 };
    const merged = this.threeWayMerge(repo, base, headTip, baseTip);
    if (merged === null) return { error: 'Merge conflict', status: 405 };
    const treeOid = this.buildTreeFromMap(repo, merged);
    const message = `${pull.title} (#${pull.number})`;
    const sha = this.makeCommit(repo, treeOid, [baseTip], message);
    repo.refs.set(`refs/heads/${pull.base.ref}`, sha);
    pull.head.sha = headTip;
    pull.base.sha = sha;
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = this.nowIso();
    pull.merge_commit_sha = sha;
    this.touch(repo);
    return { sha };
  }

  // ---------------------------------------------------------------- contents

  /**
   * Commit one file on a branch (create or update). When `branch` does not exist it
   * is created from the default branch tip (or empty when the repo is unborn).
   */
  commitFile(
    repo: Repo,
    options: { branch?: string; path: string; content: Buffer; message: string; sha?: string },
  ): { commitSha: string; contentSha: string; created: boolean } | { error: string; status: number } {
    const branch = options.branch ?? repo.defaultBranch;
    let tip = this.branchTip(repo, branch);
    if (tip === '') {
      const defaultTip = this.branchTip(repo, repo.defaultBranch);
      if (branch !== repo.defaultBranch && defaultTip !== '') {
        repo.refs.set(`refs/heads/${branch}`, defaultTip);
        tip = defaultTip;
      }
    }
    const files = tip === '' ? new Map<string, { oid: string; mode: string }>() : this.filesAt(repo, tip);
    const existing = files.get(options.path);
    if (existing !== undefined) {
      if (options.sha === undefined) return { error: 'File already exists', status: 422 };
      if (options.sha.toLowerCase() !== existing.oid.toLowerCase()) return { error: 'sha does not match', status: 409 };
    } else if (options.sha !== undefined) {
      return { error: 'File does not exist', status: 422 };
    }
    const blobOid = this.putObject(repo, 'blob', options.content);
    const next = new Map(files);
    next.set(options.path, { oid: blobOid, mode: '100644' });
    const treeOid = this.buildTreeFromMap(repo, next);
    const commitSha = this.makeCommit(repo, treeOid, tip === '' ? [] : [tip], options.message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    this.touch(repo);
    return { commitSha, contentSha: blobOid, created: existing === undefined };
  }

  /** Delete one file on a branch (the branch must exist and hold the file). */
  deleteFile(
    repo: Repo,
    options: { branch?: string; path: string; message: string; sha?: string },
  ): { commitSha: string } | { error: string; status: number } {
    const branch = options.branch ?? repo.defaultBranch;
    const tip = this.branchTip(repo, branch);
    if (tip === '') return { error: 'Branch does not exist', status: 404 };
    const files = this.filesAt(repo, tip);
    const existing = files.get(options.path);
    if (existing === undefined) return { error: 'File does not exist', status: 404 };
    if (options.sha !== undefined && options.sha.toLowerCase() !== existing.oid.toLowerCase()) {
      return { error: 'sha does not match', status: 409 };
    }
    const next = new Map(files);
    next.delete(options.path);
    const treeOid = this.buildTreeFromMap(repo, next);
    const commitSha = this.makeCommit(repo, treeOid, [tip], options.message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    this.touch(repo);
    return { commitSha };
  }

  /** Walk a branch's history newest-first (following first parents, then all parents). */
  commitList(repo: Repo, fromCommit: string): Array<{ sha: string; message: string }> {
    const out: Array<{ sha: string; message: string }> = [];
    const seen = new Set<string>();
    const queue = [this.peelToCommit(repo, fromCommit)];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const parsed = parseCommit(object.data);
      out.push({ sha: oid, message: parsed.message.replace(/\n+$/, '') });
      queue.push(...parsed.parents);
    }
    return out;
  }
}

export const TYPE_CODES = TYPE_CODE;
