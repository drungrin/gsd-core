'use strict';
/**
 * github-sync-bootstrap-remote.cts — credential-free, typed remote reader for
 * `init`'s bootstrap passes (plan 03-02). Modeled on `github-sync-remote.cts`:
 * every GraphQL read goes through the injected execGh-compatible seam, and
 * malformed transport data collapses to the fixed unavailable result rather
 * than raw operator output ever reaching a caller.
 *
 * Two departures from the Phase 2 reader, both load-bearing:
 *
 * - `fieldsWithTypes` is scoped through the **repository owner**
 *   (`repositoryOwner(login:) { ... on ProjectV2Owner { projectV2(number:) } }`),
 *   not the viewer. D-12 creates the board under the repository owner, so a
 *   viewer-rooted read is blind on every org-owned board — including one
 *   `init` itself just created (cycle-4 HIGH-2).
 * - The project-scoped documents are issued only when the caller supplies a
 *   positive project number. A `null` number is a decodable `unset` state
 *   ("there is no board yet"), never the `unavailable` result that means
 *   "the read failed" — collapsing the two would make BOOT-01's fresh-create
 *   path unreachable (cycle-4 HIGH-4).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import ghMod = require('./github-sync-gh.cjs');

const BOOTSTRAP_REMOTE_REASON = Object.freeze({
  OK: 'ok',
  UNSAFE_TARGET: 'unsafe_target',
  UNAVAILABLE: 'remote_unavailable',
} as const);
type BootstrapRemoteReason = typeof BOOTSTRAP_REMOTE_REASON[keyof typeof BOOTSTRAP_REMOTE_REASON];

const PROJECT_OUTCOME = Object.freeze({
  RESOLVED: 'resolved',
  ABSENT: 'absent',
  UNSET: 'unset',
  UNAVAILABLE: 'unavailable',
} as const);
type ProjectOutcome = typeof PROJECT_OUTCOME[keyof typeof PROJECT_OUTCOME];

// SECURITY (mirrors github-sync-remote.cts:159-171): `gh`'s typed `-F` flag
// performs magic value substitution before the request is built — a leading
// `@` reads a local file, and `{owner}`/`{repo}`/`{branch}` expand from the
// local git checkout. `owner`/`repo` in `.planning/config.json` carry no
// charset restriction from `readSyncTarget`, so both must ride the raw `-f`
// flag here, exactly as the Phase 2 reader's issueId/subIssues calls do.
const PATH_SAFE_TARGET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Rejects the brace, slash, at-sign, and space characters `gh` treats as
 * magic in an endpoint path or field-flag value (RESEARCH Pitfall 1, threat
 * T-03-02), plus the empty string. Called before any `execGh` invocation.
 */
function assertPathSafeTarget(owner: unknown, repo: unknown): boolean {
  return typeof owner === 'string' && typeof repo === 'string' &&
    PATH_SAFE_TARGET.test(owner) && PATH_SAFE_TARGET.test(repo);
}

const LINK_STATE = Object.freeze({
  LINKED: 'linked',
  UNLINKED: 'unlinked',
  INDETERMINATE: 'indeterminate',
} as const);
type LinkState = typeof LINK_STATE[keyof typeof LINK_STATE];

const BOOTSTRAP_DOCUMENTS = Object.freeze({
  // Widened (plan 03-03 Task 2) to also read whether the resolved Project is
  // actually linked to this repository — one round trip, no second document.
  // `projectsV2` lists the repository's own linked Project v2 boards; only
  // the first page is read (T-03-30): the target number's presence among the
  // first 100 decides LINKED, its absence with no further page decides
  // UNLINKED, and its absence WITH a further page decides INDETERMINATE —
  // never assumed LINKED, so a truncated response can at worst cause one
  // redundant link attempt, never a permanently unlinked board.
  repository: 'query($owner:String!,$repo:String!) { # github-sync-bootstrap:repository\n repository(owner:$owner,name:$repo) { id owner { id login } projectsV2(first:100) { nodes { number } pageInfo { hasNextPage endCursor } } } }',
  // D-12/D-13: owner-rooted from the moment this document exists (cycle-4
  // HIGH-2) — repositoryOwner(login:) resolves through the repository's
  // actual owner (user or organization), and ProjectV2Owner is the interface
  // both types implement that carries projectV2(number:). A field node that
  // is a single-select (ProjectV2SingleSelectField) satisfies BOTH inline
  // fragments below, so its `options` merge into the same JSON object as its
  // `id`/`name`/`dataType` — a field that is not a single-select simply omits
  // `options` from its decoded node.
  // Selects the project's OWN id (sibling to `fields`) alongside its fields —
  // BOOT-01's adopt path needs the resolved project's node id to checkpoint
  // it, and this is the only document that reads a resolved project.
  fieldsWithTypes: 'query($owner:String!,$projectNumber:Int!,$endCursor:String) { # github-sync-bootstrap:fieldsWithTypes\n repositoryOwner(login:$owner) { ... on ProjectV2Owner { projectV2(number:$projectNumber) { id fields(first:100,after:$endCursor) { nodes { ... on ProjectV2FieldCommon { id name dataType } ... on ProjectV2SingleSelectField { id name dataType options { id name color description } } } pageInfo { hasNextPage endCursor } } } } } }',
  // BOOT-01 create path (D-12/RESEARCH Pitfall 4): input carries only an
  // owner id and a title — no repositoryId — so create and link stay two
  // independently-retryable operations (github-sync-bootstrap-plan.cts's
  // planProject). No `rateLimit` selection: live-verified in plan 03-02 that
  // GitHub's `Mutation` type has no such field.
  createProject: 'mutation($ownerId:ID!,$title:String!) { # github-sync-bootstrap:createProject\n createProjectV2(input:{ownerId:$ownerId,title:$title}) { projectV2 { id number } } }',
  // D-14: its own operation, its own logical key, so a link failure retries
  // independently of the project's own (already-confirmed) checkpoint.
  linkProjectToRepository: 'mutation($projectId:ID!,$repositoryId:ID!) { # github-sync-bootstrap:linkProjectToRepository\n linkProjectV2ToRepository(input:{projectId:$projectId,repositoryId:$repositoryId}) { repository { id } } }',
});

const STATUS_FIELD_NAME = 'Status';

interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  reason: string;
}

interface RemoteSingleSelectOption {
  id: string;
  name: string;
  color: string;
  description: string;
}

interface RemoteField {
  id: string;
  name: string;
  dataType: string;
  options: RemoteSingleSelectOption[] | null;
}

interface BootstrapRemoteOptions {
  cwd: string;
  owner: string;
  repo: string;
  projectNumber: number | null;
  execGh?: (args: string[], opts: { cwd?: string }) => GhResult;
}

interface RepositoryRead {
  nodeId: string;
  ownerNodeId: string;
  ownerLogin: string;
  /** null when the caller supplied no project number to check link state against. */
  linkState: LinkState | null;
}

interface BootstrapRemoteState {
  available: boolean;
  reason: BootstrapRemoteReason;
  projectOutcome: ProjectOutcome;
  repository: RepositoryRead | null;
  /** The resolved project's own node id — null unless projectOutcome is 'resolved'. */
  projectNodeId: string | null;
  fields: RemoteField[];
  statusField: RemoteField | null;
}

function unavailable(reason: BootstrapRemoteReason = BOOTSTRAP_REMOTE_REASON.UNAVAILABLE): BootstrapRemoteState {
  return { available: false, reason, projectOutcome: PROJECT_OUTCOME.UNAVAILABLE, repository: null, projectNodeId: null, fields: [], statusField: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseGraphqlEnvelope(result: GhResult): Record<string, unknown> | null {
  if (result.exitCode !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const errors = parsed.errors;
  if (Array.isArray(errors) && errors.length > 0) return null;
  const data = parsed.data;
  return isRecord(data) ? data : null;
}

/**
 * Decodes the widened repository document's `projectsV2` connection into a
 * three-valued link state relative to `targetProjectNumber`, reading only
 * the first page (T-03-30). Returns `undefined` on any malformed shape,
 * distinct from the three legitimate decoded states.
 */
function decodeLinkState(rawConnection: unknown, targetProjectNumber: number): LinkState | undefined {
  if (!isRecord(rawConnection)) return undefined;
  const nodes = rawConnection.nodes;
  const pageInfo = rawConnection.pageInfo;
  if (!Array.isArray(nodes) || !isRecord(pageInfo)) return undefined;
  const numbers: number[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) return undefined;
    const number = node.number;
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return undefined;
    numbers.push(number);
  }
  const hasNextPage = pageInfo.hasNextPage;
  if (typeof hasNextPage !== 'boolean') return undefined;
  if (numbers.includes(targetProjectNumber)) return LINK_STATE.LINKED;
  return hasNextPage ? LINK_STATE.INDETERMINATE : LINK_STATE.UNLINKED;
}

function readRepository(options: BootstrapRemoteOptions): RepositoryRead | null | undefined {
  const execGh = options.execGh ?? ghMod.execGh;
  const result = execGh(
    [
      'api', 'graphql', '-f', `query=${BOOTSTRAP_DOCUMENTS.repository}`,
      '-f', `owner=${options.owner}`,
      '-f', `repo=${options.repo}`,
    ],
    { cwd: options.cwd },
  );
  const data = parseGraphqlEnvelope(result);
  if (data === null) return undefined;
  const repository = data.repository;
  if (repository === null) return null;
  if (!isRecord(repository)) return undefined;
  const owner = repository.owner;
  if (!isNonEmptyString(repository.id) || !isRecord(owner) || !isNonEmptyString(owner.id) || !isNonEmptyString(owner.login)) return undefined;

  let linkState: LinkState | null = null;
  if (options.projectNumber !== null) {
    const decoded = decodeLinkState(repository.projectsV2, options.projectNumber);
    if (decoded === undefined) return undefined;
    linkState = decoded;
  }
  return { nodeId: repository.id, ownerNodeId: owner.id, ownerLogin: owner.login, linkState };
}

function decodeOption(raw: unknown): RemoteSingleSelectOption | null {
  if (!isRecord(raw)) return null;
  if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.name) || typeof raw.color !== 'string' || typeof raw.description !== 'string') return null;
  return { id: raw.id, name: raw.name, color: raw.color, description: raw.description };
}

function decodeField(raw: unknown): RemoteField | null {
  if (!isRecord(raw)) return null;
  if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.name) || typeof raw.dataType !== 'string') return null;
  if (raw.options === undefined) return { id: raw.id, name: raw.name, dataType: raw.dataType, options: null };
  if (!Array.isArray(raw.options)) return null;
  const options: RemoteSingleSelectOption[] = [];
  for (const entry of raw.options) {
    const decoded = decodeOption(entry);
    if (!decoded) return null;
    options.push(decoded);
  }
  return { id: raw.id, name: raw.name, dataType: raw.dataType, options };
}

/**
 * Reads every field on the project number, paging through `fields` with the
 * same cursor-exhaustion and repeat-cursor guard as
 * `github-sync-remote.cts`'s `readConnection`. Returns `'absent'` when the
 * project itself does not resolve (repositoryOwner or projectV2 is null),
 * distinct from `undefined` (malformed payload, decode failure).
 */
function readProjectFields(options: BootstrapRemoteOptions): { outcome: typeof PROJECT_OUTCOME.RESOLVED | typeof PROJECT_OUTCOME.ABSENT; fields: RemoteField[]; projectNodeId: string | null } | undefined {
  const execGh = options.execGh ?? ghMod.execGh;
  const fields: RemoteField[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let sawProject = false;
  let projectNodeId: string | null = null;

  while (true) {
    const result = execGh(
      [
        'api', 'graphql', '-f', `query=${BOOTSTRAP_DOCUMENTS.fieldsWithTypes}`,
        '-f', `owner=${options.owner}`,
        '-F', `projectNumber=${options.projectNumber}`,
        '-f', `endCursor=${cursor ?? ''}`,
      ],
      { cwd: options.cwd },
    );
    const data = parseGraphqlEnvelope(result);
    if (data === null) return undefined;
    const repositoryOwner = data.repositoryOwner;
    if (repositoryOwner === null) return { outcome: PROJECT_OUTCOME.ABSENT, fields: [], projectNodeId: null };
    if (!isRecord(repositoryOwner)) return undefined;
    const projectV2 = repositoryOwner.projectV2;
    if (projectV2 === null) return { outcome: PROJECT_OUTCOME.ABSENT, fields: [], projectNodeId: null };
    if (!isRecord(projectV2)) return undefined;
    if (!isNonEmptyString(projectV2.id)) return undefined;
    sawProject = true;
    projectNodeId = projectV2.id;
    const connection = projectV2.fields;
    if (!isRecord(connection)) return undefined;
    const nodes = connection.nodes;
    const pageInfo = connection.pageInfo;
    if (!Array.isArray(nodes) || !isRecord(pageInfo)) return undefined;
    for (const node of nodes) {
      const decoded = decodeField(node);
      if (!decoded) return undefined;
      fields.push(decoded);
    }
    const hasNextPage = pageInfo.hasNextPage;
    const endCursor = pageInfo.endCursor;
    if (typeof hasNextPage !== 'boolean' || (endCursor !== null && typeof endCursor !== 'string')) return undefined;
    if (!hasNextPage) break;
    if (!endCursor || seenCursors.has(endCursor)) return undefined;
    seenCursors.add(endCursor);
    cursor = endCursor;
  }
  return sawProject ? { outcome: PROJECT_OUTCOME.RESOLVED, fields, projectNodeId } : { outcome: PROJECT_OUTCOME.ABSENT, fields: [], projectNodeId: null };
}

/**
 * Reads the repository binding and — only when `projectNumber` is a positive
 * integer — the project's fields. A `null` project number is decoded as the
 * `unset` outcome: an available read reporting "there is no board yet",
 * never the `unavailable` result that means "the read failed" (cycle-4
 * HIGH-4). Never throws; any malformed payload collapses to the fixed
 * unavailable result.
 */
function readBootstrapRemoteState(options: BootstrapRemoteOptions): BootstrapRemoteState {
  if (!assertPathSafeTarget(options.owner, options.repo)) return unavailable(BOOTSTRAP_REMOTE_REASON.UNSAFE_TARGET);

  const repository = readRepository(options);
  if (repository === undefined) return unavailable();

  if (options.projectNumber === null) {
    return {
      available: true,
      reason: BOOTSTRAP_REMOTE_REASON.OK,
      projectOutcome: PROJECT_OUTCOME.UNSET,
      repository,
      projectNodeId: null,
      fields: [],
      statusField: null,
    };
  }

  const projectFields = readProjectFields(options);
  if (projectFields === undefined) return unavailable();

  const statusField = projectFields.fields.find((field) => field.name === STATUS_FIELD_NAME) ?? null;
  return {
    available: true,
    reason: BOOTSTRAP_REMOTE_REASON.OK,
    projectOutcome: projectFields.outcome,
    repository,
    projectNodeId: projectFields.projectNodeId,
    fields: projectFields.fields,
    statusField,
  };
}

export = {
  assertPathSafeTarget,
  readBootstrapRemoteState,
  BOOTSTRAP_REMOTE_REASON,
  BOOTSTRAP_DOCUMENTS,
  PROJECT_OUTCOME,
  STATUS_FIELD_NAME,
  LINK_STATE,
};
