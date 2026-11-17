// The forge's in-memory store: repositories, refs, objects, issues, pull
// requests, comments and labels. Everything is deterministic: timestamps come
// from a fixed epoch plus a monotonic sequence, never from the wall clock, so
// repeated runs replay identically.

import {
  buildCommit,
  buildTree,
  collectReachable,
  diffTrees,
  flattenTree,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTree,
  peelToCommit,
  ZERO_OID,
  type FileChange,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';
import { scenarioUsers, type ScenarioIdentity } from './scenario.ts';

export const BASE_TS = 1_700_000_000;

export interface UserView {
  readonly login: string;
  readonly id: number;
  readonly avatar_url: string;
  readonly type: 'User';
  readonly name: string;
  readonly email: string;
}

export interface Label {
  readonly id: number;
  name: string;
  color: string;
  description: string;
  readonly default: boolean;
}

export interface Comment {
  readonly id: number;
  body: string;
  readonly createdSeq: number;
  updatedSeq: number;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly comments: Comment[];
  readonly createdSeq: number;
  updatedSeq: number;
  closedSeq: number | null;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeSha: string | null;
  mergedSeq: number | null;
  readonly comments: Comment[];
  readonly createdSeq: number;
  updatedSeq: number;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  updatedSeq: number;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Issue[];
  readonly pulls: Pull[];
  nextNumber: number;
  /** Monotonic revision: bumped on any object/ref change (cache key). */
  rev: number;
  /** Commit oid -> creation sequence, for newest-first log order. */
  readonly commitSeq: Map<string, number>;
}

export function globalId(kind: string, key: string): string {
  return Buffer.from(`forge:${kind}:${key}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64url').toString('utf8');
    const match = /^forge:([A-Za-z]+):(.+)$/.exec(decoded);
    if (match === null) return null;
    return { kind: match[1] as string, key: match[2] as string };
  } catch {
    return null;
  }
}

const DEFAULT_LABELS: Array<[string, string, string]> = [
  ['bug', 'd73a4a', "Something isn't working"],
  ['documentation', '0075ca', 'Improvements or additions to documentation'],
  ['duplicate', 'cfd3d7', 'This issue or pull request already exists'],
  ['enhancement', 'a2eeef', 'New feature or request'],
  ['good first issue', '7057ff', 'Good for newcomers'],
  ['help wanted', '008672', 'Extra attention is needed'],
  ['invalid', 'e4e669', "This doesn't seem right"],
  ['question', 'd876e3', 'Further information is requested'],
  ['wontfix', 'ffffff', 'This will not be worked on'],
];

export class Forge {
  readonly viewer: UserView;
  readonly teammate: ScenarioIdentity;
  readonly stranger: ScenarioIdentity;
  baseUrl = 'http://127.0.0.1';
  private seq = 0;
  private nextEntityId = 1;
  private nextRepoId = 1;
  private readonly repos = new Map<string, Repo>();
  private readonly reposById = new Map<number, Repo>();

  constructor() {
    const users = scenarioUsers();
    this.viewer = {
      login: users.viewer.login,
      id: users.viewer.id,
      name: users.viewer.name,
      email: users.viewer.email,
      avatar_url: `https://avatars.example.invalid/u/${users.viewer.id}`,
      type: 'User',
    };
    this.teammate = users.teammate;
    this.stranger = users.stranger;
  }

  // ------------------------------------------------------------ clock / ids

  tick(): number {
    this.seq += 1;
    return this.seq;
  }

  iso(seq: number): string {
    return new Date((BASE_TS + seq) * 1000).toISOString();
  }

  private newId(): number {
    const id = this.nextEntityId;
    this.nextEntityId += 1;
    return id;
  }

  // ------------------------------------------------------------ repos

  createRepo(name: string, opts: { description?: string; private?: boolean } = {}): { repo: Repo } | { error: 'exists' | 'invalid' } {
    if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') return { error: 'invalid' };
    const key = `${this.viewer.login}/${name}`;
    if (this.repos.has(key)) return { error: 'exists' };
    const seq = this.tick();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: this.viewer.login,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      createdSeq: seq,
      updatedSeq: seq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      rev: 0,
      commitSeq: new Map(),
    };
    this.nextRepoId += 1;
    for (const [labelName, color, description] of DEFAULT_LABELS) {
      repo.labels.set(labelName, { id: this.newId(), name: labelName, color, description, default: true });
    }
    this.repos.set(key, repo);
    this.reposById.set(repo.id, repo);
    return { repo };
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  getRepoById(id: number): Repo | undefined {
    return this.reposById.get(id);
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = `${owner}/${name}`;
    const repo = this.repos.get(key);
    if (repo === undefined) return false;
    this.repos.delete(key);
    this.reposById.delete(repo.id);
    return true;
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  // ------------------------------------------------------------ objects

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  addObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      repo.rev += 1;
      if (type === 'commit') repo.commitSeq.set(oid, this.tick());
    }
    return oid;
  }

  addObjects(repo: Repo, objects: Map<string, GitObject>): void {
    for (const [oid, obj] of objects) {
      if (!repo.objects.has(oid)) {
        repo.objects.set(oid, { type: obj.type, data: obj.data });
        if (obj.type === 'commit' && !repo.commitSeq.has(oid)) repo.commitSeq.set(oid, this.tick());
      }
    }
    if (objects.size > 0) repo.rev += 1;
  }

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.rev += 1;
  }

  deleteRef(repo: Repo, ref: string): boolean {
    const had = repo.refs.delete(ref);
    if (had) repo.rev += 1;
    return had;
  }

  branchNames(repo: Repo): string[] {
    const names: string[] = [];
    for (const ref of repo.refs.keys()) if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    names.sort();
    return names;
  }

  refTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  defaultTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  /** Commits reachable from `tip`, newest first. */
  commitWalk(repo: Repo, tip: string): string[] {
    const lookup = this.lookup(repo);
    const reachable = collectReachable(lookup, [tip]);
    const commits: string[] = [];
    for (const [oid, obj] of reachable) if (obj.type === 'commit') commits.push(oid);
    commits.sort((a, b) => (repo.commitSeq.get(b) ?? 0) - (repo.commitSeq.get(a) ?? 0));
    return commits;
  }

  // ------------------------------------------------------------ contents

  /** Rebuild the tree for `baseTreeOid` ('' = empty) with `changes` applied. */
  private treeWithChanges(repo: Repo, baseTreeOid: string, changes: Map<string, { mode: string; oid: string } | null>): string {
    const flat = flattenTree(this.lookup(repo), baseTreeOid);
    for (const [path, entry] of changes) {
      if (entry === null) flat.delete(path);
      else flat.set(path, entry);
    }
    // Recursive build: group paths by first segment.
    const buildTreeFromMap = (entries: Array<{ path: string; mode: string; oid: string }>): string => {
      const groups = new Map<string, Array<{ path: string; mode: string; oid: string }>>();
      const files: TreeEntry[] = [];
      for (const entry of entries) {
        const slash = entry.path.indexOf('/');
        if (slash < 0) files.push({ mode: entry.mode, name: entry.path, oid: entry.oid });
        else {
          const dir = entry.path.slice(0, slash);
          const list = groups.get(dir) ?? [];
          list.push({ path: entry.path.slice(slash + 1), mode: entry.mode, oid: entry.oid });
          groups.set(dir, list);
        }
      }
      for (const [dir, list] of groups) {
        files.push({ mode: '40000', name: dir, oid: buildTreeFromMap(list) });
      }
      return this.addObject(repo, 'tree', buildTree(files));
    };
    const entries = [...flat.entries()].map(([path, entry]) => ({ path, mode: entry.mode, oid: entry.oid }));
    return buildTreeFromMap(entries);
  }

  private makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
    const seq = this.tick();
    const author = `${this.viewer.name} <${this.viewer.email}>`;
    const data = buildCommit({ tree: treeOid, parents, message, author, committer: author, timestamp: BASE_TS + seq });
    return this.addObject(repo, 'commit', data);
  }

  /** Entry at `path` under `ref` (branch name or oid). */
  contentsEntry(
    repo: Repo,
    ref: string,
    path: string,
  ): { kind: 'file'; blobOid: string; size: number } | { kind: 'dir'; entries: Array<{ name: string; path: string; oid: string; type: 'file' | 'dir' }> } | null {
    const tip = this.refTip(repo, ref) ?? (isObjectId(ref) ? ref : undefined);
    if (tip === undefined) return null;
    const lookup = this.lookup(repo);
    const commitOid = peelToCommit(lookup, tip);
    if (commitOid === null) return null;
    const commit = lookup(commitOid);
    if (commit === undefined) return null;
    let treeOid: string;
    try {
      treeOid = parseCommit(commit.data).tree;
    } catch {
      return null;
    }
    const clean = path.replace(/^\/+|\/+$/g, '');
    if (clean === '') {
      const entries = this.listTreeDir(repo, treeOid, '');
      return { kind: 'dir', entries };
    }
    const flat = flattenTree(lookup, treeOid);
    const file = flat.get(clean);
    if (file !== undefined) {
      const blob = lookup(file.oid);
      return { kind: 'file', blobOid: file.oid, size: blob?.data.length ?? 0 };
    }
    // Directory?
    const prefix = `${clean}/`;
    let isDir = false;
    for (const key of flat.keys()) if (key.startsWith(prefix)) { isDir = true; break; }
    if (!isDir) return null;
    return { kind: 'dir', entries: this.listTreeDir(repo, treeOid, clean) };
  }

  private listTreeDir(repo: Repo, treeOid: string, dirPath: string): Array<{ name: string; path: string; oid: string; type: 'file' | 'dir' }> {
    const lookup = this.lookup(repo);
    const walkTo = (oid: string, segments: string[]): string | null => {
      if (segments.length === 0) return oid;
      const obj = lookup(oid);
      if (obj === undefined || obj.type !== 'tree') return null;
      let entries: TreeEntry[];
      try {
        entries = parseTree(obj.data);
      } catch {
        return null;
      }
      for (const entry of entries) if (entry.name === segments[0] && entry.mode === '40000') {
        return walkTo(entry.oid, segments.slice(1));
      }
      return null;
    };
    const target = walkTo(treeOid, dirPath === '' ? [] : dirPath.split('/'));
    if (target === null) return [];
    const obj = lookup(target);
    if (obj === undefined || obj.type !== 'tree') return [];
    let entries: TreeEntry[];
    try {
      entries = parseTree(obj.data);
    } catch {
      return [];
    }
    return entries
      .map((entry) => ({
        name: entry.name,
        path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
        oid: entry.oid,
        type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  putContent(
    repo: Repo,
    opts: { branch?: string; path: string; message: string; content: Buffer; sha?: string },
  ): { status: 201 | 200; commitSha: string; blobSha: string; size: number } | { error: 'stale' | 'not_found' | 'missing_sha' } {
    const branch = opts.branch ?? repo.defaultBranch;
    const existingTip = this.refTip(repo, branch);
    let parentTree = '';
    const parents: string[] = [];
    if (existingTip !== undefined) {
      const lookup = this.lookup(repo);
      const commitOid = peelToCommit(lookup, existingTip);
      if (commitOid !== null) {
        parents.push(commitOid);
        const commit = lookup(commitOid);
        if (commit !== undefined) {
          try {
            parentTree = parseCommit(commit.data).tree;
          } catch {
            parentTree = '';
          }
        }
      }
    }
    const clean = opts.path.replace(/^\/+/, '');
    const flat = flattenTree(this.lookup(repo), parentTree);
    const existing = flat.get(clean);
    if (opts.sha !== undefined) {
      if (existing === undefined) return { error: 'missing_sha' };
      if (existing.oid !== opts.sha) return { error: 'stale' };
    }
    const blobSha = this.addObject(repo, 'blob', opts.content);
    const isNew = existing === undefined;
    const treeOid = this.treeWithChanges(repo, parentTree, new Map([[clean, { mode: '100644', oid: blobSha }]]));
    const commitSha = this.makeCommit(repo, treeOid, parents, opts.message);
    this.setRef(repo, `refs/heads/${branch}`, commitSha);
    repo.updatedSeq = this.tick();
    return { status: isNew ? 201 : 200, commitSha, blobSha, size: opts.content.length };
  }

  deleteContent(
    repo: Repo,
    opts: { branch?: string; path: string; message: string; sha: string },
  ): { commitSha: string } | { error: 'stale' | 'not_found' } {
    const branch = opts.branch ?? repo.defaultBranch;
    const tip = this.refTip(repo, branch);
    if (tip === undefined) return { error: 'not_found' };
    const lookup = this.lookup(repo);
    const commitOid = peelToCommit(lookup, tip);
    if (commitOid === null) return { error: 'not_found' };
    const commit = lookup(commitOid);
    if (commit === undefined) return { error: 'not_found' };
    let parentTree = '';
    try {
      parentTree = parseCommit(commit.data).tree;
    } catch {
      return { error: 'not_found' };
    }
    const clean = opts.path.replace(/^\/+/, '');
    const flat = flattenTree(lookup, parentTree);
    const existing = flat.get(clean);
    if (existing === undefined) return { error: 'not_found' };
    if (existing.oid !== opts.sha) return { error: 'stale' };
    const treeOid = this.treeWithChanges(repo, parentTree, new Map([[clean, null]]));
    const commitSha = this.makeCommit(repo, treeOid, [commitOid], opts.message);
    this.setRef(repo, `refs/heads/${branch}`, commitSha);
    repo.updatedSeq = this.tick();
    return { commitSha };
  }

  // ------------------------------------------------------------ issues

  createIssue(repo: Repo, opts: { title: string; body?: string; labels?: string[] }): { issue: Issue } | { error: 'bad_label'; label: string } {
    const labels = opts.labels ?? [];
    for (const label of labels) if (!repo.labels.has(label)) return { error: 'bad_label', label };
    const seq = this.tick();
    const issue: Issue = {
      id: this.newId(),
      number: repo.nextNumber,
      title: opts.title,
      body: opts.body ?? '',
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: seq,
      updatedSeq: seq,
      closedSeq: null,
    };
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return { issue };
  }

  listIssues(repo: Repo, opts: { state?: string; sort?: string; direction?: string }): Issue[] {
    const state = opts.state ?? 'open';
    let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    const sort = opts.sort ?? 'created';
    const dir = opts.direction ?? 'desc';
    const keyOf = (issue: Issue): number => (sort === 'updated' ? issue.updatedSeq : sort === 'comments' ? issue.comments.length : issue.createdSeq);
    list = [...list].sort((a, b) => {
      const diff = keyOf(a) - keyOf(b);
      if (diff !== 0) return dir === 'asc' ? diff : -diff;
      return dir === 'asc' ? a.number - b.number : b.number - a.number;
    });
    return list;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  patchIssue(repo: Repo, number: number, patch: { title?: string; body?: string; state?: string; labels?: string[] }): Issue | null {
    const issue = this.getIssue(repo, number);
    if (issue === undefined) return null;
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.state === 'open' || patch.state === 'closed') {
      issue.state = patch.state;
      issue.closedSeq = patch.state === 'closed' ? this.tick() : null;
    }
    if (patch.labels !== undefined) issue.labels = [...patch.labels];
    issue.updatedSeq = this.tick();
    return issue;
  }

  addIssueComment(repo: Repo, number: number, body: string): Comment | null {
    const issue = this.getIssue(repo, number);
    if (issue === undefined) return null;
    const seq = this.tick();
    const comment: Comment = { id: this.newId(), body, createdSeq: seq, updatedSeq: seq };
    issue.comments.push(comment);
    issue.updatedSeq = seq;
    return comment;
  }

  // ------------------------------------------------------------ pull requests

  createPull(repo: Repo, opts: { title: string; body?: string; head: string; base: string }): { pull: Pull } | { error: 'bad_head' | 'bad_base' } {
    const headTip = this.refTip(repo, opts.head);
    const baseTip = this.refTip(repo, opts.base);
    if (headTip === undefined) return { error: 'bad_head' };
    if (baseTip === undefined) return { error: 'bad_base' };
    const seq = this.tick();
    const pull: Pull = {
      id: this.newId(),
      number: repo.nextNumber,
      title: opts.title,
      body: opts.body ?? '',
      state: 'open',
      merged: false,
      headRef: opts.head,
      baseRef: opts.base,
      headSha: headTip,
      baseSha: baseTip,
      mergeSha: null,
      mergedSeq: null,
      comments: [],
      createdSeq: seq,
      updatedSeq: seq,
    };
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    return { pull };
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const lookup = this.lookup(repo);
    const headCommit = peelToCommit(lookup, pull.headSha);
    const baseCommit = mergeBase(lookup, pull.baseSha, pull.headSha) ?? pull.baseSha;
    if (headCommit === null) return [];
    const changes: FileChange[] = diffTrees(lookup, baseCommit, headCommit);
    return changes.map((change) => {
      let additions = 0;
      let deletions = 0;
      if (change.oldOid !== null && change.newOid !== null) {
        const oldBlob = lookup(change.oldOid);
        const newBlob = lookup(change.newOid);
        if (oldBlob !== undefined && newBlob !== undefined) {
          const counts = lineDiffCounts(oldBlob.data.toString('utf8'), newBlob.data.toString('utf8'));
          additions = counts.additions;
          deletions = counts.deletions;
        }
      } else if (change.newOid !== null) {
        const newBlob = lookup(change.newOid);
        if (newBlob !== undefined) additions = newBlob.data.toString('utf8').split('\n').length;
      } else if (change.oldOid !== null) {
        const oldBlob = lookup(change.oldOid);
        if (oldBlob !== undefined) deletions = oldBlob.data.toString('utf8').split('\n').length;
      }
      return { filename: change.path, status: change.status, additions, deletions, changes: additions + deletions };
    });
  }

  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const lookup = this.lookup(repo);
    const baseTip = this.refTip(repo, pull.baseRef);
    const headTip = this.refTip(repo, pull.headRef);
    if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
    if (pull.state !== 'open') return 'UNKNOWN';
    const baseCommit = peelToCommit(lookup, baseTip);
    const headCommit = peelToCommit(lookup, headTip);
    if (baseCommit === null || headCommit === null) return 'UNKNOWN';
    const base = mergeBase(lookup, baseCommit, headCommit);
    if (base === null) return 'CONFLICTING';
    if (base === headCommit) return 'MERGEABLE';
    const baseChanges = diffTrees(lookup, base, baseCommit);
    const headChanges = diffTrees(lookup, base, headCommit);
    const headMap = new Map(headChanges.map((c) => [c.path, c]));
    for (const change of baseChanges) {
      const other = headMap.get(change.path);
      if (other !== undefined && other.newOid !== change.newOid) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  mergePull(repo: Repo, pull: Pull, method: string): { sha: string } | { error: 'conflict' | 'closed' } {
    if (pull.state !== 'open') return { error: 'closed' };
    const mergeable = this.pullMergeable(repo, pull);
    if (mergeable === 'CONFLICTING') return { error: 'conflict' };
    const lookup = this.lookup(repo);
    const baseTip = this.refTip(repo, pull.baseRef) as string;
    const headTip = this.refTip(repo, pull.headRef) as string;
    const headCommit = peelToCommit(lookup, headTip) as string;
    const headObj = lookup(headCommit);
    let treeOid = '';
    if (headObj !== undefined) {
      try {
        treeOid = parseCommit(headObj.data).tree;
      } catch {
        treeOid = '';
      }
    }
    const seq = this.tick();
    const message = method === 'squash' ? `${pull.title} (#${pull.number})` : `Merge pull request #${pull.number} from ${pull.headRef}`;
    const commitSha = this.makeCommit(repo, treeOid, [baseTip], message);
    this.setRef(repo, `refs/heads/${pull.baseRef}`, commitSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeSha = commitSha;
    pull.mergedSeq = seq;
    pull.updatedSeq = seq;
    repo.updatedSeq = seq;
    return { sha: commitSha };
  }

  // ------------------------------------------------------------ views

  userView(user: { login: string; id: number; avatar_url: string; type: 'User' }): Record<string, unknown> {
    return { login: user.login, id: user.id, avatar_url: user.avatar_url, type: user.type };
  }

  repoView(repo: Repo): Record<string, unknown> {
    const origin = this.baseUrl;
    return {
      id: repo.id,
      node_id: globalId('Repository', String(repo.id)),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: this.userView(this.viewer),
      private: repo.private,
      description: repo.description,
      fork: false,
      created_at: this.iso(repo.createdSeq),
      updated_at: this.iso(repo.updatedSeq),
      pushed_at: this.iso(repo.updatedSeq),
      homepage: null,
      size: 0,
      stargazers_count: 0,
      watchers_count: 0,
      language: null,
      has_issues: true,
      has_projects: true,
      has_downloads: true,
      has_wiki: true,
      has_pages: false,
      default_branch: repo.defaultBranch,
      open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
      url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
      html_url: `${origin}/${repo.owner}/${repo.name}`,
      clone_url: `${origin}/${repo.owner}/${repo.name}.git`,
      git_url: `git://${origin.replace(/^https?:\/\//, '')}/${repo.owner}/${repo.name}.git`,
      ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    };
  }

  issueView(repo: Repo, issue: Issue): Record<string, unknown> {
    const origin = this.baseUrl;
    return {
      id: issue.id,
      node_id: globalId('Issue', `${repo.id}:${issue.number}`),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => {
        const label = repo.labels.get(name);
        return { id: label?.id ?? 0, node_id: globalId('Label', `${repo.id}:${name}`), name, color: label?.color ?? '000000', description: label?.description ?? '', default: label?.default ?? false };
      }),
      user: this.userView(this.viewer),
      assignee: null,
      assignees: [],
      comments: issue.comments.length,
      created_at: this.iso(issue.createdSeq),
      updated_at: this.iso(issue.updatedSeq),
      closed_at: issue.closedSeq === null ? null : this.iso(issue.closedSeq),
      url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
      html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
      comments_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    };
  }

  commentView(repo: Repo, number: number, comment: Comment): Record<string, unknown> {
    const origin = this.baseUrl;
    return {
      id: comment.id,
      node_id: globalId('IssueComment', `${repo.id}:${number}:${comment.id}`),
      body: comment.body,
      user: this.userView(this.viewer),
      created_at: this.iso(comment.createdSeq),
      updated_at: this.iso(comment.updatedSeq),
      url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
      html_url: `${origin}/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
    };
  }

  labelView(label: Label): Record<string, unknown> {
    return { id: label.id, node_id: globalId('Label', String(label.id)), name: label.name, color: label.color, description: label.description, default: label.default };
  }

  pullView(repo: Repo, pull: Pull): Record<string, unknown> {
    const origin = this.baseUrl;
    const mergeable = this.pullMergeable(repo, pull);
    return {
      id: pull.id,
      node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.mergedSeq === null ? null : this.iso(pull.mergedSeq),
      merge_commit_sha: pull.mergeSha,
      mergeable: mergeable === 'MERGEABLE',
      mergeable_state: mergeable === 'MERGEABLE' ? 'clean' : mergeable === 'CONFLICTING' ? 'dirty' : 'unknown',
      draft: false,
      user: this.userView(this.viewer),
      head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha },
      base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha },
      created_at: this.iso(pull.createdSeq),
      updated_at: this.iso(pull.updatedSeq),
      closed_at: pull.state === 'closed' ? this.iso(pull.updatedSeq) : null,
      url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
      html_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    };
  }
}

export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}
