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
  // Task 2: a REST list read (labels, milestones) failed — a non-zero exit,
  // a timeout, an unparseable body, or a body that is not a JSON array.
  // Distinct from UNAVAILABLE only to give planBootstrap's reason-catalog
  // translation (Task 3) something REST-specific to map from.
  REST_UNAVAILABLE: 'rest_unavailable',
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

/**
 * T-03-02 / RESEARCH Pitfall 1: the REST-path sibling of the GraphQL-variable
 * vulnerability commit `eae4c80e` fixed. `gh api`'s own help text confirms it
 * substitutes brace-wrapped `{owner}`/`{repo}`/`{branch}` tokens in an
 * endpoint path from the **local git checkout or the repository environment
 * variable**, never from `github_sync.target` — so a fork, a multi-repo
 * workspace, or a differently-checked-out CI runner would silently have
 * labels or milestones created on the wrong repository. Returns null before
 * any `execGh` call when the guard fails; callers must never invoke `gh` in
 * that case (a dedicated test counts `execGh` invocations at zero for five
 * hostile owner/repo values).
 */
function restPath(owner: string, repo: string, suffix: string): string | null {
  if (!assertPathSafeTarget(owner, repo)) return null;
  return `repos/${owner}/${repo}${suffix}`;
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
  // D-20 field creates (plan 03-04 Task 2), dispatched by
  // github-sync-bootstrap-plan.cts's planFields, not this module — pinned
  // byte-identical to that module's local copies by a differential test, the
  // same pattern createProject/linkProjectToRepository establish above. No
  // `rateLimit` selection, for the same live-verified reason.
  createFieldText: 'mutation($projectId:ID!,$name:String!) { # github-sync-bootstrap:createFieldText\n createProjectV2Field(input:{projectId:$projectId,dataType:TEXT,name:$name}) { projectV2Field { ... on ProjectV2FieldCommon { id name dataType } } } }',
  createFieldNumber: 'mutation($projectId:ID!,$name:String!) { # github-sync-bootstrap:createFieldNumber\n createProjectV2Field(input:{projectId:$projectId,dataType:NUMBER,name:$name}) { projectV2Field { ... on ProjectV2FieldCommon { id name dataType } } } }',
  createFieldSingleSelect: 'mutation($projectId:ID!,$name:String!,$options:[ProjectV2SingleSelectFieldOptionInput!]!) { # github-sync-bootstrap:createFieldSingleSelect\n createProjectV2Field(input:{projectId:$projectId,dataType:SINGLE_SELECT,name:$name,singleSelectOptions:$options}) { projectV2Field { ... on ProjectV2FieldCommon { id name dataType } } } }',
  // D-23: its own operation, its own logical key — a renamed GSD field is
  // followed by its mapped id and restored to its canonical name, never
  // re-created as a duplicate.
  renameField: 'mutation($fieldId:ID!,$name:String!) { # github-sync-bootstrap:renameField\n updateProjectV2Field(input:{fieldId:$fieldId,name:$name}) { projectV2Field { ... on ProjectV2FieldCommon { id name dataType } } } }',
  // Phase 6 D-01/D-09 (06-VIEW-PROBE.md Question 4): `orderBy` is mandatory,
  // not optional — the connection's default order is not documented to
  // equal visual tab order, and D-09's leftmost-view identification would
  // silently retype the wrong view once a developer drags a tab (RESEARCH
  // Pitfall 1). `ProjectV2View` is a concrete OBJECT type, not a union, so
  // `id name layout filter` are bare scalar selections — no inline fragment
  // needed.
  views: 'query($owner:String!,$projectNumber:Int!,$endCursor:String) { # github-sync-bootstrap:views\n repositoryOwner(login:$owner) { ... on ProjectV2Owner { projectV2(number:$projectNumber) { views(first:100,after:$endCursor,orderBy:{field:POSITION,direction:ASC}) { nodes { id name layout filter } pageInfo { hasNextPage endCursor } } } } } }',
  // D-06 create half (plan 06-01 Task 1), dispatched by
  // github-sync-bootstrap-plan.cts's planViews, not this module — pinned
  // byte-identical to that module's local copy by a differential test, the
  // same pattern createProject/createFieldText establish above. No `filter`
  // variable (RESEARCH Pitfall 2: `CreateProjectV2ViewInput` has no such
  // field, live-confirmed 06-VIEW-PROBE.md Question 1) and no `rateLimit`
  // selection, for the same live-verified reason.
  createViewWithFields: 'mutation($projectId:ID!,$name:String!,$layout:ProjectV2ViewLayout!,$fieldIds:[ID!]) { # github-sync-bootstrap:createViewWithFields\n createProjectV2View(input:{projectId:$projectId,name:$name,layout:$layout,configuration:{visibleFieldIds:$fieldIds}}) { projectV2View { id } } }',
  // D-06/D-02 update half: converges name/layout/filter/visibleFieldIds
  // together in one call, late-bound to the create's own `NodeCapture` via
  // `ArgvRef` (create->update handoff, the same mechanism
  // `buildAddSubIssueOperation` already proves) or, independently, to a
  // matched-but-diverged view's observed literal id.
  updateViewShapeWithFilter: 'mutation($viewId:ID!,$name:String!,$layout:ProjectV2ViewLayout!,$filter:String!,$fieldIds:[ID!]) { # github-sync-bootstrap:updateViewShapeWithFilter\n updateProjectV2View(input:{viewId:$viewId,name:$name,layout:$layout,filter:$filter,configuration:{visibleFieldIds:$fieldIds}}) { projectV2View { id name layout filter } } }',
  // Plan 06-02 Task 1: the configuration-free pair, for Roadmap and Board —
  // D-08's two views declaring neither a filter nor a visible field. Both
  // carry no `configuration` input at all, so the null-`visibleFieldIds`
  // question this pair would otherwise raise never has to be answered.
  // Dispatched by github-sync-bootstrap-plan.cts's planViews, not this
  // module — pinned byte-identical to that module's local copy by a
  // differential test, the same pattern createViewWithFields establishes.
  createView: 'mutation($projectId:ID!,$name:String!,$layout:ProjectV2ViewLayout!) { # github-sync-bootstrap:createView\n createProjectV2View(input:{projectId:$projectId,name:$name,layout:$layout}) { projectV2View { id } } }',
  // The bare update half — restores `name`/`layout` alone, for a
  // matched-but-diverged Roadmap or Board (D-01's repair path). No `filter`,
  // no `configuration` — the same document-selection branch
  // `buildUpdateViewShapeOperation` uses to pick between this and
  // `updateViewShapeWithFilter`.
  updateViewShape: 'mutation($viewId:ID!,$name:String!,$layout:ProjectV2ViewLayout!) { # github-sync-bootstrap:updateViewShape\n updateProjectV2View(input:{viewId:$viewId,name:$name,layout:$layout}) { projectV2View { id name layout } } }',
  // Phase 6 D-09/D-11 (plan 06-04): the leftmost-view retype — exactly two
  // variables, `viewId` and `layout`, and no way to express a name, filter,
  // or configuration write (T-06-14). Dispatched by
  // github-sync-bootstrap-plan.cts's planLeftmostViewLayout, not this
  // module — pinned byte-identical to that module's local copy by a
  // differential test, the same pattern updateViewShape establishes.
  updateViewLayout: 'mutation($viewId:ID!,$layout:ProjectV2ViewLayout!) { # github-sync-bootstrap:updateViewLayout\n updateProjectV2View(input:{viewId:$viewId,layout:$layout}) { projectV2View { id layout } } }',
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

/** Phase 6 D-08: the four view properties GSD can observe — `id`, `name`, `layout`, `filter`. `visibleFieldIds` is write-only from this reader's perspective (never reconciled once set, D-02's scope). */
interface RemoteView {
  id: string;
  name: string;
  layout: string;
  filter: string | null;
}

interface BootstrapRemoteOptions {
  cwd: string;
  owner: string;
  repo: string;
  projectNumber: number | null;
  execGh?: (args: string[], opts: { cwd?: string; includeHeaders?: boolean }) => GhResult;
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
  /** BOOT-04: every repository label, decoded from a REST list read. */
  labels: RestListEntry[];
  /** BOOT-05: every repository Milestone (open and closed), decoded from a REST list read. */
  milestones: RestListEntry[];
  /** Phase 6 D-01: every view on the project, from the paginated `views` connection read (`orderBy: POSITION`) — read only on the project-scoped branch; empty on the `unset`/`absent` outcomes, exactly as `fields` is. */
  views: RemoteView[];
}

function unavailable(reason: BootstrapRemoteReason = BOOTSTRAP_REMOTE_REASON.UNAVAILABLE): BootstrapRemoteState {
  return {
    available: false, reason, projectOutcome: PROJECT_OUTCOME.UNAVAILABLE, repository: null, projectNodeId: null,
    fields: [], statusField: null, labels: [], milestones: [], views: [],
  };
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
 * Fail-closed decoder shaped exactly like `decodeField`: a malformed node
 * returns null and collapses the whole read to the fixed unavailable result,
 * never a partial list that would read as "no views exist" and trigger a
 * duplicate create.
 */
function decodeView(raw: unknown): RemoteView | null {
  if (!isRecord(raw)) return null;
  if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.name) || typeof raw.layout !== 'string') return null;
  if (raw.filter !== null && typeof raw.filter !== 'string') return null;
  return { id: raw.id, name: raw.name, layout: raw.layout, filter: raw.filter === null ? null : raw.filter };
}

// ─── REST list reads (Task 2): labels and milestones ───────────────────────

/** One decoded REST label or milestone: node id, name/title, and — milestones only — number and state. */
interface RestListEntry {
  nodeId: string;
  name: string;
  number?: number;
  state?: string;
}

function isPositiveSafeIntegerLocal(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Decodes one REST list element. `name` reads GitHub's `name` field (labels)
 * or falls back to `title` (milestones) — one decoder serves both endpoints.
 * `number`/`state` are present only on a milestone and are optional here.
 * The node id is what Task 3's adoption checkpoints record; decode fails
 * closed (null) when it is absent or empty, exactly as `decodeField` does
 * for the GraphQL field reader above.
 */
function decodeRestEntry(raw: unknown): RestListEntry | null {
  if (!isRecord(raw)) return null;
  const nodeId = raw.node_id;
  const name = typeof raw.name === 'string' ? raw.name : (typeof raw.title === 'string' ? raw.title : undefined);
  if (!isNonEmptyString(nodeId) || !isNonEmptyString(name)) return null;
  const entry: RestListEntry = { nodeId, name };
  if (isPositiveSafeIntegerLocal(raw.number)) entry.number = raw.number;
  if (typeof raw.state === 'string') entry.state = raw.state;
  return entry;
}

interface RestListResult {
  available: boolean;
  reason: BootstrapRemoteReason;
  entries: RestListEntry[];
}

/**
 * Issues exactly **one** `execGh` call per list, requesting `gh api`'s own
 * paginate-and-slurp mode rather than a cursor loop GSD would have to own
 * (RESEARCH Pitfall 3, cycle-1 HIGH-8): `gh` 2.96.0's slurp mode wraps every
 * page of a JSON-array response into one outer array, verified live against a
 * real 41-page label list during replanning. This function flattens exactly
 * one level when the outer array's own elements are themselves arrays (the
 * multi-page shape) and accepts a flat array of objects unchanged (the
 * single-page shape some `gh` versions return un-nested) — an empty array of
 * one empty array (`[[]]`) decodes to an available, zero-entry result, never
 * an unavailable one: an empty list is a decodable state meaning "none
 * exist".
 *
 * Always passes an explicit page size of 100 in the query — the REST default
 * of 30 would silently under-read a developer's pre-existing labels or
 * milestones and cause a duplicate create. `includeHeaders` is always false:
 * this reader needs no header metadata, and combining it with paginate mode
 * would be incompatible with the framing parser's two-block guard in any case
 * (Task 2's own pagination-decision note — no change to that seam here).
 *
 * LIVE FINDING, discovered capturing this task's own fixture against
 * `drungrin/gsd-core`: `gh api`'s documented default method is GET, but the
 * moment ANY `-f`/`-F` value is supplied on a path with no explicit
 * `--method`/`-X`, `gh` silently switches to POST instead (`gh api --help`:
 * "were added. Override the method with `--method`."). A read call built as
 * `gh api repos/OWNER/REPO/labels -f per_page=100` therefore dispatches a
 * POST to the label-**create** endpoint, not a GET list — reproduced live: it
 * returned a 422 for a missing `name` field. `-X`, `GET` is passed
 * explicitly, unconditionally, on every call this function issues, so the
 * page-size query parameter can never flip the request into a write.
 *
 * Never throws: a non-zero exit, a timeout, unparseable JSON, a body that is
 * not a JSON array, or a malformed element all collapse to the fixed
 * REST-unavailable result.
 */
function readRestList(
  execGh: (args: string[], opts: { cwd?: string; includeHeaders?: boolean }) => GhResult,
  cwd: string,
  restApiPath: string,
  query: Record<string, string>,
): RestListResult {
  const queryArgv: string[] = [];
  for (const [key, value] of Object.entries(query)) queryArgv.push('-f', `${key}=${value}`);
  const result = execGh(['api', restApiPath, '-X', 'GET', ...queryArgv, '--paginate', '--slurp'], { cwd, includeHeaders: false });
  if (result.exitCode !== 0) return { available: false, reason: BOOTSTRAP_REMOTE_REASON.REST_UNAVAILABLE, entries: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { available: false, reason: BOOTSTRAP_REMOTE_REASON.REST_UNAVAILABLE, entries: [] };
  }
  if (!Array.isArray(parsed)) return { available: false, reason: BOOTSTRAP_REMOTE_REASON.REST_UNAVAILABLE, entries: [] };

  const flattened: unknown[] = parsed.length > 0 && parsed.every((element) => Array.isArray(element)) ? parsed.flat() : parsed;

  const entries: RestListEntry[] = [];
  for (const raw of flattened) {
    const decoded = decodeRestEntry(raw);
    if (!decoded) return { available: false, reason: BOOTSTRAP_REMOTE_REASON.REST_UNAVAILABLE, entries: [] };
    entries.push(decoded);
  }
  return { available: true, reason: BOOTSTRAP_REMOTE_REASON.OK, entries };
}

interface BootstrapRestOptions {
  cwd: string;
  owner: string;
  repo: string;
  execGh?: (args: string[], opts: { cwd?: string; includeHeaders?: boolean }) => GhResult;
}

/** BOOT-04: `init`'s repository label list read. Explicit page size 100, exhausted inside `gh`. */
function readRepoLabels(options: BootstrapRestOptions): RestListResult {
  const execGh = options.execGh ?? ghMod.execGh;
  const restApiPath = restPath(options.owner, options.repo, '/labels');
  if (restApiPath === null) return { available: false, reason: BOOTSTRAP_REMOTE_REASON.UNSAFE_TARGET, entries: [] };
  return readRestList(execGh, options.cwd, restApiPath, { per_page: '100' });
}

/** BOOT-05: `init`'s Milestone list read. Requests all states so a closed milestone is visible and an archived-milestone create cannot duplicate one. */
function readRepoMilestones(options: BootstrapRestOptions): RestListResult {
  const execGh = options.execGh ?? ghMod.execGh;
  const restApiPath = restPath(options.owner, options.repo, '/milestones');
  if (restApiPath === null) return { available: false, reason: BOOTSTRAP_REMOTE_REASON.UNSAFE_TARGET, entries: [] };
  return readRestList(execGh, options.cwd, restApiPath, { per_page: '100', state: 'all' });
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
 * Reads every view on the project, paging through `views` with the same
 * cursor-exhaustion and repeat-cursor guard `readProjectFields` uses,
 * `orderBy: POSITION` carried on every page (06-VIEW-PROBE.md Question 4).
 * Called only from the project-scoped branch, after `readProjectFields` has
 * already confirmed the project resolves — a null `repositoryOwner`/
 * `projectV2` here is therefore a malformed-payload condition (an
 * inconsistent read between the two calls), not a legitimate absent state,
 * and fails closed to `undefined` like every other malformed shape this
 * reader rejects.
 */
function readProjectViews(options: BootstrapRemoteOptions): RemoteView[] | undefined {
  const execGh = options.execGh ?? ghMod.execGh;
  const views: RemoteView[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  while (true) {
    const result = execGh(
      [
        'api', 'graphql', '-f', `query=${BOOTSTRAP_DOCUMENTS.views}`,
        '-f', `owner=${options.owner}`,
        '-F', `projectNumber=${options.projectNumber}`,
        '-f', `endCursor=${cursor ?? ''}`,
      ],
      { cwd: options.cwd },
    );
    const data = parseGraphqlEnvelope(result);
    if (data === null) return undefined;
    const repositoryOwner = data.repositoryOwner;
    if (!isRecord(repositoryOwner)) return undefined;
    const projectV2 = repositoryOwner.projectV2;
    if (!isRecord(projectV2)) return undefined;
    const connection = projectV2.views;
    if (!isRecord(connection)) return undefined;
    const nodes = connection.nodes;
    const pageInfo = connection.pageInfo;
    if (!Array.isArray(nodes) || !isRecord(pageInfo)) return undefined;
    for (const node of nodes) {
      const decoded = decodeView(node);
      if (!decoded) return undefined;
      views.push(decoded);
    }
    const hasNextPage = pageInfo.hasNextPage;
    const endCursor = pageInfo.endCursor;
    if (typeof hasNextPage !== 'boolean' || (endCursor !== null && typeof endCursor !== 'string')) return undefined;
    if (!hasNextPage) break;
    if (!endCursor || seenCursors.has(endCursor)) return undefined;
    seenCursors.add(endCursor);
    cursor = endCursor;
  }
  return views;
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

  // Task 2: labels and milestones are read alongside the project/fields data
  // in every call — a REST failure marks the WHOLE snapshot unavailable
  // rather than returning an empty list that would read as "nothing exists"
  // and trigger a duplicate create (T-03-12).
  const restOptions = { cwd: options.cwd, owner: options.owner, repo: options.repo, execGh: options.execGh };
  const labelsRead = readRepoLabels(restOptions);
  if (!labelsRead.available) return unavailable(labelsRead.reason);
  const milestonesRead = readRepoMilestones(restOptions);
  if (!milestonesRead.available) return unavailable(milestonesRead.reason);

  if (options.projectNumber === null) {
    return {
      available: true,
      reason: BOOTSTRAP_REMOTE_REASON.OK,
      projectOutcome: PROJECT_OUTCOME.UNSET,
      repository,
      projectNodeId: null,
      fields: [],
      statusField: null,
      labels: labelsRead.entries,
      milestones: milestonesRead.entries,
      views: [],
    };
  }

  const projectFields = readProjectFields(options);
  if (projectFields === undefined) return unavailable();

  // Phase 6 D-01: views are read only when the project itself resolved —
  // an `absent` project has no board to read views from, and the query
  // would only re-confirm what `readProjectFields` already established.
  let views: RemoteView[] = [];
  if (projectFields.outcome === PROJECT_OUTCOME.RESOLVED) {
    const viewsRead = readProjectViews(options);
    if (viewsRead === undefined) return unavailable();
    views = viewsRead;
  }

  const statusField = projectFields.fields.find((field) => field.name === STATUS_FIELD_NAME) ?? null;
  return {
    available: true,
    reason: BOOTSTRAP_REMOTE_REASON.OK,
    projectOutcome: projectFields.outcome,
    repository,
    projectNodeId: projectFields.projectNodeId,
    fields: projectFields.fields,
    statusField,
    labels: labelsRead.entries,
    milestones: milestonesRead.entries,
    views,
  };
}

export = {
  assertPathSafeTarget,
  readBootstrapRemoteState,
  restPath,
  readRepoLabels,
  readRepoMilestones,
  BOOTSTRAP_REMOTE_REASON,
  BOOTSTRAP_DOCUMENTS,
  PROJECT_OUTCOME,
  STATUS_FIELD_NAME,
  LINK_STATE,
};
