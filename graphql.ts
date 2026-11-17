// GraphQL v4: a small hand-written parser (operations, variables, aliases,
// fragment spreads, inline fragments, `__type` introspection) over the same
// store the REST surface uses. Unknown fields produce HTTP 200 with an
// `errors` array naming the field, the way GitHub's API does.

import http from 'node:http';
import { Forge, globalId, parseGlobalId, type Issue, type Pull, type Repo } from './store.ts';
import { sendJson } from './app.ts';

// ------------------------------------------------------------ lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc === '/' ? '/' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ------------------------------------------------------------ parser

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

export interface FieldNode {
  readonly kind: 'field';
  readonly name: string;
  readonly alias?: string;
  readonly args: Record<string, ValueNode>;
  readonly selection?: SelectionNode[];
}
export interface FragmentSpreadNode {
  readonly kind: 'spread';
  readonly name: string;
}
export interface InlineFragmentNode {
  readonly kind: 'inline';
  readonly typeCondition?: string;
  readonly selection: SelectionNode[];
}
export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export interface OperationNode {
  readonly type: 'query' | 'mutation';
  readonly name?: string;
  readonly variables: Record<string, { defaultValue?: ValueNode }>;
  readonly selection: SelectionNode[];
}
export interface FragmentNode {
  readonly name: string;
  readonly typeCondition: string;
  readonly selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }
  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }
  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected name');
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}`);
    return token.value;
  }
  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', variables: {}, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        const type = token.value as 'query' | 'mutation';
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value as string;
        const variables = this.parseVariableDefinitions();
        const selection = this.parseSelectionSet();
        operations.push({ type, name, variables, selection });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selection = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selection });
        continue;
      }
      throw new Error('unexpected token in document');
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Record<string, { defaultValue?: ValueNode }> {
    const out: Record<string, { defaultValue?: ValueNode }> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        this.parseType();
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          out[name] = { defaultValue: this.parseValue() };
        } else {
          out[name] = {};
        }
      }
      this.expectPunct(')');
    }
    return out;
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value !== 'on') {
        this.next();
        this.skipDirectives();
        return { kind: 'spread', name: next.value };
      }
      let typeCondition: string | undefined;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
    }
    if (token.kind !== 'name') throw new Error('expected field');
    const first = this.next().value as string;
    let alias: string | undefined;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selection: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selection };
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        args[name] = this.parseValue();
      }
      this.expectPunct(')');
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value');
  }
}

// ------------------------------------------------------------ values

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = resolveValue(value, variables);
  return out;
}

// ------------------------------------------------------------ type info

interface TypeFieldInfo {
  readonly name: string;
  readonly typeName: string;
  readonly typeKind: 'SCALAR' | 'OBJECT' | 'ENUM' | 'NON_NULL' | 'LIST';
  readonly ofType?: TypeFieldInfo;
}

const TYPE_FIELDS: Record<string, TypeFieldInfo[]> = {
  Issue: [
    { name: 'id', typeName: 'ID', typeKind: 'NON_NULL', ofType: { name: 'ID', typeName: 'ID', typeKind: 'SCALAR' } },
    { name: 'number', typeName: 'Int', typeKind: 'NON_NULL', ofType: { name: 'Int', typeName: 'Int', typeKind: 'SCALAR' } },
    { name: 'title', typeName: 'String', typeKind: 'SCALAR' },
    { name: 'state', typeName: 'IssueState', typeKind: 'NON_NULL', ofType: { name: 'IssueState', typeName: 'IssueState', typeKind: 'ENUM' } },
    { name: 'body', typeName: 'String', typeKind: 'SCALAR' },
  ],
  PullRequest: [
    { name: 'id', typeName: 'ID', typeKind: 'NON_NULL', ofType: { name: 'ID', typeName: 'ID', typeKind: 'SCALAR' } },
    { name: 'number', typeName: 'Int', typeKind: 'NON_NULL', ofType: { name: 'Int', typeName: 'Int', typeKind: 'SCALAR' } },
    { name: 'headRefName', typeName: 'String', typeKind: 'SCALAR' },
    { name: 'baseRefName', typeName: 'String', typeKind: 'SCALAR' },
    { name: 'mergeable', typeName: 'MergeableState', typeKind: 'NON_NULL', ofType: { name: 'MergeableState', typeName: 'MergeableState', typeKind: 'ENUM' } },
    { name: 'state', typeName: 'PullRequestState', typeKind: 'NON_NULL', ofType: { name: 'PullRequestState', typeName: 'PullRequestState', typeKind: 'ENUM' } },
    { name: 'merged', typeName: 'Boolean', typeKind: 'NON_NULL', ofType: { name: 'Boolean', typeName: 'Boolean', typeKind: 'SCALAR' } },
    { name: 'files', typeName: 'PullRequestChangedFileConnection', typeKind: 'OBJECT' },
  ],
  Repository: [
    { name: 'id', typeName: 'ID', typeKind: 'NON_NULL', ofType: { name: 'ID', typeName: 'ID', typeKind: 'SCALAR' } },
    { name: 'databaseId', typeName: 'Int', typeKind: 'SCALAR' },
    { name: 'name', typeName: 'String', typeKind: 'NON_NULL', ofType: { name: 'String', typeName: 'String', typeKind: 'SCALAR' } },
    { name: 'nameWithOwner', typeName: 'String', typeKind: 'NON_NULL', ofType: { name: 'String', typeName: 'String', typeKind: 'SCALAR' } },
    { name: 'owner', typeName: 'User', typeKind: 'OBJECT' },
    { name: 'defaultBranchRef', typeName: 'Ref', typeKind: 'OBJECT' },
    { name: 'viewerPermission', typeName: 'RepositoryPermission', typeKind: 'ENUM' },
    { name: 'hasIssuesEnabled', typeName: 'Boolean', typeKind: 'SCALAR' },
    { name: 'issue', typeName: 'Issue', typeKind: 'OBJECT' },
    { name: 'issues', typeName: 'IssueConnection', typeKind: 'OBJECT' },
    { name: 'pullRequests', typeName: 'PullRequestConnection', typeKind: 'OBJECT' },
    { name: 'pullRequest', typeName: 'PullRequest', typeKind: 'OBJECT' },
  ],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'READ', 'TRIAGE', 'WRITE'],
};

// ------------------------------------------------------------ executor

interface GqlObject {
  readonly __typename: string;
  readonly [key: string]: unknown;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function cursorIndex(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match === null ? -1 : Number.parseInt(match[1] as string, 10);
  } catch {
    return -1;
  }
}

interface ConnectionItem {
  readonly node: GqlObject;
}

function paginateConnection(items: readonly ConnectionItem[], args: Record<string, unknown>): GqlObject {
  const first = typeof args.first === 'number' ? args.first : items.length;
  const afterIndex = cursorIndex(args.after);
  const start = afterIndex + 1;
  const sliced = items.slice(start, start + first);
  const endIndex = start + sliced.length - 1;
  return {
    __typename: 'Connection',
    nodes: sliced.map((item) => item.node),
    edges: sliced.map((item, i) => ({ __typename: 'Edge', node: item.node, cursor: cursorFor(start + i) })),
    totalCount: items.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + sliced.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: sliced.length > 0 ? cursorFor(start) : null,
      endCursor: sliced.length > 0 ? cursorFor(endIndex) : null,
    },
  };
}

class Executor {
  readonly errors: Array<{ message: string }> = [];
  private readonly forge: Forge;
  private readonly fragments: Map<string, FragmentNode>;
  private readonly variables: Record<string, unknown>;
  constructor(forge: Forge, fragments: Map<string, FragmentNode>, variables: Record<string, unknown>) {
    this.forge = forge;
    this.fragments = fragments;
    this.variables = variables;
  }

  executeOperation(operation: OperationNode): Record<string, unknown> {
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    return this.executeSelection(rootType, null, operation.selection) as Record<string, unknown>;
  }

  private executeSelection(parentType: string, parent: unknown, selections: readonly SelectionNode[]): Record<string, unknown> | null {
    if (parent === null && parentType !== 'Query' && parentType !== 'Mutation') return null;
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'spread') {
        const fragment = this.fragments.get(selection.name);
        if (fragment === undefined) {
          this.errors.push({ message: `Unknown fragment "${selection.name}".` });
          continue;
        }
        if (fragment.typeCondition !== parentType && !this.typeMatches(fragment.typeCondition, parentType)) continue;
        const nested = this.executeSelection(fragment.typeCondition, parent, fragment.selection);
        if (nested !== null) Object.assign(out, nested);
        continue;
      }
      if (selection.kind === 'inline') {
        if (selection.typeCondition !== undefined && selection.typeCondition !== parentType && !this.typeMatches(selection.typeCondition, parentType)) continue;
        const nested = this.executeSelection(selection.typeCondition ?? parentType, parent, selection.selection);
        if (nested !== null) Object.assign(out, nested);
        continue;
      }
      const key = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[key] = parentType;
        continue;
      }
      const value = this.resolveField(parentType, parent, selection);
      if (selection.selection !== undefined && value !== null && typeof value === 'object') {
        if (Array.isArray(value)) {
          out[key] = value.map((item) => {
            if (item !== null && typeof item === 'object' && '__typename' in item) {
              return this.executeSelection((item as GqlObject).__typename as string, item, selection.selection as SelectionNode[]);
            }
            return item;
          });
        } else {
          const childType = (value as GqlObject).__typename as string;
          if (childType) {
            const nested = this.executeSelection(childType, value, selection.selection);
            out[key] = nested;
          } else {
            out[key] = value;
          }
        }
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  private typeMatches(condition: string, _parentType: string): boolean {
    // Node interface: any concrete type matches a fragment on Node.
    return condition === 'Node';
  }

  private unknownField(parentType: string, field: string): null {
    this.errors.push({ message: `Cannot query field "${field}" on type "${parentType}".` });
    return null;
  }

  private resolveField(parentType: string, parent: unknown, field: FieldNode): unknown {
    const args = argsOf(field, this.variables);
    switch (parentType) {
      case 'Query':
        return this.resolveQuery(field, args);
      case 'Mutation':
        return this.resolveMutation(field, args);
      case 'User':
        return this.resolveUser(parent as GqlObject, field, args);
      case 'Repository':
        return this.resolveRepository(parent as GqlObject, field, args);
      case 'Issue':
        return this.resolveIssue(parent as GqlObject, field, args);
      case 'PullRequest':
        return this.resolvePullRequest(parent as GqlObject, field, args);
      case 'IssueConnection':
      case 'PullRequestConnection':
      case 'PullRequestChangedFileConnection':
      case 'LabelConnection':
      case 'IssueCommentConnection':
        return this.resolveConnection(parent as GqlObject, field, args);
      case 'PageInfo':
      case 'Ref':
      case 'IssueEdge':
      case 'PullRequestEdge':
      case 'PullRequestChangedFile':
      case 'Label':
      case 'IssueComment':
      case 'Commit':
      case '__Field':
      case '__EnumValue':
      case 'CreateIssuePayload':
      case 'CloseIssuePayload':
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload':
      case 'AddCommentPayload':
      case 'CommentEdge':
        return this.resolveLeaf(parent as GqlObject, field, args);
      case '__Type':
        return this.resolveTypeInfo(parent as GqlObject, field, args);
      default:
        return this.unknownField(parentType, field.name);
    }
  }

  private resolveQuery(field: FieldNode, args: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'viewer':
        return { __typename: 'User', login: this.forge.viewer.login, id: this.forge.viewer.id, name: this.forge.viewer.name, email: this.forge.viewer.email };
      case 'repository': {
        const repo = this.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : this.repositoryObject(repo);
      }
      case 'node': {
        const parsed = parseGlobalId(String(args.id ?? ''));
        if (parsed === null) return null;
        if (parsed.kind === 'Repository') {
          const repo = this.forge.getRepoById(Number.parseInt(parsed.key, 10));
          return repo === undefined ? null : this.repositoryObject(repo);
        }
        if (parsed.kind === 'Issue') {
          const [repoId, number] = parsed.key.split(':');
          const repo = this.forge.getRepoById(Number.parseInt(repoId as string, 10));
          const issue = repo === undefined ? undefined : this.forge.getIssue(repo, Number.parseInt(number as string, 10));
          return issue === undefined || repo === undefined ? null : this.issueObject(repo, issue);
        }
        if (parsed.kind === 'PullRequest') {
          const [repoId, number] = parsed.key.split(':');
          const repo = this.forge.getRepoById(Number.parseInt(repoId as string, 10));
          const pull = repo === undefined ? undefined : this.forge.getPull(repo, Number.parseInt(number as string, 10));
          return pull === undefined || repo === undefined ? null : this.pullObject(repo, pull);
        }
        return null;
      }
      case '__type': {
        const name = String(args.name ?? '');
        if (TYPE_FIELDS[name] !== undefined || ENUM_VALUES[name] !== undefined) {
          return { __typename: '__Type', name, kind: ENUM_VALUES[name] !== undefined ? 'ENUM' : 'OBJECT' };
        }
        return null;
      }
      case '__schema':
        return { __typename: '__Schema', queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT' }, mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT' }, types: [] };
      default:
        return this.unknownField('Query', field.name);
    }
  }

  private resolveMutation(field: FieldNode, args: Record<string, unknown>): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    switch (field.name) {
      case 'createIssue': {
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        const repo = parsed?.kind === 'Repository' ? this.forge.getRepoById(Number.parseInt(parsed.key, 10)) : undefined;
        if (repo === undefined) {
          this.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
          return { __typename: 'CreateIssuePayload', issue: null };
        }
        const created = this.forge.createIssue(repo, { title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : undefined });
        if ('error' in created) {
          this.errors.push({ message: `Could not resolve label '${created.label}'.` });
          return { __typename: 'CreateIssuePayload', issue: null };
        }
        return { __typename: 'CreateIssuePayload', issue: this.issueObject(repo, created.issue) };
      }
      case 'closeIssue': {
        const parsed = parseGlobalId(String(input.issueId ?? ''));
        if (parsed?.kind !== 'Issue') {
          this.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
          return { __typename: 'CloseIssuePayload', issue: null };
        }
        const [repoId, number] = parsed.key.split(':');
        const repo = this.forge.getRepoById(Number.parseInt(repoId as string, 10));
        const issue = repo === undefined ? null : this.forge.patchIssue(repo, Number.parseInt(number as string, 10), { state: 'closed' });
        if (issue === null || repo === undefined) {
          this.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
          return { __typename: 'CloseIssuePayload', issue: null };
        }
        return { __typename: 'CloseIssuePayload', issue: this.issueObject(repo, issue) };
      }
      case 'createPullRequest': {
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        const repo = parsed?.kind === 'Repository' ? this.forge.getRepoById(Number.parseInt(parsed.key, 10)) : undefined;
        if (repo === undefined) {
          this.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
          return { __typename: 'CreatePullRequestPayload', pullRequest: null };
        }
        const created = this.forge.createPull(repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : undefined,
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? ''),
        });
        if ('error' in created) {
          this.errors.push({ message: created.error === 'bad_head' ? 'Head ref does not exist.' : 'Base ref does not exist.' });
          return { __typename: 'CreatePullRequestPayload', pullRequest: null };
        }
        return { __typename: 'CreatePullRequestPayload', pullRequest: this.pullObject(repo, created.pull) };
      }
      case 'mergePullRequest': {
        const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
        if (parsed?.kind !== 'PullRequest') {
          this.errors.push({ message: 'Could not resolve to a PullRequest with the provided id.' });
          return { __typename: 'MergePullRequestPayload', pullRequest: null };
        }
        const [repoId, number] = parsed.key.split(':');
        const repo = this.forge.getRepoById(Number.parseInt(repoId as string, 10));
        const pull = repo === undefined ? undefined : this.forge.getPull(repo, Number.parseInt(number as string, 10));
        if (pull === undefined || repo === undefined) {
          this.errors.push({ message: 'Could not resolve to a PullRequest with the provided id.' });
          return { __typename: 'MergePullRequestPayload', pullRequest: null };
        }
        const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
        const result = this.forge.mergePull(repo, pull, method === 'squash' ? 'squash' : method);
        if ('error' in result) {
          this.errors.push({ message: result.error === 'conflict' ? 'Merge conflict.' : 'Pull request is already closed.' });
          return { __typename: 'MergePullRequestPayload', pullRequest: this.pullObject(repo, pull) };
        }
        return { __typename: 'MergePullRequestPayload', pullRequest: this.pullObject(repo, pull) };
      }
      case 'addComment': {
        const parsed = parseGlobalId(String(input.subjectId ?? ''));
        if (parsed?.kind !== 'Issue') {
          this.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
          return { __typename: 'AddCommentPayload', commentEdge: null, subject: null };
        }
        const [repoId, number] = parsed.key.split(':');
        const repo = this.forge.getRepoById(Number.parseInt(repoId as string, 10));
        const comment = repo === undefined ? null : this.forge.addIssueComment(repo, Number.parseInt(number as string, 10), String(input.body ?? ''));
        if (comment === null || repo === undefined) {
          this.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
          return { __typename: 'AddCommentPayload', commentEdge: null, subject: null };
        }
        const issue = this.forge.getIssue(repo, Number.parseInt(number as string, 10)) as Issue;
        return {
          __typename: 'AddCommentPayload',
          commentEdge: { __typename: 'CommentEdge', node: { __typename: 'IssueComment', id: globalId('IssueComment', `${repo.id}:${number}:${comment.id}`), body: comment.body } },
          subject: this.issueObject(repo, issue),
        };
      }
      default:
        return this.unknownField('Mutation', field.name);
    }
  }

  private resolveUser(user: GqlObject, field: FieldNode, _args: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'login':
      case 'name':
      case 'email':
        return user[field.name] ?? null;
      case 'id':
        return globalId('User', String(user.id ?? ''));
      case 'databaseId':
        return user.id ?? null;
      default:
        return this.unknownField('User', field.name);
    }
  }

  private resolveRepository(repoObj: GqlObject, field: FieldNode, args: Record<string, unknown>): unknown {
    const repo = repoObj.__repo as Repo;
    switch (field.name) {
      case 'id':
        return globalId('Repository', String(repo.id));
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return { __typename: 'User', login: this.forge.viewer.login, id: this.forge.viewer.id, name: this.forge.viewer.name, email: this.forge.viewer.email };
      case 'defaultBranchRef': {
        const tip = this.forge.defaultTip(repo);
        return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch, target: { __typename: 'Commit', oid: tip } };
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const issue = this.forge.getIssue(repo, Number(args.number));
        return issue === undefined ? null : this.issueObject(repo, issue);
      }
      case 'issues': {
        let issues = [...repo.issues];
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          issues = issues.filter((issue) => wanted.has(issue.state));
        }
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        if (orderBy !== undefined) {
          const dir = orderBy.direction === 'ASC' ? 1 : -1;
          const keyOf = (issue: Issue): number =>
            orderBy.field === 'UPDATED_AT' ? issue.updatedSeq : orderBy.field === 'COMMENTS' ? issue.comments.length : issue.createdSeq;
          issues.sort((a, b) => {
            const diff = keyOf(a) - keyOf(b);
            if (diff !== 0) return diff * dir;
            return (a.number - b.number) * dir;
          });
        }
        const connection = paginateConnection(issues.map((issue) => ({ node: this.issueObject(repo, issue) })), args);
        connection.__typename = 'IssueConnection';
        return connection;
      }
      case 'pullRequests': {
        let pulls = [...repo.pulls];
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((s) => {
            const upper = String(s).toUpperCase();
            return upper === 'MERGED' ? 'closed' : upper.toLowerCase();
          }));
          pulls = pulls.filter((pull) => wanted.has(pull.state) || (wanted.has('closed') && pull.merged));
        }
        const connection = paginateConnection(pulls.map((pull) => ({ node: this.pullObject(repo, pull) })), args);
        connection.__typename = 'PullRequestConnection';
        return connection;
      }
      case 'pullRequest': {
        const pull = this.forge.getPull(repo, Number(args.number));
        return pull === undefined ? null : this.pullObject(repo, pull);
      }
      default:
        return this.unknownField('Repository', field.name);
    }
  }

  private resolveIssue(issueObj: GqlObject, field: FieldNode, args: Record<string, unknown>): unknown {
    const { repo, issue } = issueObj as unknown as { repo: Repo; issue: Issue };
    switch (field.name) {
      case 'id':
        return globalId('Issue', `${repo.id}:${issue.number}`);
      case 'databaseId':
        return issue.id;
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state.toUpperCase();
      case 'createdAt':
        return this.forge.iso(issue.createdSeq);
      case 'updatedAt':
        return this.forge.iso(issue.updatedSeq);
      case 'closedAt':
        return issue.closedSeq === null ? null : this.forge.iso(issue.closedSeq);
      case 'author':
        return { __typename: 'User', login: this.forge.viewer.login, id: this.forge.viewer.id, name: this.forge.viewer.name, email: this.forge.viewer.email };
      case 'labels': {
        const connection = paginateConnection(issue.labels.map((name) => {
          const label = repo.labels.get(name);
          return { node: { __typename: 'Label', name, color: label?.color ?? '000000', description: label?.description ?? '' } };
        }), args);
        connection.__typename = 'LabelConnection';
        return connection;
      }
      case 'comments': {
        const connection = paginateConnection(issue.comments.map((comment) => ({
          node: { __typename: 'IssueComment', id: globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`), body: comment.body },
        })), args);
        connection.__typename = 'IssueCommentConnection';
        return connection;
      }
      default:
        return this.unknownField('Issue', field.name);
    }
  }

  private resolvePullRequest(pullObj: GqlObject, field: FieldNode, args: Record<string, unknown>): unknown {
    const { repo, pull } = pullObj as unknown as { repo: Repo; pull: Pull };
    switch (field.name) {
      case 'id':
        return globalId('PullRequest', `${repo.id}:${pull.number}`);
      case 'databaseId':
        return pull.id;
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged':
        return pull.merged;
      case 'mergeable':
        return this.forge.pullMergeable(repo, pull);
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'headRefOid':
        return pull.headSha;
      case 'baseRefOid':
        return pull.baseSha;
      case 'mergedAt':
        return pull.mergedSeq === null ? null : this.forge.iso(pull.mergedSeq);
      case 'mergeCommit':
        return pull.mergeSha === null ? null : { __typename: 'Commit', oid: pull.mergeSha };
      case 'createdAt':
        return this.forge.iso(pull.createdSeq);
      case 'updatedAt':
        return this.forge.iso(pull.updatedSeq);
      case 'author':
        return { __typename: 'User', login: this.forge.viewer.login, id: this.forge.viewer.id, name: this.forge.viewer.name, email: this.forge.viewer.email };
      case 'files': {
        const files = this.forge.pullFiles(repo, pull);
        const connection = paginateConnection(files.map((file) => ({
          node: {
            __typename: 'PullRequestChangedFile',
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status.toUpperCase(),
          },
        })), args);
        connection.__typename = 'PullRequestChangedFileConnection';
        return connection;
      }
      default:
        return this.unknownField('PullRequest', field.name);
    }
  }

  private resolveConnection(conn: GqlObject, field: FieldNode, _args: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'nodes':
      case 'edges':
      case 'totalCount':
      case 'pageInfo':
        return conn[field.name] ?? null;
      default:
        return this.unknownField('Connection', field.name);
    }
  }

  private resolveLeaf(obj: GqlObject, field: FieldNode, _args: Record<string, unknown>): unknown {
    if (field.name in obj) return obj[field.name];
    if (field.name === 'cursor') return obj.cursor ?? null;
    if (field.name === 'node') return obj.node ?? null;
    return this.unknownField(obj.__typename, field.name);
  }

  private resolveTypeInfo(typeObj: GqlObject, field: FieldNode, _args: Record<string, unknown>): unknown {
    const name = typeObj.name as string;
    switch (field.name) {
      case 'name':
        return name;
      case 'kind':
        return typeObj.kind as string;
      case 'ofType':
        return (typeObj.ofType as GqlObject | undefined) ?? null;
      case 'description':
        return null;
      case 'fields': {
        const fields = TYPE_FIELDS[name] ?? [];
        return fields.map((f) => ({ __typename: '__Field', name: f.name, type: this.typeRef(f) }));
      }
      case 'enumValues': {
        const values = ENUM_VALUES[name] ?? [];
        return values.map((v) => ({ __typename: '__EnumValue', name: v, description: null }));
      }
      case 'possibleTypes':
      case 'interfaces':
      case 'inputFields':
        return [];
      default:
        return this.unknownField('__Type', field.name);
    }
  }

  private typeRef(field: TypeFieldInfo): GqlObject {
    if (field.ofType !== undefined) {
      return { __typename: '__Type', name: null, kind: field.typeKind, ofType: this.typeRef(field.ofType) };
    }
    return { __typename: '__Type', name: field.typeName, kind: field.typeKind, ofType: null };
  }

  private repositoryObject(repo: Repo): GqlObject {
    return { __typename: 'Repository', __repo: repo };
  }

  private issueObject(repo: Repo, issue: Issue): GqlObject {
    return { __typename: 'Issue', repo, issue };
  }

  private pullObject(repo: Repo, pull: Pull): GqlObject {
    return { __typename: 'PullRequest', repo, pull };
  }
}

// ------------------------------------------------------------ HTTP entry

export async function handleGraphql(forge: Forge, res: http.ServerResponse, body: Buffer): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  const results: unknown[] = [];
  for (const request of requests) {
    results.push(executeOne(forge, request));
  }
  sendJson(res, 200, Array.isArray(parsed) ? results : results[0]);
}

function executeOne(forge: Forge, request: unknown): Record<string, unknown> {
  if (typeof request !== 'object' || request === null) {
    return { errors: [{ message: 'Request must be a JSON object.' }] };
  }
  const query = (request as Record<string, unknown>).query;
  const variables = ((request as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
  if (typeof query !== 'string') {
    return { errors: [{ message: 'Must provide query string.' }] };
  }
  let document: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: `Syntax Error: ${error instanceof Error ? error.message : 'invalid query'}` }] };
  }
  const operationName = (request as Record<string, unknown>).operationName as string | undefined;
  const operation =
    document.operations.find((op) => op.name === operationName) ??
    (operationName === undefined ? document.operations[0] : undefined);
  if (operation === undefined) {
    return { errors: [{ message: `Unknown operation named "${operationName}".` }] };
  }
  const mergedVariables: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(operation.variables)) {
    if (variables[name] !== undefined) mergedVariables[name] = variables[name];
    else if (def.defaultValue !== undefined) mergedVariables[name] = resolveValue(def.defaultValue, variables);
  }
  for (const [name, value] of Object.entries(variables)) if (!(name in mergedVariables)) mergedVariables[name] = value;
  const executor = new Executor(forge, document.fragments, mergedVariables);
  const data = executor.executeOperation(operation);
  const result: Record<string, unknown> = { data };
  if (executor.errors.length > 0) result.errors = executor.errors;
  return result;
}
