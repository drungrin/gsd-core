'use strict';
/**
 * Credential-free, typed remote Project snapshot reader. Every GraphQL read
 * goes through the injected execGh-compatible seam; malformed transport data
 * becomes a fixed unavailable result rather than raw operator output.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import ghMod = require('./github-sync-gh.cjs');

const REMOTE_REASON = Object.freeze({
  OK: 'ok',
  UNAVAILABLE: 'remote_unavailable',
} as const);

type RemoteReason = typeof REMOTE_REASON[keyof typeof REMOTE_REASON];
type RemoteNode = Record<string, unknown>;

interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  reason: string;
}

interface ReadRemoteSnapshotOptions {
  cwd: string;
  owner: string;
  repo: string;
  repositoryNumber: number;
  projectNumber: number;
  subIssueNumber?: number;
  issueNodeIdHints?: number[];
  execGh?: (args: string[], opts: { cwd?: string }) => GhResult;
}

interface RemoteSnapshot {
  available: boolean;
  reason: RemoteReason;
  target?: { owner: string; repo: string; repositoryNumber: number; projectNumber: number; projectNodeId: string };
  items: RemoteNode[];
  fields: RemoteNode[];
  subIssues: RemoteNode[];
  issueNodeIds?: Record<string, string>;
}

interface Page {
  nodes: RemoteNode[];
  hasNextPage: boolean;
  endCursor: string | null;
}

// D-12/D-13: the project, items, and fields documents are resolved through
// the repository OWNER, not the authenticated viewer. `repositoryOwner(login:)`
// returns the `RepositoryOwner` interface both `User` and `Organization`
// implement; `ProjectV2Owner` is the interface (also implemented by both)
// that carries `projectV2(number:)`, reached here via an inline fragment on
// that interface so one document and one decode path serve both owner kinds.
// A viewer-rooted response no longer decodes to anything (see the matching
// re-rooted decode paths in readProjectNodeId/readRemoteSnapshot below) —
// closing D-13 for every board read this module owns, documents and
// decoders alike (cycle-2 HIGH-H).
const DOCUMENTS = Object.freeze({
  project: 'query($login:String!,$projectNumber:Int!) { # github-sync:project\n repositoryOwner(login:$login) { ... on ProjectV2Owner { projectV2(number:$projectNumber) { id } } } }',
  items: 'query($login:String!,$projectNumber:Int!,$endCursor:String) { # github-sync:items\n repositoryOwner(login:$login) { ... on ProjectV2Owner { projectV2(number:$projectNumber) { items(first:100,after:$endCursor) { nodes { id content { ... on Issue { id number } } } pageInfo { hasNextPage endCursor } } } } } }',
  // ProjectV2.fields.nodes resolves to the ProjectV2FieldConfiguration union
  // (ProjectV2Field | ProjectV2IterationField | ProjectV2SingleSelectField).
  // Scalars can't be selected directly on a union (GitHub rejects it live with
  // selectionMismatch); select through an inline fragment on ProjectV2FieldCommon,
  // the interface every member of the union implements (G-02-7).
  fields: 'query($login:String!,$projectNumber:Int!,$endCursor:String) { # github-sync:fields\n repositoryOwner(login:$login) { ... on ProjectV2Owner { projectV2(number:$projectNumber) { fields(first:100,after:$endCursor) { nodes { ... on ProjectV2FieldCommon { id name } } pageInfo { hasNextPage endCursor } } } } } }',
  subIssues: 'query($owner:String!,$repo:String!,$issueNumber:Int!,$endCursor:String) { # github-sync:subIssues\n repository(owner:$owner,name:$repo) { issue(number:$issueNumber) { subIssues(first:100,after:$endCursor) { nodes { id number } pageInfo { hasNextPage endCursor } } } } }',
  issueId: 'query($owner:String!,$repo:String!,$issueNumber:Int!) { # github-sync:issueId\n repository(owner:$owner,name:$repo) { issue(number:$issueNumber) { id } } }',
});

function unavailable(): RemoteSnapshot {
  return { available: false, reason: REMOTE_REASON.UNAVAILABLE, items: [], fields: [], subIssues: [] };
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function decodePage(result: GhResult, path: string[]): Page | null {
  if (result.exitCode !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const envelope = parsed as { data?: unknown; errors?: unknown };
  if (Array.isArray(envelope.errors) && envelope.errors.length > 0) return null;

  const connection = readPath(envelope.data, path);
  if (connection === null || typeof connection !== 'object') return null;
  const nodes = (connection as { nodes?: unknown }).nodes;
  const pageInfo = (connection as { pageInfo?: unknown }).pageInfo;
  if (!Array.isArray(nodes) || pageInfo === null || typeof pageInfo !== 'object') return null;
  if (!nodes.every((node) => node !== null && typeof node === 'object')) return null;
  const hasNextPage = (pageInfo as { hasNextPage?: unknown }).hasNextPage;
  const endCursor = (pageInfo as { endCursor?: unknown }).endCursor;
  if (typeof hasNextPage !== 'boolean' || (endCursor !== null && typeof endCursor !== 'string')) return null;
  if (hasNextPage && (!endCursor || endCursor.length === 0)) return null;
  return { nodes: nodes as RemoteNode[], hasNextPage, endCursor };
}

function readProjectNodeId(options: ReadRemoteSnapshotOptions): string | null {
  const execGh = options.execGh ?? ghMod.execGh;
  const result = execGh(
    [
      'api', 'graphql', '-f', `query=${DOCUMENTS.project}`,
      // SECURITY: login rides -f (raw) — see the note in readIssueNodeIds.
      '-f', `login=${options.owner}`,
      '-F', `projectNumber=${options.projectNumber}`,
    ],
    { cwd: options.cwd },
  );
  if (result.exitCode !== 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const envelope = parsed as { data?: unknown; errors?: unknown };
  if (Array.isArray(envelope.errors) && envelope.errors.length > 0) return null;
  // D-12/D-13: re-rooted to match the owner-scoped document above — a
  // viewer-rooted response (the pre-generalization shape) resolves to
  // undefined here and correctly decodes to null (cycle-2 HIGH-H).
  const project = readPath(envelope.data, ['repositoryOwner', 'projectV2']);
  if (project === null || typeof project !== 'object') return null;
  const projectNodeId = (project as { id?: unknown }).id;
  return typeof projectNodeId === 'string' && projectNodeId.length > 0 ? projectNodeId : null;
}

function normalizeIssueNodeIdHints(hints: number[] | undefined): number[] {
  if (!Array.isArray(hints)) return [];
  return [...new Set(hints.filter((hint) => Number.isSafeInteger(hint) && hint > 0))].sort((left, right) => left - right);
}

function decodeIssueNodeId(result: GhResult): string | null | undefined {
  if (result.exitCode !== 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const envelope = parsed as { data?: unknown; errors?: unknown };
  if (Array.isArray(envelope.errors) && envelope.errors.length > 0) return undefined;
  const issue = readPath(envelope.data, ['repository', 'issue']);
  if (issue === null) return null;
  if (issue === undefined || typeof issue !== 'object') return undefined;
  const issueNodeId = (issue as { id?: unknown }).id;
  return typeof issueNodeId === 'string' && issueNodeId.length > 0 ? issueNodeId : undefined;
}

function readIssueNodeIds(options: ReadRemoteSnapshotOptions): Record<string, string> | null {
  const hints = normalizeIssueNodeIdHints(options.issueNodeIdHints);
  if (hints.length === 0) return {};

  const execGh = options.execGh ?? ghMod.execGh;
  const issueNodeIds: Record<string, string> = {};
  for (const issueNumber of hints) {
    const result = execGh(
      [
        'api', 'graphql', '-f', `query=${DOCUMENTS.issueId}`,
        // SECURITY: owner/repo are String! variables and MUST use `-f` (raw), never `-F`.
        // `gh`'s typed `-F` flag performs magic value substitution before the request is
        // built: a value starting with `@` is read from a local file (`@-` from stdin) and
        // `{owner}`/`{repo}`/`{branch}` are expanded from the local git repo. Since
        // readSyncTarget validates owner/repo only as non-empty strings (no charset
        // restriction), a `.planning/config.json` carrying `owner: "@/path/to/secret"`
        // would make gh read that file and transmit its contents to api.github.com.
        // `-f` sends the value verbatim. Numeric variables stay on `-F` because they need
        // Int typing and are validated positive safe integers, so neither `@` nor `{` can
        // appear.
        '-f', `owner=${options.owner}`,
        '-f', `repo=${options.repo}`,
        '-F', `issueNumber=${issueNumber}`,
      ],
      { cwd: options.cwd },
    );
    const issueNodeId = decodeIssueNodeId(result);
    if (issueNodeId === undefined) return null;
    if (issueNodeId !== null) issueNodeIds[String(issueNumber)] = issueNodeId;
  }
  return issueNodeIds;
}

function readConnection(
  name: keyof typeof DOCUMENTS,
  path: string[],
  baseArgs: string[],
  options: ReadRemoteSnapshotOptions,
): RemoteNode[] | null {
  const execGh = options.execGh ?? ghMod.execGh;
  const nodes: RemoteNode[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  while (true) {
    const result = execGh(
      ['api', 'graphql', '-f', `query=${DOCUMENTS[name]}`, ...baseArgs, '-f', `endCursor=${cursor ?? ''}`],
      { cwd: options.cwd },
    );
    const page = decodePage(result, path);
    if (!page) return null;
    nodes.push(...page.nodes);
    if (!page.hasNextPage) return nodes;
    if (!page.endCursor || seenCursors.has(page.endCursor)) return null;
    seenCursors.add(page.endCursor);
    cursor = page.endCursor;
  }
}

function collectIssueNumbers(items: RemoteNode[]): number[] | null {
  const numbers = new Set<number>();
  for (const item of items) {
    if (!Object.hasOwn(item, 'content')) return null;
    const content = item.content;
    if (content === null) continue;
    if (typeof content !== 'object' || Array.isArray(content)) return null;
    const number = (content as Record<string, unknown>).number;
    if (number === undefined) continue;
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return null;
    numbers.add(number);
  }
  return [...numbers].sort((left, right) => left - right);
}

function readRemoteSnapshot(options: ReadRemoteSnapshotOptions): RemoteSnapshot {
  const projectNodeId = readProjectNodeId(options);
  if (!projectNodeId) return unavailable();

  const items = readConnection(
    'items',
    ['repositoryOwner', 'projectV2', 'items'],
    // SECURITY: login rides -f (raw) — see the note in readIssueNodeIds.
    // Threaded through baseArgs so every page request carries it, not only
    // the first.
    ['-f', `login=${options.owner}`, '-F', `projectNumber=${options.projectNumber}`],
    options,
  );
  if (!items) return unavailable();

  const fields = readConnection(
    'fields',
    ['repositoryOwner', 'projectV2', 'fields'],
    ['-f', `login=${options.owner}`, '-F', `projectNumber=${options.projectNumber}`],
    options,
  );
  if (!fields) return unavailable();

  const issueNumbers = collectIssueNumbers(items);
  if (!issueNumbers) return unavailable();
  const subIssues: RemoteNode[] = [];
  for (const issueNumber of issueNumbers) {
    const children = readConnection(
      'subIssues',
      ['repository', 'issue', 'subIssues'],
      // SECURITY: owner/repo on `-f` (raw), never `-F` — see the note in readIssueNodeIds.
      ['-f', `owner=${options.owner}`, '-f', `repo=${options.repo}`, '-F', `issueNumber=${issueNumber}`],
      options,
    );
    if (!children) return unavailable();
    subIssues.push(...children.map((child) => ({ ...child, parentIssueNumber: issueNumber })));
  }

  const issueNodeIds = readIssueNodeIds(options);
  if (!issueNodeIds) return unavailable();

  return {
    available: true,
    reason: REMOTE_REASON.OK,
    target: {
      owner: options.owner,
      repo: options.repo,
      repositoryNumber: options.repositoryNumber,
      projectNumber: options.projectNumber,
      projectNodeId,
    },
    items,
    fields,
    subIssues,
    issueNodeIds,
  };
}

export = {
  readRemoteSnapshot,
  REMOTE_REASON,
};
