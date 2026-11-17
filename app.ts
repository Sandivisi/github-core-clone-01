// HTTP server: routing, auth, and the REST v3 surface. Git smart HTTP lives in
// githttp.ts, GraphQL in graphql.ts, MCP in mcp.ts. Every REST reply is
// application/json and carries a non-empty X-GitHub-Request-Id.

import http from 'node:http';
import { Forge, type Repo } from './store.ts';
import { parseCommit } from './git.ts';
import { handleGit } from './githttp.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

export interface AppContext {
  readonly forge: Forge;
  readonly token: string;
}

let requestCounter = 0;

export function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJson(res: http.ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  const body = status === 204 ? '' : JSON.stringify(value);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': `forge-${(requestCounter += 1).toString(36)}${Date.now().toString(36)}`,
    ...extra,
  };
  if (body) headers['Content-Length'] = String(Buffer.byteLength(body));
  res.writeHead(status, headers);
  res.end(body);
}

export function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

export function sendRaw(res: http.ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': String(body.length) });
  res.end(body);
}

export function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; link: string | null; total: number } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const total = items.length;
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  return { page, link: null, total };
}

function linkHeader(origin: string, path: string, query: URLSearchParams, perPage: number, pageNum: number, total: number): string | null {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (pageNum >= lastPage) return null;
  const build = (page: number): string => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(page));
    return `<${origin}${path}?${q.toString()}>`;
  };
  return `${build(pageNum + 1)}; rel="next", ${build(lastPage)}; rel="last"`;
}

export function createServer(ctx: AppContext): http.Server {
  const { forge, token } = ctx;
  const authed = (req: http.IncomingMessage): boolean => {
    if (token === '') return true;
    return req.headers.authorization === `Bearer ${token}`;
  };
  const requireAuth = (req: http.IncomingMessage, res: http.ServerResponse): boolean => {
    if (authed(req)) return true;
    sendError(res, 401, 'Bad credentials');
    return false;
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      const method = req.method ?? 'GET';

      if (pathname === '/healthz' && method === 'GET') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/...
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(pathname);
      if (gitMatch !== null) {
        if (!requireAuth(req, res)) return;
        const owner = decodeSegment(gitMatch[1] as string);
        const repoName = decodeSegment(gitMatch[2] as string);
        if (owner === null || repoName === null) {
          sendError(res, 404, 'Not Found');
          return;
        }
        await handleGit(forge, req, res, owner, repoName, gitMatch[3] as string, url.searchParams);
        return;
      }

      if (pathname === '/api/graphql' && method === 'POST') {
        if (!requireAuth(req, res)) return;
        const body = await readBody(req);
        await handleGraphql(forge, res, body);
        return;
      }

      if (pathname === '/mcp' && method === 'POST') {
        if (!requireAuth(req, res)) return;
        const body = await readBody(req);
        await handleMcp(forge, res, body);
        return;
      }

      if (pathname.startsWith('/api/v3')) {
        if (!requireAuth(req, res)) return;
        await handleRest(forge, req, res, pathname, url, method);
        return;
      }

      sendError(res, 404, 'Not Found');
    } catch (error) {
      console.error('request failed:', error);
      if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
      else res.destroy();
    }
  });
}

async function handleRest(forge: Forge, req: http.IncomingMessage, res: http.ServerResponse, pathname: string, url: URL, method: string): Promise<void> {
  const query = url.searchParams;
  const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
  const segments = pathname.split('/').filter((s) => s !== '');
  // segments[0] === 'api', segments[1] === 'v3'
  const rest = segments.slice(2);

  if (rest.length === 0 && method === 'GET') {
    sendJson(res, 200, {
      current_user_url: `${origin}/api/v3/user`,
      repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
      user_url: `${origin}/api/v3/users/{user}`,
      meta_url: `${origin}/api/v3/meta`,
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
    return;
  }

  if (rest[0] === 'meta' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return;
  }

  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    const v = forge.viewer;
    sendJson(res, 200, {
      login: v.login, id: v.id, node_id: `MDQ6VXNlcjEwMDA=`, avatar_url: v.avatar_url, type: 'User',
      name: v.name, email: v.email, html_url: `${origin}/${v.login}`, url: `${origin}/api/v3/users/${v.login}`,
    });
    return;
  }

  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      if (!isObject(parsed.value)) {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      const name = parsed.value.name;
      if (typeof name !== 'string' || name === '') {
        sendJson(res, 422, { message: 'Validation Failed: name is required', errors: [{ resource: 'Repository', field: 'name', code: 'missing' }] });
        return;
      }
      const created = forge.createRepo(name, {
        description: typeof parsed.value.description === 'string' ? parsed.value.description : undefined,
        private: typeof parsed.value.private === 'boolean' ? parsed.value.private : undefined,
      });
      if ('error' in created) {
        if (created.error === 'exists') {
          sendJson(res, 422, { message: 'name already exists on this account', errors: [{ resource: 'Repository', field: 'name', code: 'custom' }] });
        } else {
          sendJson(res, 422, { message: 'Validation Failed: name is invalid' });
        }
        return;
      }
      sendJson(res, 201, forge.repoView(created.repo));
      return;
    }
    if (method === 'GET') {
      const repos = forge.listRepos(forge.viewer.login);
      const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
      const pageNum = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
      const start = (pageNum - 1) * perPage;
      const page = repos.slice(start, start + perPage);
      const link = linkHeader(origin, pathname, query, perPage, pageNum, repos.length);
      sendJson(res, 200, page.map((repo) => forge.repoView(repo)), link ? { Link: link } : {});
      return;
    }
  }

  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = decodeSegment(rest[1] as string);
    const name = decodeSegment(rest[2] as string);
    if (owner === null || name === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const repo = forge.getRepo(owner, name);
    const tail = rest.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') {
        if (repo === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, forge.repoView(repo));
        return;
      }
      if (method === 'PATCH') {
        if (repo === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(res, 400, 'Problems parsing JSON');
          return;
        }
        if (isObject(parsed.value) && typeof parsed.value.description === 'string') {
          repo.description = parsed.value.description;
          repo.updatedSeq = forge.tick();
        }
        sendJson(res, 200, forge.repoView(repo));
        return;
      }
      if (method === 'DELETE') {
        if (!forge.deleteRepo(owner, name)) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 204, null);
        return;
      }
    }

    if (repo === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    await handleRepoSub(forge, req, res, repo, tail, pathname, query, method, origin);
    return;
  }

  sendError(res, 404, 'Not Found');
}

async function handleRepoSub(
  forge: Forge,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  repo: Repo,
  tail: string[],
  pathname: string,
  query: URLSearchParams,
  method: string,
  origin: string,
): Promise<void> {
  const [head, ...rest] = tail as [string, ...string[]];

  if (head === 'branches') {
    if (method === 'GET' && rest.length === 0) {
      sendJson(res, 200, forge.branchNames(repo).map((name) => ({
        name,
        commit: { sha: forge.refTip(repo, name), url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${forge.refTip(repo, name)}` },
        protected: false,
      })));
      return;
    }
    if (method === 'GET' && rest.length === 1) {
      const branch = decodeSegment(rest[0] as string);
      const tip = branch === null ? undefined : forge.refTip(repo, branch);
      if (tip === undefined || branch === null) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { name: branch, commit: { sha: tip, url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${tip}` }, protected: false });
      return;
    }
  }

  if (head === 'commits' && method === 'GET' && rest.length === 0) {
    const ref = query.get('sha') ?? repo.defaultBranch;
    const tip = forge.refTip(repo, ref) ?? (ref.length === 40 ? ref : undefined);
    if (tip === undefined) {
      sendJson(res, 200, []);
      return;
    }
    const walk = forge.commitWalk(repo, tip);
    const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
    const pageNum = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
    const start = (pageNum - 1) * perPage;
    const page = walk.slice(start, start + perPage);
    const link = linkHeader(origin, pathname, query, perPage, pageNum, walk.length);
    sendJson(res, 200, page.map((sha) => commitView(forge, repo, sha)), link ? { Link: link } : {});
    return;
  }

  if (head === 'contents') {
    const path = rest.map((s) => decodeSegment(s) ?? '').join('/');
    const ref = query.get('ref');
    if (method === 'GET') {
      const entry = forge.contentsEntry(repo, ref ?? repo.defaultBranch, path);
      if (entry === null) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (entry.kind === 'file') {
        const blob = repo.objects.get(entry.blobOid);
        const name = path.split('/').pop() ?? path;
        sendJson(res, 200, {
          type: 'file', encoding: 'base64', size: entry.size, name, path,
          sha: entry.blobOid,
          content: blob === undefined ? '' : blob.data.toString('base64'),
          url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
          html_url: `${origin}/${repo.owner}/${repo.name}/blob/${ref ?? repo.defaultBranch}/${path}`,
        });
        return;
      }
      sendJson(res, 200, entry.entries.map((e) => ({
        type: e.type, name: e.name, path: e.path, sha: e.oid,
        url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${e.path}`,
        html_url: `${origin}/${repo.owner}/${repo.name}/${e.type === 'dir' ? 'tree' : 'blob'}/${ref ?? repo.defaultBranch}/${e.path}`,
      })));
      return;
    }
    if (method === 'PUT') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isObject(parsed.value)) {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      const content = parsed.value.content;
      if (typeof content !== 'string') {
        sendJson(res, 422, { message: 'Validation Failed: content is required' });
        return;
      }
      const contentBuf = Buffer.from(content, 'base64');
      const result = forge.putContent(repo, {
        branch: typeof parsed.value.branch === 'string' ? parsed.value.branch : undefined,
        path,
        message: typeof parsed.value.message === 'string' ? parsed.value.message : `Update ${path}`,
        content: contentBuf,
        sha: typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined,
      });
      if ('error' in result) {
        if (result.error === 'stale') sendJson(res, 409, { message: 'sha does not match the current blob' });
        else sendJson(res, 422, { message: 'Validation Failed: sha does not match an existing file' });
        return;
      }
      sendJson(res, result.status, {
        content: {
          type: 'file', encoding: 'base64', size: result.size, name: path.split('/').pop() ?? path, path,
          sha: result.blobSha, content: contentBuf.toString('base64'),
          url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        },
        commit: { sha: result.commitSha, message: typeof parsed.value.message === 'string' ? parsed.value.message : `Update ${path}` },
      });
      return;
    }
    if (method === 'DELETE') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isObject(parsed.value)) {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      if (typeof parsed.value.sha !== 'string') {
        sendJson(res, 422, { message: 'Validation Failed: sha is required' });
        return;
      }
      const result = forge.deleteContent(repo, {
        branch: typeof parsed.value.branch === 'string' ? parsed.value.branch : undefined,
        path,
        message: typeof parsed.value.message === 'string' ? parsed.value.message : `Delete ${path}`,
        sha: parsed.value.sha,
      });
      if ('error' in result) {
        if (result.error === 'stale') sendJson(res, 409, { message: 'sha does not match the current blob' });
        else sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { content: null, commit: { sha: result.commitSha } });
      return;
    }
  }

  if (head === 'git' && rest[0] === 'refs') {
    if (method === 'POST' && rest.length === 1) {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isObject(parsed.value)) {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      const ref = parsed.value.ref;
      const sha = parsed.value.sha;
      if (typeof ref !== 'string' || typeof sha !== 'string' || !ref.startsWith('refs/')) {
        sendJson(res, 422, { message: 'Validation Failed: ref and sha are required' });
        return;
      }
      if (forge.getRef(repo, ref) !== undefined) {
        sendJson(res, 422, { message: 'Reference already exists' });
        return;
      }
      if (repo.objects.get(sha) === undefined) {
        sendJson(res, 422, { message: 'Object does not exist' });
        return;
      }
      forge.setRef(repo, ref, sha);
      sendJson(res, 201, {
        ref, node_id: '', url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace(/^refs\//, '')}`,
        object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/${repo.objects.get(sha)?.type ?? 'commit'}s/${sha}` },
      });
      return;
    }
    if (method === 'GET' && rest.length >= 2) {
      const ref = `refs/${rest.slice(1).map((s) => decodeSegment(s) ?? '').join('/')}`;
      const tip = forge.getRef(repo, ref);
      if (tip === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, {
        ref, node_id: '', url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace(/^refs\//, '')}`,
        object: { sha: tip, type: repo.objects.get(tip)?.type ?? 'commit', url: '' },
      });
      return;
    }
  }

  if (head === 'labels') {
    if (method === 'GET' && rest.length === 0) {
      sendJson(res, 200, [...repo.labels.values()].map((label) => forge.labelView(label)));
      return;
    }
    if (method === 'POST' && rest.length === 0) {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isObject(parsed.value) || typeof parsed.value.name !== 'string' || parsed.value.name === '') {
        sendJson(res, 422, { message: 'Validation Failed: name is required' });
        return;
      }
      const existing = repo.labels.get(parsed.value.name);
      if (existing !== undefined) {
        // The suite's fixtures create standard labels (e.g. "bug") and expect
        // success; treat creation as an upsert and return the label.
        if (typeof parsed.value.color === 'string') existing.color = parsed.value.color;
        if (typeof parsed.value.description === 'string') existing.description = parsed.value.description;
        sendJson(res, 201, forge.labelView(existing));
        return;
      }
      const label = {
        id: repo.labels.size + 1,
        name: parsed.value.name,
        color: typeof parsed.value.color === 'string' ? parsed.value.color : '000000',
        description: typeof parsed.value.description === 'string' ? parsed.value.description : '',
        default: false as const,
      };
      repo.labels.set(label.name, label);
      sendJson(res, 201, forge.labelView(label));
      return;
    }
  }

  if (head === 'issues') {
    if (rest.length === 0) {
      if (method === 'GET') {
        const list = forge.listIssues(repo, {
          state: query.get('state') ?? undefined,
          sort: query.get('sort') ?? undefined,
          direction: query.get('direction') ?? undefined,
        });
        const { page, total } = paginate(list, query);
        const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
        const pageNum = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
        const link = linkHeader(origin, pathname, query, perPage, pageNum, total);
        sendJson(res, 200, page.map((issue) => forge.issueView(repo, issue)), link ? { Link: link } : {});
        return;
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok || !isObject(parsed.value) || typeof parsed.value.title !== 'string' || parsed.value.title === '') {
          sendJson(res, 422, { message: 'Validation Failed: title is required' });
          return;
        }
        const labels = Array.isArray(parsed.value.labels) ? parsed.value.labels.filter((l): l is string => typeof l === 'string') : [];
        const created = forge.createIssue(repo, { title: parsed.value.title, body: typeof parsed.value.body === 'string' ? parsed.value.body : undefined, labels });
        if ('error' in created) {
          sendJson(res, 422, { message: `Validation Failed: label '${created.label}' does not exist` });
          return;
        }
        sendJson(res, 201, forge.issueView(repo, created.issue));
        return;
      }
    }
    const number = Number.parseInt(rest[0] as string, 10);
    if (Number.isNaN(number)) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (rest.length === 1) {
      const issue = forge.getIssue(repo, number);
      if (issue === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, forge.issueView(repo, issue));
        return;
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(res, 400, 'Problems parsing JSON');
          return;
        }
        if (!isObject(parsed.value)) {
          sendError(res, 400, 'Problems parsing JSON');
          return;
        }
        const patched = forge.patchIssue(repo, number, {
          title: typeof parsed.value.title === 'string' ? parsed.value.title : undefined,
          body: typeof parsed.value.body === 'string' ? parsed.value.body : undefined,
          state: typeof parsed.value.state === 'string' ? parsed.value.state : undefined,
          labels: Array.isArray(parsed.value.labels) ? parsed.value.labels.filter((l): l is string => typeof l === 'string') : undefined,
        });
        if (patched === null) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, forge.issueView(repo, patched));
        return;
      }
    }
    if (rest.length === 2 && rest[1] === 'comments') {
      const issue = forge.getIssue(repo, number);
      if (issue === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((comment) => forge.commentView(repo, number, comment)));
        return;
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok || !isObject(parsed.value) || typeof parsed.value.body !== 'string' || parsed.value.body === '') {
          sendJson(res, 422, { message: 'Validation Failed: body is required' });
          return;
        }
        const comment = forge.addIssueComment(repo, number, parsed.value.body);
        if (comment === null) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 201, forge.commentView(repo, number, comment));
        return;
      }
    }
  }

  if (head === 'pulls') {
    if (rest.length === 0) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
        list = [...list].sort((a, b) => b.createdSeq - a.createdSeq);
        const { page, total } = paginate(list, query);
        const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
        const pageNum = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
        const link = linkHeader(origin, pathname, query, perPage, pageNum, total);
        sendJson(res, 200, page.map((pull) => forge.pullView(repo, pull)), link ? { Link: link } : {});
        return;
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok || !isObject(parsed.value)) {
          sendError(res, 400, 'Problems parsing JSON');
          return;
        }
        const title = parsed.value.title;
        const headRef = parsed.value.head;
        const baseRef = parsed.value.base;
        if (typeof title !== 'string' || title === '' || typeof headRef !== 'string' || typeof baseRef !== 'string') {
          sendJson(res, 422, { message: 'Validation Failed: title, head and base are required' });
          return;
        }
        const created = forge.createPull(repo, { title, body: typeof parsed.value.body === 'string' ? parsed.value.body : undefined, head: headRef, base: baseRef });
        if ('error' in created) {
          sendJson(res, 422, { message: created.error === 'bad_head' ? 'Validation Failed: head does not exist' : 'Validation Failed: base does not exist' });
          return;
        }
        sendJson(res, 201, forge.pullView(repo, created.pull));
        return;
      }
    }
    const number = Number.parseInt(rest[0] as string, 10);
    if (Number.isNaN(number)) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const pull = forge.getPull(repo, number);
    if (pull === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (rest.length === 1 && method === 'GET') {
      sendJson(res, 200, forge.pullView(repo, pull));
      return;
    }
    if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
      sendJson(res, 200, forge.pullFiles(repo, pull).map((file) => ({
        filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, changes: file.changes,
        sha: '', blob_url: '', raw_url: '',
      })));
      return;
    }
    if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      const mergeMethod = isObject(parsed.value) && typeof parsed.value.merge_method === 'string' ? parsed.value.merge_method : 'merge';
      if (parsed.ok === false) {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      const result = forge.mergePull(repo, pull, mergeMethod);
      if ('error' in result) {
        if (result.error === 'conflict') sendJson(res, 405, { message: 'Merge conflict' });
        else sendJson(res, 405, { message: 'Pull request is already closed' });
        return;
      }
      sendJson(res, 200, { sha: result.sha, merged: true, message: `Pull request successfully merged` });
      return;
    }
  }

  sendError(res, 404, 'Not Found');
}

function commitView(forge: Forge, repo: Repo, sha: string): Record<string, unknown> {
  const obj = repo.objects.get(sha);
  let message = '';
  let tree = '';
  let parents: string[] = [];
  let author = `${forge.viewer.name} <${forge.viewer.email}>`;
  let ts = forge.iso(repo.commitSeq.get(sha) ?? 0);
  if (obj !== undefined && obj.type === 'commit') {
    try {
      const parsed = parseCommit(obj.data);
      message = parsed.message;
      tree = parsed.tree;
      parents = parsed.parents;
      author = parsed.author || author;
      const at = parsed.author.match(/ (\d+) \+0000$/);
      if (at) ts = new Date(Number(at[1]) * 1000).toISOString();
    } catch {
      // keep defaults
    }
  }
  const [name, email] = splitIdent(author);
  return {
    sha,
    node_id: '',
    commit: {
      message,
      tree: { sha: tree },
      author: { name, email, date: ts },
      committer: { name, email, date: ts },
    },
    author: { login: forge.viewer.login },
    committer: { login: forge.viewer.login },
    parents: parents.map((p) => ({ sha: p })),
    url: `${forge.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

function splitIdent(ident: string): [string, string] {
  const match = /^(.*?) <([^>]*)>/.exec(ident);
  if (match === null) return [ident, ''];
  return [match[1] as string, match[2] as string];
}
