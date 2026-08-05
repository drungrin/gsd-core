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
  // Plan 07-10 (D-01/D-05 gap closure): the project itself resolved to a
  // confirmed, explicit absence — `data.repositoryOwner.projectV2: null`
  // decoded alongside an exclusively NOT_FOUND-typed `errors` array (or none
  // at all). Distinct from the plain UNAVAILABLE default, which still means
  // "the read failed" (a FORBIDDEN/rate-limit error, a malformed body, a
  // decode mismatch) — never evidence of deletion. `items`/`fields`/
  // `subIssues` genuinely were not read either way; `available` stays false
  // for both reasons.
  PROJECT_ABSENT: 'project_absent',
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
  // Plan 07-12 (WINDOWS #10 gap closure): the Issue fragment also selects
  // the bound issue's own repository identity (owner login + repository
  // name) — a Project v2 item's `content` silently follows its issue across
  // a repository transfer while the item's own id and board membership stay
  // unchanged (07-LIVE-RECOVERY.md), so `bindingOnBoard`'s item-presence
  // check alone can no longer tell a converged item from a drifted one.
  // This identity is the input `github-sync-reconcile.cts`'s new drift
  // comparison needs to detect that case.
  items: 'query($login:String!,$projectNumber:Int!,$endCursor:String) { # github-sync:items\n repositoryOwner(login:$login) { ... on ProjectV2Owner { projectV2(number:$projectNumber) { items(first:100,after:$endCursor) { nodes { id content { ... on Issue { id number repository { owner { login } name } } } } pageInfo { hasNextPage endCursor } } } } } }',
  // ProjectV2.fields.nodes resolves to the ProjectV2FieldConfiguration union
  // (ProjectV2Field | ProjectV2IterationField | ProjectV2SingleSelectField).
  // Scalars can't be selected directly on a union (GitHub rejects it live with
  // selectionMismatch); select through an inline fragment on ProjectV2FieldCommon,
  // the interface every member of the union implements (G-02-7).
  fields: 'query($login:String!,$projectNumber:Int!,$endCursor:String) { # github-sync:fields\n repositoryOwner(login:$login) { ... on ProjectV2Owner { projectV2(number:$projectNumber) { fields(first:100,after:$endCursor) { nodes { ... on ProjectV2FieldCommon { id name } } pageInfo { hasNextPage endCursor } } } } } }',
  subIssues: 'query($owner:String!,$repo:String!,$issueNumber:Int!,$endCursor:String) { # github-sync:subIssues\n repository(owner:$owner,name:$repo) { issue(number:$issueNumber) { subIssues(first:100,after:$endCursor) { nodes { id number } pageInfo { hasNextPage endCursor } } } } }',
  issueId: 'query($owner:String!,$repo:String!,$issueNumber:Int!) { # github-sync:issueId\n repository(owner:$owner,name:$repo) { issue(number:$issueNumber) { id } } }',
});

function unavailable(reason: RemoteReason = REMOTE_REASON.UNAVAILABLE): RemoteSnapshot {
  return { available: false, reason, items: [], fields: [], subIssues: [] };
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Strictly narrower than `isNotFoundOnlyErrors` below: requires an explicit,
 * non-empty, NOT_FOUND-only `errors` array, never treating an ABSENT/empty
 * `errors` array as equivalent. `decodePage` (below) needs this stricter
 * gate — unlike `decodeIssueNodeId`'s single-field `issue: null` case, an
 * unexpectedly-shaped response (e.g. the pre-generalization viewer-rooted
 * form the HIGH-H regression test pins) also decodes its target `path` to
 * `undefined` with ZERO errors, and that case must keep failing closed as a
 * genuine decode mismatch, not be reinterpreted as "confirmed empty."
 */
function hasExplicitNotFoundError(errors: unknown): boolean {
  return Array.isArray(errors) && errors.length > 0 && errors.every((entry) => (
    entry !== null && typeof entry === 'object' && (entry as { type?: unknown }).type === 'NOT_FOUND'
  ));
}

/**
 * Plan 07-12 (WINDOWS #10 gap closure): validates the widened `items`
 * document's per-item content repository identity shape. Only a PRESENT
 * `repository` sub-object is validated — its absence is tolerated (a node
 * whose content is not an Issue at all, or any fixture/response predating
 * this plan's widening, never carries the key), so this check is purely
 * additive and never a new failure mode for a shape that never requested
 * the field. A PRESENT but malformed `repository` (a non-object value, a
 * missing/empty/non-string `name`, a non-object `owner`, or a missing/
 * empty/non-string `owner.login`) fails the PAGE closed rather than
 * decoding to a partial identity — the same fail-closed contract
 * `collectIssueNumbers` below already holds for `content.number`, extended
 * to the sibling field this plan adds beside it. Meaningful only for the
 * `items` document: `fields`/`subIssues` nodes carry no `content` key at
 * all, so this check is a no-op for them (`Object.hasOwn` skips every node).
 */
function hasValidContentRepositoryShape(nodes: RemoteNode[]): boolean {
  for (const node of nodes) {
    if (!Object.hasOwn(node, 'content')) continue;
    const content = node.content;
    if (content === null || typeof content !== 'object' || Array.isArray(content)) continue;
    const contentObj = content as Record<string, unknown>;
    if (!Object.hasOwn(contentObj, 'repository')) continue;
    const repository = contentObj.repository;
    if (repository === null || typeof repository !== 'object' || Array.isArray(repository)) return false;
    const repoObj = repository as Record<string, unknown>;
    if (typeof repoObj.name !== 'string' || repoObj.name.length === 0) return false;
    const owner = repoObj.owner;
    if (owner === null || typeof owner !== 'object' || Array.isArray(owner)) return false;
    const login = (owner as Record<string, unknown>).login;
    if (typeof login !== 'string' || login.length === 0) return false;
  }
  return true;
}

/**
 * Live finding, plan 07-09 Task 2, the same bug class `decodeIssueNodeId`
 * carried: `subIssues` is rooted at `repository(owner,name){ issue(number:)
 * { subIssues {...} } }` -- the identical shape that produces a `NOT_FOUND`
 * on `repository.issue` (confirmed live: a project item's `content` silently
 * follows its issue across a transfer, so `collectIssueNumbers` can hand this
 * reader a number that no longer resolves in the configured repository, even
 * though the item itself is still board-bound). `readPath`'s own null-check-
 * before-indexing means a null intermediate ONE level above the connection
 * field (`repository.issue` here, `subIssues` still unread) makes the
 * traversal return `undefined`, not `null` — so `connection` is `undefined`
 * here, not `null`. An explicit, non-empty NOT_FOUND-only `errors` array is
 * REQUIRED to take this branch regardless (unlike `decodeIssueNodeId`, which
 * also tolerates an absent `errors` array) — an unresolved connection with
 * zero accompanying errors is exactly the shape a decode-mismatch (wrong
 * response root, malformed payload) produces, and that must keep failing
 * closed, as the HIGH-H viewer-rooted regression test pins. `project`/
 * `items`/`fields` connections share this decoder but are only ever read
 * after `readProjectNodeId` has already confirmed the project resolves, so
 * widening this does not weaken their existing "project genuinely gone"
 * detection (that gate runs earlier and returns `unavailable()` first).
 */
function decodePage(result: GhResult, path: string[]): Page | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const envelope = parsed as { data?: unknown; errors?: unknown };

  const connection = readPath(envelope.data, path);
  if (connection === null || typeof connection !== 'object') {
    return hasExplicitNotFoundError(envelope.errors) ? { nodes: [], hasNextPage: false, endCursor: null } : null;
  }
  const nodes = (connection as { nodes?: unknown }).nodes;
  const pageInfo = (connection as { pageInfo?: unknown }).pageInfo;
  if (!Array.isArray(nodes) || pageInfo === null || typeof pageInfo !== 'object') return null;
  if (!nodes.every((node) => node !== null && typeof node === 'object')) return null;
  // Plan 07-12: a present-but-malformed content.repository fails the PAGE
  // closed, before pageInfo is even inspected — see
  // hasValidContentRepositoryShape's own doc comment.
  if (!hasValidContentRepositoryShape(nodes as RemoteNode[])) return null;
  const hasNextPage = (pageInfo as { hasNextPage?: unknown }).hasNextPage;
  const endCursor = (pageInfo as { endCursor?: unknown }).endCursor;
  if (typeof hasNextPage !== 'boolean' || (endCursor !== null && typeof endCursor !== 'string')) return null;
  if (hasNextPage && (!endCursor || endCursor.length === 0)) return null;
  return { nodes: nodes as RemoteNode[], hasNextPage, endCursor };
}

/**
 * Plan 07-10 (D-01/D-05 gap closure): widened to the same three-way
 * `string | null | undefined` idiom `decodeIssueNodeId` below already
 * established — a real deleted-Project envelope carries a non-zero exit
 * code AND a NOT_FOUND-typed `errors` entry alongside a decodable
 * `data.repositoryOwner.projectV2: null`; the prior unconditional
 * `exitCode !== 0` short-circuit collapsed that shape into the identical
 * `null` a merely-failed read also produced, making
 * `REMOTE_REASON.PROJECT_ABSENT` below unreachable against a real deleted
 * board. The envelope is now consulted BEFORE `exitCode`: `null` is returned
 * ONLY for an explicit `projectV2: null` accompanied by errors that are
 * absent, empty, or exclusively NOT_FOUND-typed (`isNotFoundOnlyErrors`,
 * reused rather than re-implemented); every other outcome — a null
 * `repositoryOwner`, a non-object `projectV2`, an empty-string id, an
 * unparseable body, or any errors entry not typed NOT_FOUND — returns
 * `undefined`, preserving the guarantee that a token which merely lost read
 * access (FORBIDDEN, rate limit, ...) is never indistinguishable from a
 * genuinely deleted project (T-07-31).
 */
function readProjectNodeId(options: ReadRemoteSnapshotOptions): string | null | undefined {
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const envelope = parsed as { data?: unknown; errors?: unknown };
  // D-12/D-13: re-rooted to match the owner-scoped document above — a
  // viewer-rooted response (the pre-generalization shape) resolves to
  // undefined here (cycle-2 HIGH-H).
  const project = readPath(envelope.data, ['repositoryOwner', 'projectV2']);
  if (project === null) return isNotFoundOnlyErrors(envelope.errors) ? null : undefined;
  if (typeof project !== 'object') return undefined;
  const projectNodeId = (project as { id?: unknown }).id;
  return typeof projectNodeId === 'string' && projectNodeId.length > 0 ? projectNodeId : undefined;
}

function normalizeIssueNodeIdHints(hints: number[] | undefined): number[] {
  if (!Array.isArray(hints)) return [];
  return [...new Set(hints.filter((hint) => Number.isSafeInteger(hint) && hint > 0))].sort((left, right) => left - right);
}

/**
 * Live finding, plan 07-09 Task 2: `repository(owner,name){ issue(number:) }`
 * against a genuinely absent issue number (e.g. one transferred to another
 * repository, per `07-TRANSFER-OBSERVATION.md`) resolves `data.repository.issue`
 * to `null` while ALSO populating a top-level `errors` entry (`type: "NOT_FOUND"`)
 * -- confirmed live against `gh` 2.96.0. `gh api graphql` itself exits non-zero
 * whenever `errors` is non-empty, even though `data` decoded a legitimate,
 * expected "this number does not exist" result. The pre-existing check here
 * (`exitCode !== 0` / `errors.length > 0` -> unconditional `undefined`)
 * therefore misclassified a `null` (D-05's own "confirmed-absent") result as
 * `undefined` ("unknown" / the whole read failed) on every genuinely-absent
 * issue number -- which is precisely the input D-12's re-resolution exists to
 * evaluate. `readIssueNodeIds` in turn treats any single `undefined` hint as
 * cause to fail the ENTIRE snapshot, so one transferred-away issue made
 * `status`/`sync` report the whole remote as unavailable.
 *
 * Fixed by consulting the decoded envelope FIRST, never `exitCode`: `data`
 * being present at all (even alongside `errors`) is GraphQL's own signal that
 * the query executed. Only a bare `NOT_FOUND` on this exact path is trusted
 * as confirmed-absent (`isNotFoundOnlyErrors` below) -- any other error type
 * (`FORBIDDEN`, rate-limit, ...) alongside a null path still returns
 * `undefined`, preserving D-05's own guarantee that a token which silently
 * lost read access is never indistinguishable from a genuinely deleted issue.
 */
function isNotFoundOnlyErrors(errors: unknown): boolean {
  if (!Array.isArray(errors) || errors.length === 0) return true;
  return errors.every((entry) => (
    entry !== null && typeof entry === 'object' && (entry as { type?: unknown }).type === 'NOT_FOUND'
  ));
}

function decodeIssueNodeId(result: GhResult): string | null | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const envelope = parsed as { data?: unknown; errors?: unknown };
  const issue = readPath(envelope.data, ['repository', 'issue']);
  if (issue === null) return isNotFoundOnlyErrors(envelope.errors) ? null : undefined;
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
  // Plan 07-10: branch on the three-way result. A resolved string proceeds
  // unchanged below; `null` (the project is confirmed, explicitly gone)
  // returns `unavailable(PROJECT_ABSENT)`; `undefined` (the read merely
  // failed — malformed body, decode mismatch, any non-NOT_FOUND error) returns
  // the plain `unavailable()` exactly as before. `available` stays false in
  // both absent and failed cases — items, fields, and sub-issues genuinely
  // were not read either way.
  const projectNodeId = readProjectNodeId(options);
  if (projectNodeId === null) return unavailable(REMOTE_REASON.PROJECT_ABSENT);
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
