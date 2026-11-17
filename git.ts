// Git object model, packfiles and the smart-HTTP framing, implemented from the
// protocol itself: SHA-1 object ids, canonical trees, pkt-lines, pack v2
// (direct objects only, no deltas on the wire out) and pack reading with
// OFS/REF delta resolution for what clients push in.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: { tree: string; parents?: readonly string[]; message: string; author: string; committer: string; timestamp: number }): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`, `committer ${fields.committer} ${fields.timestamp} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Pkt = { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' } | { kind: 'data'; payload: Buffer };

/** Decode a complete pkt-line buffer; trailing bytes that are not a pkt-line are returned as `raw`. */
export function decodePktLines(buf: Buffer): { packets: Pkt[]; raw: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, raw: buf.subarray(offset) };
}

export function pktLinesText(packets: readonly Pkt[]): string[] {
  const out: string[] = [];
  for (const p of packets) if (p.kind === 'data') out.push(p.payload.toString('utf8'));
  return out;
}

// ---------------------------------------------------------------- packfiles

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Pack v2 with direct (non-delta) objects, zlib level 1 for speed. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(TYPE_CODE[object.type], object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = buf[offset] & 0x7f;
  let next = offset + 1;
  let shift = 7;
  while (buf[offset] & 0x80) {
    value |= (buf[next] & 0x7f) << shift;
    shift += 7;
    offset = next;
    next += 1;
  }
  return { value, next };
}

function readOfsVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let byte = buf[offset];
  let next = offset + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[next];
    next += 1;
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { value, next };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const srcSize = readVarint(delta, offset);
  offset = srcSize.next;
  if (srcSize.value !== base.length) throw new Error('delta base size mismatch');
  const dstSize = readVarint(delta, offset);
  offset = dstSize.next;
  const out: Buffer[] = [];
  let total = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) {
        cpOff |= delta[offset] << (i * 8);
        offset += 1;
      }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) {
        cpSize |= delta[offset] << (i * 8);
        offset += 1;
      }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      total += op;
      offset += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== dstSize.value || total !== dstSize.value) throw new Error('delta result size mismatch');
  return result;
}

export interface PackEntry {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

/**
 * Parse a packfile. `lookup` resolves REF_DELTA bases that are not in the pack
 * itself (objects the server already holds). Returns oid -> object.
 */
function adler32(data: Buffer): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  let i = 0;
  while (i < data.length) {
    const chunk = Math.min(data.length - i, 5552);
    const end = i + chunk;
    while (i < end) {
      a += data[i] as number;
      b += a;
      i += 1;
    }
    a %= MOD;
    b %= MOD;
  }
  return (((b << 16) | a) >>> 0) as number;
}

function inflateBounded(pack: Buffer, start: number): { data: Buffer; consumed: number } {
  // inflateSync stops at the end of the deflate stream and ignores trailing
  // bytes, so one call yields the object data. A zlib stream ends with the
  // Adler-32 of its data, so the stream end is where those four bytes sit;
  // a candidate is verified by re-inflating exactly that slice (a coincidental
  // match inside the compressed data fails as truncated). Falls back to a
  // binary search for the minimal successful end if no candidate verifies.
  const data = inflateSync(pack.subarray(start));
  const needle = Buffer.allocUnsafe(4);
  needle.writeUInt32BE(adler32(data), 0);
  let searchFrom = start + 2;
  for (;;) {
    const idx = pack.indexOf(needle, searchFrom);
    if (idx < 0) break;
    const end = idx + 4;
    try {
      const check = inflateSync(pack.subarray(start, end));
      if (check.equals(data)) return { data, consumed: end - start };
    } catch {
      // Truncated candidate: the match was inside the compressed data.
    }
    searchFrom = idx + 1;
  }
  let lo = start + 1;
  let hi = pack.length;
  let best: Buffer | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      best = inflateSync(pack.subarray(start, mid));
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (best === null) throw new Error('deflate stream truncated');
  return { data: best, consumed: lo - start };
}

export function readPack(pack: Buffer, lookup?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  interface RawEntry {
    type: number;
    data: Buffer;
    baseOid?: string;
    baseOffset?: number;
    start: number;
  }
  const raw: RawEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset];
    offset += 1;
    const type = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (type === 6) {
      const ofs = readOfsVarint(pack, offset);
      offset = ofs.next;
      baseOffset = start - ofs.value;
    } else if (type === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateBounded(pack, offset);
    if (inflated.data.length !== size) throw new Error('pack object size mismatch');
    offset += inflated.consumed;
    raw.push({ type, data: inflated.data, baseOid, baseOffset, start });
  }
  const byOffset = new Map<number, RawEntry>();
  for (const entry of raw) byOffset.set(entry.start, entry);
  const result = new Map<string, GitObject>();
  const resolve = (entry: RawEntry): GitObject => {
    if (entry.type === 6 || entry.type === 7) {
      let base: GitObject | undefined;
      if (entry.baseOid !== undefined) {
        base = result.get(entry.baseOid) ?? lookup?.(entry.baseOid);
        if (base === undefined) throw new Error('delta base not found');
      } else if (entry.baseOffset !== undefined) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (baseEntry === undefined) throw new Error('ofs delta base not found');
        base = resolve(baseEntry);
      }
      if (base === undefined) throw new Error('delta base not found');
      const data = applyDelta(base.data, entry.data);
      return { type: base.type, data };
    }
    const type = CODE_TYPE[entry.type];
    if (type === undefined) throw new Error(`unknown pack object type ${entry.type}`);
    return { type, data: entry.data };
  };
  // Resolve repeatedly: REF deltas may point at entries later in the pack.
  let remaining = new Set(raw);
  for (let round = 0; round < count + 2 && remaining.size > 0; round += 1) {
    const next = new Set<RawEntry>();
    for (const entry of remaining) {
      try {
        const obj = resolve(entry);
        result.set(hashObject(obj.type, obj.data), obj);
      } catch {
        next.add(entry);
      }
    }
    if (next.size === remaining.size) break;
    remaining = next;
  }
  if (remaining.size > 0) throw new Error('unresolvable pack deltas');
  return result;
}

// ---------------------------------------------------------------- graph

export type ObjectLookup = (oid: string) => GitObject | undefined;

export function peelToCommit(lookup: ObjectLookup, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 32; i += 1) {
    const obj = lookup(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      try {
        current = parseTag(obj.data).object;
      } catch {
        return null;
      }
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Walk objects reachable from `roots`. With `maxDepth`, stop expanding commits
 * deeper than that many generations from a root (depth 1 = roots only); the
 * roots themselves are always included. `exclude` seeds are treated as already
 * visited (haves).
 */
export function collectReachable(
  lookup: ObjectLookup,
  roots: readonly string[],
  opts: { maxDepth?: number; exclude?: ReadonlySet<string> } = {},
): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const visited = new Set<string>(opts.exclude ?? []);
  const queue: Array<{ oid: string; depth: number }> = roots.map((oid) => ({ oid, depth: 0 }));
  while (queue.length > 0) {
    const { oid, depth } = queue.pop() as { oid: string; depth: number };
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = lookup(oid);
    if (obj === undefined) continue;
    out.set(oid, obj);
    if (opts.maxDepth !== undefined && depth >= opts.maxDepth) continue;
    if (obj.type === 'commit') {
      let view: CommitView;
      try {
        view = parseCommit(obj.data);
      } catch {
        continue;
      }
      queue.push({ oid: view.tree, depth: depth + 1 });
      for (const parent of view.parents) queue.push({ oid: parent, depth: depth + 1 });
    } else if (obj.type === 'tree') {
      let entries: TreeEntry[];
      try {
        entries = parseTree(obj.data);
      } catch {
        continue;
      }
      for (const entry of entries) queue.push({ oid: entry.oid, depth: depth + 1 });
    } else if (obj.type === 'tag') {
      let view: TagView;
      try {
        view = parseTag(obj.data);
      } catch {
        continue;
      }
      queue.push({ oid: view.object, depth: depth + 1 });
    }
  }
  return out;
}

export function isAncestor(lookup: ObjectLookup, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    let view: CommitView;
    try {
      view = parseCommit(obj.data);
    } catch {
      continue;
    }
    for (const parent of view.parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** Flatten a tree (commit oid or tree oid) to path -> {mode, oid}. */
export function flattenTree(lookup: ObjectLookup, rootOid: string): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const walk = (treeOid: string, prefix: string): void => {
    const obj = lookup(treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    let entries: TreeEntry[];
    try {
      entries = parseTree(obj.data);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  if (!rootOid || rootOid === ZERO_OID) return out;
  const root = lookup(rootOid);
  if (root === undefined) return out;
  if (root.type === 'commit') {
    let view: CommitView;
    try {
      view = parseCommit(root.data);
    } catch {
      return out;
    }
    walk(view.tree, '');
  } else if (root.type === 'tree') {
    walk(rootOid, '');
  }
  return out;
}

export interface FileChange {
  readonly path: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly oldOid: string | null;
  readonly newOid: string | null;
}

/** Diff two trees (commit or tree oids). Sorted by path. */
export function diffTrees(lookup: ObjectLookup, oldRoot: string, newRoot: string): FileChange[] {
  const oldMap = flattenTree(lookup, oldRoot);
  const newMap = flattenTree(lookup, newRoot);
  const paths = new Set([...oldMap.keys(), ...newMap.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = oldMap.get(path);
    const newEntry = newMap.get(path);
    if (oldEntry && !newEntry) out.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null });
    else if (!oldEntry && newEntry) out.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
    else if (oldEntry && newEntry && oldEntry.oid !== newEntry.oid) {
      out.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
    }
  }
  return out;
}

/** Merge-base: first common ancestor of two commits (by BFS from both). */
export function mergeBase(lookup: ObjectLookup, a: string, b: string): string | null {
  const seenA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const oid = queueA.pop() as string;
    if (seenA.has(oid)) continue;
    seenA.add(oid);
    const obj = lookup(oid);
    if (obj?.type !== 'commit') continue;
    try {
      queueA.push(...parseCommit(obj.data).parents);
    } catch {
      continue;
    }
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const oid = queueB.pop() as string;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (seenA.has(oid)) return oid;
    const obj = lookup(oid);
    if (obj?.type !== 'commit') continue;
    try {
      queueB.push(...parseCommit(obj.data).parents);
    } catch {
      continue;
    }
  }
  return null;
}
