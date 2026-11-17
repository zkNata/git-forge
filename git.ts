// git.ts — the git smart-HTTP surface: upload-pack v2/v0 (advertisement, ls-refs, fetch)
// and receive-pack v0 (push with report-status), plus the packfile codec.
//
// The suite drives this surface with its own git client (sdk/conformance/src/git-client.ts)
// and also with the real git binary in the reference forge's own checks; every wire
// detail below was verified against that client: pkt-line framing, v2 command sections,
// sideband-64k framing, shallow/deepen semantics, and the report-status format.
//
// Determinism: packs are written from a sorted oid list with plain (undelted) objects,
// so the same request against the same repo version always yields the same bytes.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import { Store, ZERO_OID, isObjectId, parseCommit, parseTag, parseTree, type GitObjectType, type Repo } from './store.ts';

const AGENT = 'makefun-git-forge/1';

export const GIT_CONTENT_TYPES = {
  uploadAdvertisement: 'application/x-git-upload-pack-advertisement',
  receiveAdvertisement: 'application/x-git-receive-pack-advertisement',
  uploadResult: 'application/x-git-upload-pack-result',
  receiveResult: 'application/x-git-receive-pack-result',
} as const;

// ------------------------------------------------------------------ pkt-line codec

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const length = payload.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_END = Buffer.from('0002', 'ascii');

export type PktItem = { kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Parse pkt-lines starting at `offset`; returns the items and the offset just past them. */
export function parsePktLines(buf: Buffer, offset = 0): { items: PktItem[]; next: number } {
  const items: PktItem[] = [];
  let pos = offset;
  while (pos + 4 <= buf.length) {
    const hex = buf.subarray(pos, pos + 4).toString('ascii');
    const length = parseInt(hex, 16);
    if (!Number.isFinite(length) || length < 0) break;
    if (length === 0) {
      items.push({ kind: 'flush' });
      pos += 4;
      continue;
    }
    if (length === 1) {
      items.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (length === 2) {
      items.push({ kind: 'end' });
      pos += 4;
      continue;
    }
    if (pos + length > buf.length) break;
    // A view, not a copy: every caller reads the item (toString) synchronously
    // inside this request, and the body buffer outlives the request.
    items.push({ kind: 'data', data: buf.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { items, next: pos };
}

export function pktText(item: PktItem): string | null {
  if (item.kind !== 'data') return null;
  return item.data.toString('utf8');
}

// ------------------------------------------------------------------ pack codec

interface PackEntry {
  type: GitObjectType;
  data: Buffer;
}

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = buf[offset]! & 0x7f;
  let pos = offset + 1;
  let shift = 7;
  while ((buf[offset]! & 0x80) !== 0) {
    value |= (buf[pos]! & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return { value, next: pos };
}

function readOfsVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = buf[offset]! & 0x7f;
  let pos = offset + 1;
  while ((buf[offset]! & 0x80) !== 0) {
    value = ((value + 1) << 7) | (buf[pos]! & 0x7f);
    pos += 1;
  }
  return { value, next: pos };
}

const PACK_TYPE: Readonly<Record<number, GitObjectType | 'ofs' | 'ref'>> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs',
  7: 'ref',
};

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const typeCode = { commit: 1, tree: 2, blob: 3, tag: 4 }[type];
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  let rest = size >> 4;
  if (rest > 0) first |= 0x80;
  bytes.push(first);
  while (rest > 0) {
    let next = rest & 0x7f;
    rest >>= 7;
    if (rest > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

/** A version-2 pack of plain objects, oids sorted so the bytes are deterministic. */
export function writePack(objects: ReadonlyArray<{ oid: string; type: GitObjectType; data: Buffer }>): Buffer {
  const sorted = [...objects].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const header = Buffer.alloc(8);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(sorted.length, 4);
  parts.push(header);
  for (const object of sorted) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

/** Parse a packfile; resolves ofs/ref deltas against pack entries and `repo` objects. */
export function readPack(
  buf: Buffer,
  offset: number,
  repo: Repo,
): { objects: Map<string, PackEntry>; next: number } | { error: string } {
  if (buf.length < offset + 12 || buf.subarray(offset, offset + 4).toString('ascii') !== 'PACK') {
    return { error: 'not a packfile' };
  }
  const version = buf.readUInt32BE(offset + 4);
  if (version !== 2 && version !== 3) return { error: `unsupported pack version ${version}` };
  const count = buf.readUInt32BE(offset + 8);
  let pos = offset + 12;
  const objects = new Map<string, PackEntry>();
  const offsetToOid = new Map<number, string>();
  const pending: Array<{ base: string | number; delta: Buffer; offset: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const start = pos;
    const first = buf[pos]!;
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    pos += 1;
    while ((buf[pos - 1]! & 0x80) !== 0) {
      size |= (buf[pos]! & 0x7f) << shift;
      shift += 7;
      pos += 1;
    }
    const type = PACK_TYPE[typeCode];
    if (type === undefined) return { error: `unknown pack type ${typeCode}` };
    let base: string | number | null = null;
    if (type === 'ofs') {
      const parsed = readOfsVarint(buf, pos);
      base = start - parsed.value;
      pos = parsed.next;
    } else if (type === 'ref') {
      base = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    let inflated: Buffer;
    let consumed: number;
    try {
      // One inflate, and the engine reports exactly how many input bytes the
      // zlib stream consumed (bytesWritten == the stream length, trailing bytes
      // after the stream end are not counted).
      const result = inflateSync(buf.subarray(pos), { info: true }) as unknown as {
        buffer: Buffer;
        engine: { bytesWritten: number };
      };
      inflated = result.buffer;
      consumed = result.engine.bytesWritten;
    } catch {
      return { error: 'zlib inflate failed' };
    }
    if (consumed <= 0) return { error: 'zlib stream length unknown' };
    pos += consumed;
    if (type === 'ofs' || type === 'ref') {
      pending.push({ base: base!, delta: inflated, offset: start });
    } else {
      const oid = hashPackObject(type as GitObjectType, inflated);
      objects.set(oid, { type: type as GitObjectType, data: inflated });
      offsetToOid.set(start, oid);
    }
  }
  // Resolve deltas (a delta's base may be an earlier pack entry or a repo object).
  for (let round = 0; round < pending.length + 1; round += 1) {
    let progressed = false;
    for (const item of pending) {
      if (offsetToOid.has(item.offset)) continue;
      const baseOid = typeof item.base === 'number' ? offsetToOid.get(item.base) : item.base;
      if (baseOid === undefined) continue;
      const baseEntry = objects.get(baseOid) ?? repo.objects.get(baseOid);
      if (!baseEntry) continue;
      const resolved = applyDelta(baseEntry.data, item.delta);
      if (resolved === null) return { error: 'delta apply failed' };
      const oid = hashPackObject(baseEntry.type, resolved);
      if (!objects.has(oid)) objects.set(oid, { type: baseEntry.type, data: resolved });
      offsetToOid.set(item.offset, oid);
      progressed = true;
    }
    if (!progressed) break;
  }
  for (const item of pending) {
    if (!offsetToOid.has(item.offset)) return { error: 'delta base missing (thin pack base not present)' };
  }
  return { objects, next: pos + 20 };
}

function hashPackObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

/** Apply a git delta to a base buffer; null on a malformed delta. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer | null {
  let pos = 0;
  const readDeltaVarint = (): number | null => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) return null;
      const byte = delta[pos]!;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readDeltaVarint();
  const targetSize = readDeltaVarint();
  if (sourceSize === null || targetSize === null || sourceSize !== base.length) return null;
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const opcode = delta[pos]!;
    pos += 1;
    if ((opcode & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((opcode & (1 << i)) !== 0) {
          if (pos >= delta.length) return null;
          offset |= delta[pos]! << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((opcode & (0x10 << i)) !== 0) {
          if (pos >= delta.length) return null;
          size |= delta[pos]! << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) return null;
      out.push(Buffer.from(base.subarray(offset, offset + size)));
      produced += size;
    } else if (opcode !== 0) {
      if (pos + opcode > delta.length) return null;
      out.push(Buffer.from(delta.subarray(pos, pos + opcode)));
      produced += opcode;
      pos += opcode;
    } else {
      return null;
    }
  }
  if (produced !== targetSize) return null;
  return Buffer.concat(out);
}

// ------------------------------------------------------------------ git helpers

interface FetchSelection {
  commits: Set<string>;
  shallow: Set<string>;
  unshallow: Set<string>;
  objects: Map<string, { type: GitObjectType; data: Buffer }>;
}

/** Walk wants down to `depth` (0 = full), excluding what the client already has. */
function selectFetch(store: Store, repo: Repo, wants: string[], haves: string[], shallowLines: string[], depth: number): FetchSelection {
  const commits = new Set<string>();
  const shallow = new Set<string>();
  // Distance-limited walk from each want.
  const queue: Array<{ oid: string; distance: number }> = [];
  for (const want of wants) {
    const peeled = storePeel(repo, want);
    if (peeled !== '') queue.push({ oid: peeled, distance: 0 });
  }
  const included = new Set<string>();
  while (queue.length) {
    const item = queue.shift()!;
    if (included.has(item.oid)) continue;
    const object = repo.objects.get(item.oid);
    if (!object || object.type !== 'commit') continue;
    included.add(item.oid);
    commits.add(item.oid);
    const parents = parseCommit(object.data).parents;
    if (depth > 0 && item.distance + 1 >= depth) {
      // Parents cut off by the depth limit: this commit is shallow.
      if (parents.length > 0) shallow.add(item.oid);
      continue;
    }
    for (const parent of parents) queue.push({ oid: parent, distance: item.distance + 1 });
  }
  // A commit that was shallow before but whose parents are now included is unshallow.
  const unshallow = new Set<string>();
  for (const line of shallowLines) {
    if (!included.has(line)) continue;
    const object = repo.objects.get(line);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0 || parents.every((parent) => included.has(parent))) unshallow.add(line);
  }
  for (const line of unshallow) shallow.delete(line);
  // What the client already holds: the closure of its haves — but never across a
  // shallow boundary. A `shallow` line names a commit the client holds WITHOUT its
  // ancestors (its depth-1 clone), so a have that is also a shallow boundary
  // contributes only itself and its tree, never its parents. Crossing the boundary
  // here would subtract the parent a deepen fetch is supposed to deliver.
  const haveReachable = new Set<string>();
  const addTreeClosureInto = (target: Set<string>, treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length) {
      const oid = stack.pop()!;
      if (target.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      target.add(oid);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      }
    }
  };
  const shallowBoundaries = new Set(shallowLines);
  for (const have of haves) {
    const peeled = storePeel(repo, have);
    if (peeled === '') continue;
    const stack = [peeled];
    const seen = new Set<string>();
    while (stack.length) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object) continue;
      haveReachable.add(oid);
      if (object.type === 'commit') {
        addTreeClosureInto(haveReachable, parseCommit(object.data).tree);
        if (!shallowBoundaries.has(oid)) stack.push(...parseCommit(object.data).parents);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        addTreeClosureInto(haveReachable, oid);
      }
    }
  }
  // Objects: the tree closure of the depth-limited included commits (plus any tag
  // object a want names), minus what the client already has. A full-history walk
  // here would defeat a shallow fetch: depth 1 must carry the tip only, never its
  // parents.
  const send = new Set<string>();
  const addTreeClosure = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length) {
      const oid = stack.pop()!;
      if (send.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      send.add(oid);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      }
    }
  };
  for (const commitOid of commits) {
    send.add(commitOid);
    const object = repo.objects.get(commitOid);
    if (object?.type === 'commit') addTreeClosure(parseCommit(object.data).tree);
  }
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object?.type === 'tag') send.add(want);
  }
  const objects = new Map<string, { type: GitObjectType; data: Buffer }>();
  for (const oid of send) {
    if (haveReachable.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) objects.set(oid, { type: object.type, data: object.data });
  }
  return { commits, shallow, unshallow, objects };
}

function storePeel(repo: Repo, oid: string): string {
  if (!isObjectId(oid)) return '';
  const object = repo.objects.get(oid);
  if (!object) return '';
  if (object.type === 'tag') return storePeel(repo, parseTag(object.data).object);
  return oid;
}

/** Sideband-64k wrap: each chunk becomes one pkt-line starting with the band byte. */
function sideband(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const maxPayload = 65520 - 4 - 1;
  for (let offset = 0; offset < data.length; offset += maxPayload) {
    const chunk = data.subarray(offset, Math.min(offset + maxPayload, data.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ advertisements

interface RefEntry {
  oid: string;
  name: string;
  symrefTarget?: string;
  peeled?: string;
}

/** Every ref in the repo, HEAD first, plus annotated-tag peel targets. */
function allRefs(repo: Repo): RefEntry[] {
  const entries: RefEntry[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '';
  entries.push({
    oid: headTip === '' ? ZERO_OID : headTip,
    name: 'HEAD',
    symrefTarget: `refs/heads/${repo.defaultBranch}`,
  });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: RefEntry = { oid, name };
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') {
      entry.peeled = storePeel(repo, oid);
    }
    entries.push(entry);
  }
  return entries;
}

function advertisementV2(repo: Repo): Buffer {
  const lines = [
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'server-option\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
  ];
  const parts = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
  for (const line of lines) parts.push(pktLine(line));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function advertisementV0(repo: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  const caps = service === 'upload-pack'
    ? 'report-status side-band-64k delete-refs ofs-delta multi_ack_detailed thin-pack no-progress shallow'
    : 'report-status side-band-64k delete-refs ofs-delta';
  const parts = [pktLine(`# service=git-${service}\n`), PKT_FLUSH];
  const refs = allRefs(repo).filter((entry) => entry.name !== 'HEAD');
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps} agent=${AGENT}\n`));
  } else {
    refs.forEach((entry, index) => {
      const suffix = index === 0 ? `\u0000${caps} agent=${AGENT}` : '';
      parts.push(pktLine(`${entry.oid} ${entry.name}${suffix}\n`));
      if (entry.peeled !== undefined) parts.push(pktLine(`${entry.peeled} ${entry.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ ls-refs (v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(items: PktItem[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const item of items) {
    const text = pktText(item);
    if (text === null) continue;
    const line = text.replace(/\n$/, '');
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const cacheKey = JSON.stringify(args);
  const cached = repo.lsCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const parts: Buffer[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '';
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (headTip !== '' && matches('HEAD')) {
    const entry: RefEntry = { oid: headTip, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` };
    parts.push(pktLine(lsRefsLine(entry, args)));
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name)!;
    const entry: RefEntry = { oid, name };
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') entry.peeled = storePeel(repo, oid);
    parts.push(pktLine(lsRefsLine(entry, args)));
  }
  if (headTip === '' && args.unborn) {
    parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  parts.push(PKT_FLUSH);
  const response = Buffer.concat(parts);
  repo.lsCache.set(cacheKey, response);
  return response;
}

function lsRefsLine(entry: RefEntry, args: LsRefsArgs): string {
  let line = `${entry.oid} ${entry.name}`;
  if (args.symrefs && entry.symrefTarget !== undefined) line += ` symref-target:${entry.symrefTarget}`;
  if (args.peel && entry.peeled !== undefined) line += ` peeled:${entry.peeled}`;
  return `${line}\n`;
}

// ------------------------------------------------------------------ fetch (v2 and v0)

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowLines: string[];
  deepen: number;
  thinPack: boolean;
}

function parseFetchArgsV2(items: PktItem[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallowLines: [], deepen: 0, thinPack: false };
  let inArgs = false;
  for (const item of items) {
    if (item.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (item.kind !== 'data') continue;
    const text = item.data.toString('utf8');
    if (!inArgs) continue;
    const line = text.replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallowLines.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7)) || 0;
    else if (line === 'thin-pack') args.thinPack = true;
  }
  return args;
}

function parseFetchArgsV0(items: PktItem[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallowLines: [], deepen: 0, thinPack: false };
  for (const item of items) {
    if (item.kind !== 'data') continue;
    const text = item.data.toString('utf8');
    const line = text.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const space = rest.indexOf(' ');
      const oid = space < 0 ? rest : rest.slice(0, space);
      args.wants.push(oid.trim());
      if (space >= 0) {
        const caps = rest.slice(space + 1);
        if (caps.includes('thin-pack')) args.thinPack = true;
      }
    } else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallowLines.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7)) || 0;
  }
  return args;
}

function fetchResponseV2(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const cacheKey = JSON.stringify(args);
  const cached = repo.packCache.get(`v2:${cacheKey}`);
  if (cached !== undefined) return cached;
  const selection = selectFetch(store, repo, args.wants, args.haves, args.shallowLines, args.deepen);
  const pack = writePack([...selection.objects.entries()].map(([oid, object]) => ({ oid, type: object.type, data: object.data })));
  const parts: Buffer[] = [];
  // The acknowledgments section exists only when the client sent `have` lines:
  // with no haves there is nothing to acknowledge, and real git goes straight to
  // the packfile section (it errors "expected 'packfile', received 'acknowledgments'"
  // when an ack section is sent anyway). The suite's client dispatches sections by
  // name, so omitting it is safe there too.
  if (args.haves.length > 0) {
    const present = args.haves.filter((have) => storePeel(repo, have) !== '');
    parts.push(pktLine('acknowledgments\n'));
    if (present.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const oid of present) parts.push(pktLine(`ACK ${storePeel(repo, oid)}\n`));
      parts.push(pktLine('ready\n'));
    }
    parts.push(PKT_DELIM);
  }
  if (args.deepen > 0 || args.shallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of [...selection.shallow].sort()) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of [...selection.unshallow].sort()) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sideband(pack));
  parts.push(PKT_FLUSH);
  const response = Buffer.concat(parts);
  repo.packCache.set(`v2:${cacheKey}`, response);
  return response;
}

function fetchResponseV0(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const cacheKey = JSON.stringify(args);
  const cached = repo.packCache.get(`v0:${cacheKey}`);
  if (cached !== undefined) return cached;
  const selection = selectFetch(store, repo, args.wants, args.haves, args.shallowLines, args.deepen);
  const pack = writePack([...selection.objects.entries()].map(([oid, object]) => ({ oid, type: object.type, data: object.data })));
  const parts: Buffer[] = [];
  // v0 always opens with an ack line: ACK for every have the server holds, else NAK.
  const present = args.haves.filter((have) => storePeel(repo, have) !== '');
  if (present.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const oid of present) parts.push(pktLine(`ACK ${storePeel(repo, oid)}\n`));
  }
  for (const oid of [...selection.shallow].sort()) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of [...selection.unshallow].sort()) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sideband(pack));
  parts.push(PKT_FLUSH);
  const response = Buffer.concat(parts);
  repo.packCache.set(`v0:${cacheKey}`, response);
  return response;
}

// ------------------------------------------------------------------ receive-pack (v0 push)

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse the command pkt-lines of a receive-pack request; returns commands + pack offset. */
function parsePushCommands(buf: Buffer): { commands: PushCommand[]; packOffset: number } | { error: string } {
  const { items, next } = parsePktLines(buf, 0);
  const commands: PushCommand[] = [];
  for (const item of items) {
    if (item.kind === 'flush') break;
    if (item.kind !== 'data') continue;
    let text = item.data.toString('utf8');
    const nul = text.indexOf('\u0000');
    if (nul >= 0) text = text.slice(0, nul);
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\n?$/.exec(text);
    if (!match) return { error: `bad push command: ${JSON.stringify(text)}` };
    commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }
  return { commands, packOffset: next };
}

function receivePackResponse(repo: Repo, commands: PushCommand[], objects: Map<string, PackEntry>): Buffer {
  // Store every incoming object first (git does the same), then apply ref updates.
  for (const [oid, object] of objects) {
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: object.type, data: object.data });
  }
  const results: string[] = [];
  let changed = false;
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? '';
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === '') {
        results.push(`ng ${command.ref} remote ref does not exist\n`);
      } else {
        repo.refs.delete(command.ref);
        changed = true;
        results.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (current === '') {
      if (command.oldOid !== ZERO_OID) {
        results.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        results.push(`ng ${command.ref} object not found\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      changed = true;
      results.push(`ok ${command.ref}\n`);
      continue;
    }
    if (command.oldOid !== current) {
      results.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    if (command.newOid === current) {
      results.push(`ok ${command.ref}\n`);
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      results.push(`ng ${command.ref} object not found\n`);
      continue;
    }
    if (!isFastForward(repo, current, command.newOid)) {
      results.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    changed = true;
    results.push(`ok ${command.ref}\n`);
  }
  if (changed) {
    repo.version += 1;
    repo.advCache.clear();
    repo.lsCache.clear();
    repo.packCache.clear();
  }
  const report = reportStatusResponse(results);
  return report;
}

/**
 * The report-status response in a single allocation: the report's pkt-lines
 * ('unpack ok' + one per ref + a flush) inside one band-1 sideband frame,
 * plus the terminating flush. Byte-identical to the pktLine/sideband build.
 */
function reportStatusResponse(results: string[]): Buffer {
  const lines = ['unpack ok\n', ...results];
  let innerLen = 4; // the report's own terminating flush
  for (const line of lines) innerLen += 4 + Buffer.byteLength(line);
  const totalLen = 4 + 1 + innerLen + 4; // sideband header + band byte + report + final flush
  const out = Buffer.alloc(totalLen);
  let pos = 0;
  const writeLen = (len: number): void => {
    out.write(len.toString(16).padStart(4, '0'), pos, 4, 'ascii');
    pos += 4;
  };
  writeLen(4 + 1 + innerLen); // the sideband frame's pkt-line length
  out[pos] = 1; // band 1 (progress/data)
  pos += 1;
  for (const line of lines) {
    writeLen(4 + Buffer.byteLength(line));
    pos += out.write(line, pos, 'utf8');
  }
  out.write('0000', pos, 4, 'ascii'); // report flush
  pos += 4;
  out.write('0000', pos, 4, 'ascii'); // final flush
  return out;
}

/** True when `next` descends from `current` (or is a tag pointing at such a commit). */
function isFastForward(repo: Repo, current: string, next: string): boolean {
  const nextCommit = storePeel(repo, next);
  if (nextCommit === '') return false;
  const currentCommit = storePeel(repo, current);
  if (currentCommit === '') return false;
  // Walk next's ancestry looking for current.
  const seen = new Set<string>();
  const stack = [nextCommit];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === currentCommit) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    stack.push(...parseCommit(object.data).parents);
  }
  return false;
}

// ------------------------------------------------------------------ HTTP entry points

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function notFound(message: string): GitHttpResult {
  return {
    status: 404,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ message }), 'utf8'),
  };
}

/** Handle one git smart-HTTP request. `path` is the path after the leading '/'. */
export function handleGit(
  store: Store,
  method: string,
  path: string,
  query: URLSearchParams,
  headers: Readonly<Record<string, string | undefined>>,
  body: Buffer,
): GitHttpResult {
  const match = /^([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!match) return notFound('Not Found');
  const owner = match[1]!;
  const repoName = match[2]!;
  const action = match[3]!;
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound('Not Found');

  if (action === 'info/refs') {
    if (method !== 'GET') return notFound('Not Found');
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      const protocol = (headers['git-protocol'] ?? '').trim();
      if (protocol === 'version=2') {
        const key = 'v2-upload';
        let response = repo.advCache.get(key);
        if (response === undefined) {
          response = advertisementV2(repo);
          repo.advCache.set(key, response);
        }
        return { status: 200, contentType: GIT_CONTENT_TYPES.uploadAdvertisement, body: response };
      }
      const key = 'v0-upload';
      let response = repo.advCache.get(key);
      if (response === undefined) {
        response = advertisementV0(repo, 'upload-pack');
        repo.advCache.set(key, response);
      }
      return { status: 200, contentType: GIT_CONTENT_TYPES.uploadAdvertisement, body: response };
    }
    if (service === 'git-receive-pack') {
      const key = 'v0-receive';
      let response = repo.advCache.get(key);
      if (response === undefined) {
        response = advertisementV0(repo, 'receive-pack');
        repo.advCache.set(key, response);
      }
      return { status: 200, contentType: GIT_CONTENT_TYPES.receiveAdvertisement, body: response };
    }
    return notFound('Not Found');
  }

  if (action === 'git-upload-pack') {
    if (method !== 'POST') return notFound('Not Found');
    const protocol = (headers['git-protocol'] ?? '').trim();
    if (protocol === 'version=2') {
      const { items } = parsePktLines(body, 0);
      const command = items.find((item) => item.kind === 'data')?.data.toString('utf8').replace(/\n$/, '') ?? '';
      if (command === 'command=ls-refs') {
        return { status: 200, contentType: GIT_CONTENT_TYPES.uploadResult, body: lsRefsResponse(repo, parseLsRefsArgs(items)) };
      }
      if (command === 'command=fetch') {
        return { status: 200, contentType: GIT_CONTENT_TYPES.uploadResult, body: fetchResponseV2(store, repo, parseFetchArgsV2(items)) };
      }
      return notFound('Not Found');
    }
    // Protocol v0 fetch.
    const { items } = parsePktLines(body, 0);
    return { status: 200, contentType: GIT_CONTENT_TYPES.uploadResult, body: fetchResponseV0(store, repo, parseFetchArgsV0(items)) };
  }

  // git-receive-pack (v0 only).
  if (method !== 'POST') return notFound('Not Found');
  if (body.length === 0) return notFound('Not Found');
  const parsed = parsePushCommands(body);
  if ('error' in parsed) {
    return {
      status: 400,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ message: parsed.error }), 'utf8'),
    };
  }
  if (parsed.packOffset >= body.length) {
    // Delete-only push: no pack follows.
    return { status: 200, contentType: GIT_CONTENT_TYPES.receiveResult, body: receivePackResponse(repo, parsed.commands, new Map()) };
  }
  const pack = readPack(body, parsed.packOffset, repo);
  if ('error' in pack) {
    return {
      status: 400,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ message: pack.error }), 'utf8'),
    };
  }
  return { status: 200, contentType: GIT_CONTENT_TYPES.receiveResult, body: receivePackResponse(repo, parsed.commands, pack.objects) };
}
