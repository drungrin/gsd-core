'use strict';
/**
 * Credential-free, typed remote Project snapshot reader. Every GraphQL read
 * goes through the injected execGh-compatible seam; malformed transport data
 * becomes a fixed unavailable result rather than raw operator output.
 */

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
  execGh?: (args: string[], opts: { cwd?: string }) => GhResult;
}

interface RemoteSnapshot {
  available: boolean;
  reason: RemoteReason;
  target?: { owner: string; repo: string; repositoryNumber: number; projectNumber: number };
  items: RemoteNode[];
  fields: RemoteNode[];
  subIssues: RemoteNode[];
}

interface Page {
  nodes: RemoteNode[];
  hasNextPage: boolean;
  endCursor: string | null;
}

const DOCUMENTS = Object.freeze({
  items: 'query($projectNumber:Int!,$endCursor:String) { # github-sync:items\n viewer { projectV2(number:$projectNumber) { items(first:100,after:$endCursor) { nodes { id content { ... on Issue { number } } } pageInfo { hasNextPage endCursor } } } } }',
  fields: 'query($projectNumber:Int!,$endCursor:String) { # github-sync:fields\n viewer { projectV2(number:$projectNumber) { fields(first:100,after:$endCursor) { nodes { id name } pageInfo { hasNextPage endCursor } } } } }',
  subIssues: 'query($owner:String!,$repo:String!,$issueNumber:Int!,$endCursor:String) { # github-sync:subIssues\n repository(owner:$owner,name:$repo) { issue(number:$issueNumber) { subIssues(first:100,after:$endCursor) { nodes { id number } pageInfo { hasNextPage endCursor } } } } }',
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
  return { nodes: nodes as RemoteNode[], hasNextPage, endCursor: endCursor as string | null };
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
  const items = readConnection(
    'items',
    ['viewer', 'projectV2', 'items'],
    ['-F', `projectNumber=${options.projectNumber}`],
    options,
  );
  if (!items) return unavailable();

  const fields = readConnection(
    'fields',
    ['viewer', 'projectV2', 'fields'],
    ['-F', `projectNumber=${options.projectNumber}`],
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
      ['-F', `owner=${options.owner}`, '-F', `repo=${options.repo}`, '-F', `issueNumber=${issueNumber}`],
      options,
    );
    if (!children) return unavailable();
    subIssues.push(...children.map((child) => ({ ...child, parentIssueNumber: issueNumber })));
  }

  return {
    available: true,
    reason: REMOTE_REASON.OK,
    target: {
      owner: options.owner,
      repo: options.repo,
      repositoryNumber: options.repositoryNumber,
      projectNumber: options.projectNumber,
    },
    items,
    fields,
    subIssues,
  };
}

export = {
  readRemoteSnapshot,
  REMOTE_REASON,
};
