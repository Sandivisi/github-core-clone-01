// Git smart HTTP: ref advertisement (v0 and v2), ls-refs, fetch (v0 and v2)
// and receive-pack (v0). The wire shapes follow what the suite's client
// parses: pkt-line framing, sideband band 1 for packfiles, shallow/unshallow
// lines, and the report-status push report.

import http from 'node:http';
import { Forge, type Repo } from './store.ts';
import {
  collectReachable,
  decodePktLines,
  isAncestor,
  isObjectId,
  parseCommit,
  peelToCommit,
  pktLine,
  PKT_DELIM,
  PKT_FLUSH,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
  type ObjectLookup,
} from './git.ts';
import { readBody, sendError, sendRaw } from './app.ts';

const AGENT = 'forge/1.0';
const UPLOAD_CAPS = `side-band-64k thin-pack ofs-delta multi_ack shallow symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

interface FetchPlan {
  readonly acks: string[];
  readonly nak: boolean;
  readonly ready: boolean;
  readonly shallow: string[];
  readonly unshallow: string[];
  readonly objects: Map<string, GitObject>;
}

const packCache = new Map<string, Buffer>();

export async function handleGit(
  forge: Forge,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  owner: string,
  repoName: string,
  servicePath: string,
  query: URLSearchParams,
): Promise<void> {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const method = req.method ?? 'GET';
  if (servicePath === 'info/refs' && method === 'GET') {
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const body = v2 ? v2Advertisement() : v0Advertisement(forge, repo, 'git-upload-pack');
      sendRaw(res, 200, body, 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, v0Advertisement(forge, repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  if (servicePath === 'git-upload-pack' && method === 'POST') {
    const body = await readBody(req);
    const out = handleUploadPack(forge, repo, body);
    if (out === null) {
      sendError(res, 400, 'Bad request');
      return;
    }
    sendRaw(res, 200, out, 'application/x-git-upload-pack-result');
    return;
  }
  if (servicePath === 'git-receive-pack' && method === 'POST') {
    const body = await readBody(req);
    const out = handleReceivePack(forge, repo, body);
    if (out === null) {
      sendError(res, 400, 'Bad request');
      return;
    }
    sendRaw(res, 200, out, 'application/x-git-receive-pack-result');
    return;
  }
  sendError(res, 404, 'Not Found');
}

// ------------------------------------------------------------ advertisements

function allRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function peeledCommit(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined) return null;
  if (obj.type === 'commit') return oid;
  if (obj.type === 'tag') {
    try {
      return peelToCommit(forgeLookup(repo), oid);
    } catch {
      return null;
    }
  }
  return null;
}

function forgeLookup(repo: Repo): ObjectLookup {
  return (oid: string) => repo.objects.get(oid);
}

function v0Advertisement(forge: Forge, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const chunks: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const headTip = forge.refTip(repo, repo.defaultBranch);
  const refs = allRefs(repo);
  const lines: string[] = [];
  if (headTip !== undefined) {
    lines.push(`${headTip} HEAD\u0000${caps}\n`);
  } else {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${caps}\n`);
  }
  for (const ref of refs) {
    lines.push(`${ref.oid} ${ref.name}\n`);
    if (ref.name.startsWith('refs/tags/')) {
      const peeled = peeledCommit(repo, ref.oid);
      if (peeled !== null && peeled !== ref.oid) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  for (const line of lines) chunks.push(pktLine(line));
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

// ------------------------------------------------------------ upload-pack

function handleUploadPack(forge: Forge, repo: Repo, body: Buffer): Buffer | null {
  if (body.length === 0) return null;
  const { packets } = decodePktLines(body);
  const first = packets.find((p) => p.kind === 'data');
  if (first === undefined) return null;
  const firstText = first.payload.toString('utf8');
  if (firstText.startsWith('command=')) {
    const command = firstText.slice('command='.length).replace(/\n$/, '');
    if (command === 'ls-refs') return handleLsRefs(forge, repo, packets);
    if (command === 'fetch') return handleFetchV2(forge, repo, packets);
    return null;
  }
  return handleFetchV0(forge, repo, packets, body);
}

function v2Args(packets: ReturnType<typeof decodePktLines>['packets']): string[] {
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind === 'data' && afterDelim) args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return args;
}

function handleLsRefs(forge: Forge, repo: Repo, packets: ReturnType<typeof decodePktLines>['packets']): Buffer {
  const args = v2Args(packets);
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const chunks: Buffer[] = [];
  const headTip = forge.refTip(repo, repo.defaultBranch);
  const headMatches = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p) || p.startsWith('HEAD'));
  if (headMatches) {
    if (headTip !== undefined) {
      chunks.push(pktLine(symrefs ? `${headTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `${headTip} HEAD\n`));
    } else if (unborn) {
      chunks.push(pktLine(symrefs ? `unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : 'unborn HEAD\n'));
    }
  }
  for (const ref of allRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.name.startsWith('refs/tags/')) {
      const peeled = peeledCommit(repo, ref.oid);
      if (peeled !== null && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    chunks.push(pktLine(`${line}\n`));
  }
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

function planFetch(forge: Forge, repo: Repo, wants: string[], haves: string[], shallowBoundaries: string[], depth: number | null): FetchPlan {
  const lookup = forgeLookup(repo);
  // Commit generations reachable from the wants.
  const commitGen = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [];
  const wantCommits: string[] = [];
  for (const want of wants) {
    const commit = peelToCommit(lookup, want);
    if (commit !== null) {
      wantCommits.push(commit);
      if (!commitGen.has(commit)) queue.push({ oid: commit, gen: 0 });
    }
  }
  const includedObjects = new Map<string, GitObject>();
  const includeReachable = (roots: readonly string[]): void => {
    for (const [oid, obj] of collectReachable(lookup, roots)) includedObjects.set(oid, obj);
  };
  while (queue.length > 0) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    if (commitGen.has(oid)) continue;
    commitGen.set(oid, gen);
    const obj = lookup(oid);
    if (obj === undefined) continue;
    includedObjects.set(oid, obj);
    // The want's own tree/blobs (and tag objects) are always included.
    if (obj.type === 'commit') {
      let view;
      try {
        view = parseCommit(obj.data);
      } catch {
        continue;
      }
      includeReachable([view.tree]);
      if (depth === null || gen + 1 < depth) {
        for (const parent of view.parents) if (!commitGen.has(parent)) queue.push({ oid: parent, gen: gen + 1 });
      }
    }
  }
  // Tag objects named by the wants themselves.
  for (const want of wants) {
    const obj = lookup(want);
    if (obj !== undefined && obj.type === 'tag') includedObjects.set(want, obj);
  }
  // Shallow boundaries: deepest included commits that still have parents.
  const shallow: string[] = [];
  if (depth !== null) {
    for (const [oid, gen] of commitGen) {
      if (gen !== depth - 1) continue;
      const obj = lookup(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      let parents: string[] = [];
      try {
        parents = parseCommit(obj.data).parents;
      } catch {
        parents = [];
      }
      if (parents.length > 0) shallow.push(oid);
    }
    shallow.sort();
  }
  const shallowSet = new Set(shallow);
  const unshallow = shallowBoundaries.filter((b) => commitGen.has(b) && !shallowSet.has(b)).sort();

  // Exclusion: everything reachable from a have, except that a shallow
  // boundary have does not pull in its own parents (deepen case).
  const boundarySet = new Set(shallowBoundaries);
  const exclude = new Set<string>();
  for (const have of haves) {
    if (boundarySet.has(have)) {
      const obj = lookup(have);
      if (obj === undefined) continue;
      exclude.add(have);
      if (obj.type === 'commit') {
        try {
          includeReachableInto(exclude, lookup, [parseCommit(obj.data).tree]);
        } catch {
          // ignore
        }
      }
    } else {
      for (const oid of collectReachable(lookup, [have]).keys()) exclude.add(oid);
    }
  }
  const objects = new Map<string, GitObject>();
  for (const [oid, obj] of includedObjects) if (!exclude.has(oid)) objects.set(oid, obj);

  // Negotiation: ACK the haves that are ancestors of (or equal to) a want.
  const acks: string[] = [];
  let ready = false;
  let nak = false;
  if (haves.length === 0) {
    nak = true;
  } else {
    for (const have of haves) {
      const haveCommit = peelToCommit(lookup, have);
      if (haveCommit === null) continue;
      if (wantCommits.some((want) => isAncestor(lookup, haveCommit, want))) acks.push(have);
    }
    if (acks.length > 0) ready = true;
    else nak = true;
  }
  return { acks, nak, ready, shallow, unshallow, objects };
}

function includeReachableInto(target: Set<string>, lookup: ObjectLookup, roots: readonly string[]): void {
  for (const oid of collectReachable(lookup, roots).keys()) target.add(oid);
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

function packFor(forge: Forge, repo: Repo, plan: FetchPlan, key: string): Buffer | null {
  if (plan.objects.size === 0) return null;
  const cached = packCache.get(key);
  if (cached !== undefined) return cached;
  const sorted = [...plan.objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const pack = writePack(sorted.map(([, obj]) => obj));
  if (packCache.size > 32) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

import { hashObject } from './git.ts';
function hashOf(obj: GitObject): string {
  return hashObject(obj.type, obj.data);
}

function handleFetchV2(forge: Forge, repo: Repo, packets: ReturnType<typeof decodePktLines>['packets']): Buffer | null {
  const args = v2Args(packets);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowBoundaries.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isNaN(n)) return null;
      depth = n;
    }
  }
  if (wants.length === 0) return null;
  if (wants.some((w) => !isObjectId(w)) || haves.some((h) => !isObjectId(h))) return null;
  const plan = planFetch(forge, repo, wants, haves, shallowBoundaries, depth);
  const key = `${repo.id}|${repo.rev}|${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${[...shallowBoundaries].sort().join(',')}|${depth ?? ''}`;
  const pack = packFor(forge, repo, plan, key);
  const chunks: Buffer[] = [];
  chunks.push(pktLine('acknowledgments\n'));
  if (plan.nak) chunks.push(pktLine('NAK\n'));
  else {
    for (const ack of plan.acks) chunks.push(pktLine(`ACK ${ack}\n`));
    if (plan.ready) chunks.push(pktLine('ready\n'));
  }
  chunks.push(PKT_DELIM);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    chunks.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) chunks.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
    chunks.push(PKT_DELIM);
  }
  if (pack !== null) {
    chunks.push(pktLine('packfile\n'));
    chunks.push(...sidebandPackets(pack));
  }
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

function handleFetchV0(forge: Forge, repo: Repo, packets: ReturnType<typeof decodePktLines>['packets'], _body: Buffer): Buffer | null {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const space = rest.indexOf(' ');
        wants.push(space < 0 ? rest : rest.slice(0, space));
      } else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isNaN(n)) return null;
        depth = n;
      }
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    }
  }
  if (wants.length === 0) return null;
  if (wants.some((w) => !isObjectId(w)) || haves.some((h) => !isObjectId(h))) return null;
  const plan = planFetch(forge, repo, wants, haves, shallowBoundaries, depth);
  const key = `${repo.id}|${repo.rev}|${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${[...shallowBoundaries].sort().join(',')}|${depth ?? ''}`;
  const pack = packFor(forge, repo, plan, key);
  const chunks: Buffer[] = [];
  if (plan.nak) chunks.push(pktLine('NAK\n'));
  else {
    for (const ack of plan.acks) chunks.push(pktLine(`ACK ${ack}\n`));
  }
  for (const oid of plan.shallow) chunks.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
  if (pack !== null) chunks.push(...sidebandPackets(pack));
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------ receive-pack

function handleReceivePack(forge: Forge, repo: Repo, body: Buffer): Buffer | null {
  const { packets, raw } = decodePktLines(body);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\u0000');
    const line = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length !== 3) return null;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) return null;
    commands.push({ oldOid, newOid, ref });
  }
  if (!sawFlush || commands.length === 0) return null;
  const lookup = forgeLookup(repo);
  const report: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  if (needsPack) {
    if (raw.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      try {
        const objects = readPack(raw, lookup);
        forge.addObjects(repo, objects);
      } catch {
        unpackOk = false;
        unpackDetail = 'unpacker error';
      }
    }
  }
  if (unpackOk) {
    for (const command of commands) {
      const current = forge.getRef(repo, command.ref);
      const currentOid = current ?? ZERO_OID;
      if (command.oldOid !== currentOid) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      if (command.newOid === ZERO_OID) {
        forge.deleteRef(repo, command.ref);
        report.push(`ok ${command.ref}\n`);
        continue;
      }
      if (lookup(command.newOid) === undefined) {
        report.push(`ng ${command.ref} object not found\n`);
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        forge.setRef(repo, command.ref, command.newOid);
        report.push(`ok ${command.ref}\n`);
        continue;
      }
      const oldCommit = peelToCommit(lookup, command.oldOid);
      const newCommit = peelToCommit(lookup, command.newOid);
      if (oldCommit === null || newCommit === null || !isAncestor(lookup, oldCommit, newCommit)) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      forge.setRef(repo, command.ref, command.newOid);
      report.push(`ok ${command.ref}\n`);
    }
  } else {
    for (const command of commands) report.push(`ng ${command.ref} unpacker error\n`);
  }
  // The report-status stream is itself pkt-lined inside sideband band 1.
  const reportLines = Buffer.concat([
    pktLine(`unpack ${unpackDetail}\n`),
    ...report.map((line) => pktLine(line)),
  ]);
  const outer = pktLine(Buffer.concat([Buffer.from([1]), reportLines]));
  return Buffer.concat([outer, PKT_FLUSH]);
}
