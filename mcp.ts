// MCP over streamable HTTP (era 2026-07-28): server/discover, initialize,
// tools/list and tools/call over the same store as REST. Tool results carry
// both a text JSON payload and structuredContent, so callers that parse either
// shape find the same fields.

import http from 'node:http';
import { Forge, type Repo } from './store.ts';
import { sendJson } from './app.ts';

const PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];
const SERVER_INFO = { name: 'forge', version: '1.0.0' };

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get an issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'integer', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'close_issue',
    description: 'Close an issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'integer', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state filter' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
        merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge method' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

function toolError(message: string): Record<string, unknown> {
  const payload = { error: message };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
}

function missingArg(tool: ToolDef, args: Record<string, unknown>): string | null {
  const required = (tool.inputSchema.required ?? []) as string[];
  for (const field of required) {
    if (args[field] === undefined || args[field] === null || args[field] === '') return field;
  }
  return null;
}

export async function handleMcp(forge: Forge, res: http.ServerResponse, body: Buffer): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    const text = body.toString('utf8');
    const idMatch = /"id"\s*:\s*("[^"]*"|\d+)/.exec(text);
    let id: unknown = null;
    if (idMatch !== null) {
      const raw = idMatch[1] as string;
      id = raw.startsWith('"') ? raw.slice(1, -1) : Number.parseInt(raw, 10);
    }
    sendJson(res, 400, rpcError(id, -32700, 'Parse error'));
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id ?? null;
  const method = request.method;
  const params = (request.params ?? {}) as Record<string, unknown>;
  const isNotification = request.id === undefined;

  if (typeof method !== 'string') {
    sendJson(res, 400, rpcError(id, -32600, 'Invalid Request'));
    return;
  }

  // Notifications get 202 with no body.
  if (isNotification) {
    res.writeHead(202);
    res.end();
    return;
  }

  switch (method) {
    case 'server/discover': {
      sendJson(res, 200, rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        supportedVersions: SUPPORTED_VERSIONS,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      }));
      return;
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
      sendJson(res, 200, rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      }));
      return;
    }
    case 'ping': {
      sendJson(res, 200, rpcResult(id, {}));
      return;
    }
    case 'tools/list': {
      sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
      return;
    }
    case 'tools/call': {
      const name = params.name;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (typeof name !== 'string') {
        sendJson(res, 200, rpcError(id, -32602, 'Tool name is required'));
        return;
      }
      const tool = TOOLS.find((t) => t.name === name);
      if (tool === undefined) {
        sendJson(res, 200, rpcError(id, -32602, `Unknown tool: ${name}`));
        return;
      }
      const missing = missingArg(tool, args);
      if (missing !== null) {
        sendJson(res, 200, rpcResult(id, toolError(`Missing required argument: ${missing}`)));
        return;
      }
      const result = callTool(forge, name, args);
      sendJson(res, 200, rpcResult(id, result));
      return;
    }
    default: {
      sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
      return;
    }
  }
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const owner = String(args.owner ?? '');
  const repoName = String(args.repo ?? '');
  const getRepo = (): Repo | undefined => forge.getRepo(owner, repoName);
  switch (name) {
    case 'create_repo': {
      const created = forge.createRepo(String(args.name ?? ''), {
        description: typeof args.description === 'string' ? args.description : undefined,
        private: typeof args.private === 'boolean' ? args.private : undefined,
      });
      if ('error' in created) {
        return toolError(created.error === 'exists' ? 'name already exists on this account' : 'name is invalid');
      }
      return toolResult(forge.repoView(created.repo));
    }
    case 'get_repo': {
      const repo = getRepo();
      if (repo === undefined) return toolError('Not Found');
      return toolResult(forge.repoView(repo));
    }
    case 'create_issue': {
      const repo = getRepo();
      if (repo === undefined) return toolError('Not Found');
      const labels = Array.isArray(args.labels) ? args.labels.filter((l): l is string => typeof l === 'string') : [];
      const created = forge.createIssue(repo, { title: String(args.title ?? ''), body: typeof args.body === 'string' ? args.body : undefined, labels });
      if ('error' in created) return toolError(`label '${created.label}' does not exist`);
      return toolResult(forge.issueView(repo, created.issue));
    }
    case 'get_issue': {
      const repo = getRepo();
      const number = Number(args.issue_number ?? args.number ?? Number.NaN);
      const issue = repo === undefined ? undefined : forge.getIssue(repo, number);
      if (issue === undefined || repo === undefined) return toolError('Not Found');
      return toolResult(forge.issueView(repo, issue));
    }
    case 'close_issue': {
      const repo = getRepo();
      const number = Number(args.issue_number ?? args.number ?? Number.NaN);
      const issue = repo === undefined ? null : forge.patchIssue(repo, number, { state: 'closed' });
      if (issue === null || repo === undefined) return toolError('Not Found');
      return toolResult(forge.issueView(repo, issue));
    }
    case 'list_issues': {
      const repo = getRepo();
      if (repo === undefined) return toolError('Not Found');
      const list = forge.listIssues(repo, { state: typeof args.state === 'string' ? args.state : 'open' });
      return toolResult(list.map((issue) => forge.issueView(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = getRepo();
      if (repo === undefined) return toolError('Not Found');
      const created = forge.createPull(repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : undefined,
        head: String(args.head ?? ''),
        base: String(args.base ?? ''),
      });
      if ('error' in created) return toolError(created.error === 'bad_head' ? 'head does not exist' : 'base does not exist');
      return toolResult(forge.pullView(repo, created.pull));
    }
    case 'merge_pull_request': {
      const repo = getRepo();
      const number = Number(args.pull_number ?? args.number ?? Number.NaN);
      const pull = repo === undefined ? undefined : forge.getPull(repo, number);
      if (pull === undefined || repo === undefined) return toolError('Not Found');
      const method = typeof args.merge_method === 'string' ? args.merge_method : 'merge';
      const result = forge.mergePull(repo, pull, method);
      if ('error' in result) return toolError(result.error === 'conflict' ? 'Merge conflict' : 'Pull request is already closed');
      return toolResult({ ...forge.pullView(repo, pull), sha: result.sha, merged: true, message: 'Pull request successfully merged' });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}
