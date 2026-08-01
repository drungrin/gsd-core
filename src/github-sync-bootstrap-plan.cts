'use strict';
/**
 * github-sync-bootstrap-plan.cts — pure bootstrap diff composer for `init`
 * (plan 03-02). Zero I/O imports. Owns the reserved logical-key catalog
 * locked at plan 03-01 Task 1, the `Status` merged-write builder with its
 * converged-noop checkpoint path (HIGH-B), and the single-select option argv
 * encoder settled against the real `gh` 2.96.0 binary.
 *
 * Every stage builder in this phase takes a `CompletionContext` built once by
 * `planBootstrap` from the resolved target — the repository binding
 * `recordCompletion` validates — per plan 03-01's checkpoint contract clause
 * 1a. No builder derives its own binding.
 */

import type {
  MutationOperation,
  AdoptionCheckpoint,
  CompletionContext,
  ArgvEntry,
} from './github-sync-operation.cts';
import { OPERATION_TRANSPORT, OPERATION_ACTION, ARGV_REF_PART } from './github-sync-operation.cjs';

const STATUS_FIELD_NAME = 'Status';

const BOOTSTRAP_OPERATION_REASON = Object.freeze({
  // Extends Phase 2's reconciliation reasons (github-sync-reconcile.cts).
  DESIRED_UNAVAILABLE: 'desired_unavailable',
  REMOTE_UNAVAILABLE: 'remote_unavailable',
  MAP_BLOCKING: 'map_blocking',
  MISSING_STATUS_FIELD: 'missing_status_field',
  PROJECT_UNSET: 'project_unset',
  UNSAFE_TARGET: 'unsafe_target',
  // Placeholders promoted by later plans in this phase.
  PROJECT_NOT_FOUND: 'project_not_found',
  OWNER_UNRESOLVABLE: 'owner_unresolvable',
  FIELD_TYPE_MISMATCH: 'field_type_mismatch',
  REST_UNAVAILABLE: 'rest_unavailable',
} as const);

const BOOTSTRAP_PASS = Object.freeze({
  STRUCTURE: 'structure',
  OPTIONS: 'options',
} as const);
type BootstrapPass = typeof BOOTSTRAP_PASS[keyof typeof BOOTSTRAP_PASS];

/**
 * The reserved logical-key catalog approved at plan 03-01 Task 1: lowercase
 * kebab slug, ASCII-only, punctuation stripped, non-alphanumeric runs
 * collapsed to a single `-`, no leading/trailing `-`. No caller concatenates
 * a key by hand.
 */
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const BOOTSTRAP_LOGICAL_KEY = Object.freeze({
  project: (): string => 'project',
  projectLink: (): string => 'project-link',
  field: (name: string): string => `field:${slug(name)}`,
  statusOption: (name: string): string => `option:status:${slug(name)}`,
  label: (name: string): string => `label:${slug(name)}`,
  milestone: (version: string): string => `milestone:${slug(version)}`,
});

/** D-19 order: Todo, In Progress, Blocked, Done, Deferred. Colours/descriptions set once, never reconciled (D-18). */
const GSD_STATUS_OPTIONS = Object.freeze([
  Object.freeze({ name: 'Todo', color: 'GRAY', description: '' }),
  Object.freeze({ name: 'In Progress', color: 'BLUE', description: '' }),
  Object.freeze({ name: 'Blocked', color: 'RED', description: '' }),
  Object.freeze({ name: 'Done', color: 'GREEN', description: '' }),
  Object.freeze({ name: 'Deferred', color: 'YELLOW', description: '' }),
] as const);

interface OptionInput { id?: string; name: string; color: string; description: string; }

/**
 * Encodes a single-select option array the way `gh` 2.96.0 actually accepts
 * it (settled live during replanning, not assumed): repeating a
 * bracket-suffixed raw field builds a real JSON array of objects, and `gh`
 * opens a **new** element the moment it sees a sub-key already present in the
 * element it is filling. Sub-key emission order is therefore load-bearing —
 * every element emits its `name` sub-key first, unconditionally, so a
 * repeated `name` is an unambiguous element boundary and no optional `id`
 * can ever migrate onto the wrong element (T-03-01: an id-less element
 * followed by an id-bearing one would otherwise attach the second element's
 * id to the first, silently deleting a developer's custom option under the
 * full-replace semantics).
 *
 * SECURITY: every entry rides the raw `-f` flag. `gh`'s typed `-F` flag was
 * observed during replanning to perform the same local-file/`@`-prefix
 * substitution on bracket-suffixed values as on plain ones (T-03-03).
 */
function optionInputArgv(variableName: string, options: OptionInput[]): string[] {
  const argv: string[] = [];
  for (const option of options) {
    argv.push('-f', `${variableName}[][name]=${option.name}`);
    if (option.id !== undefined) argv.push('-f', `${variableName}[][id]=${option.id}`);
    argv.push('-f', `${variableName}[][color]=${option.color}`);
    argv.push('-f', `${variableName}[][description]=${option.description}`);
  }
  return argv;
}

// ─── planStatusOptionMerge ──────────────────────────────────────────────────

interface RemoteSingleSelectOption { id: string; name: string; color: string; description: string; }
interface RemoteStatusField { id: string; name: string; dataType: string; options: RemoteSingleSelectOption[] | null; }
type ProjectOutcome = 'resolved' | 'absent' | 'unset' | 'unavailable';
type LinkState = 'linked' | 'unlinked' | 'indeterminate';
interface BootstrapRepositoryLike {
  nodeId: string;
  ownerNodeId: string;
  ownerLogin: string;
  linkState: LinkState | null;
}
interface BootstrapRemoteForMerge {
  available: boolean;
  projectOutcome: ProjectOutcome;
  statusField: RemoteStatusField | null;
  repository?: BootstrapRepositoryLike | null;
  projectNodeId?: string | null;
}
interface StrictMapCompletion { nodeId: string; }
interface StrictMapLike {
  kind: 'absent' | 'valid' | 'blocking';
  reason?: string;
  map?: { completions?: Record<string, StrictMapCompletion> };
}

type StatusMergeResult =
  | { kind: 'noop'; reason: string }
  | { kind: 'blocked'; reason: string }
  | { kind: 'converged'; checkpoints: AdoptionCheckpoint[] }
  | { kind: 'operation'; operation: MutationOperation };

// Live-verified against the real schema during Task 2's A1 proof (2026-08-01,
// gh 2.96.0, board #9): `rateLimit` is a `Query` field, not a `Mutation`
// field — `__type(name:"Mutation"){ fields }` does not list it, and
// requesting it inside a mutation document is rejected with
// `undefinedField`/`rateLimit doesn't exist on type 'Mutation'`. This
// document therefore selects no rateLimit block and the operation declares
// `hasPointsBudget: false`; points-budget pacing was designed around an
// unverified assumption Phase 2 never proved live (logged for Phase 2's
// `addProjectV2Item` operation, which shares the same false assumption, in
// `.planning/phases/03-project-bootstrap/deferred-items.md` — out of this
// task's declared scope to change).
const STATUS_MERGE_DOCUMENT =
  'mutation($fieldId:ID!,$options:[ProjectV2SingleSelectFieldOptionInput!]!) { # github-sync-bootstrap:updateSingleSelectOptions\n' +
  'updateProjectV2Field(input:{fieldId:$fieldId,singleSelectOptions:$options}) { ' +
  'projectV2Field { ... on ProjectV2SingleSelectField { options { id name } } } } }';

function mergedOptionsArray(remoteOptions: RemoteSingleSelectOption[], strictMap: StrictMapLike): { merged: OptionInput[]; matchedRemoteIds: Set<string> } {
  const completions = strictMap.kind === 'valid' ? strictMap.map?.completions ?? {} : {};
  const matchedRemoteIds = new Set<string>();
  const merged: OptionInput[] = [];

  for (const gsdOption of GSD_STATUS_OPTIONS) {
    // D-17: match by the sync map's stored option id first (survives a
    // remote rename), then by exact name (BOOT-03 adjacency edge).
    const storedId = completions[BOOTSTRAP_LOGICAL_KEY.statusOption(gsdOption.name)]?.nodeId;
    const byStoredId = storedId ? remoteOptions.find((option) => option.id === storedId) : undefined;
    const byName = byStoredId ?? remoteOptions.find((option) => option.name === gsdOption.name);
    if (byName) {
      matchedRemoteIds.add(byName.id);
      merged.push({ id: byName.id, name: byName.name, color: byName.color, description: byName.description });
    } else {
      merged.push({ name: gsdOption.name, color: gsdOption.color, description: gsdOption.description });
    }
  }
  for (const remoteOption of remoteOptions) {
    if (!matchedRemoteIds.has(remoteOption.id)) {
      merged.push({ id: remoteOption.id, name: remoteOption.name, color: remoteOption.color, description: remoteOption.description });
    }
  }
  return { merged, matchedRemoteIds };
}

function isConverged(merged: OptionInput[], remoteOptions: RemoteSingleSelectOption[]): boolean {
  if (merged.length !== remoteOptions.length) return false;
  return merged.every((entry, index) => {
    const remote = remoteOptions[index];
    return entry.id === remote.id && entry.name === remote.name && entry.color === remote.color && entry.description === remote.description;
  });
}

/**
 * The D-16 read-then-echo builder. Two distinct absence reasons (never
 * conflated, cycle-4 HIGH-4): an `unset` project outcome is the fresh-create
 * input and produces a **noop**, so `planProject` remains reachable; a
 * `resolved` project with no `Status` field is the real anomaly and produces
 * a **blocked** entry, never an empty-array write that would blank the
 * field. Convergence (HIGH-B) is checked before anything is emitted: an
 * element-wise match against the remote's own option list emits zero
 * operations and one adoption checkpoint per GSD option instead of a
 * redundant destructive full-replace write.
 */
function planStatusOptionMerge(remote: BootstrapRemoteForMerge, strictMap: StrictMapLike, context: CompletionContext): StatusMergeResult | null {
  if (remote.projectOutcome === 'unset') return { kind: 'noop', reason: BOOTSTRAP_OPERATION_REASON.PROJECT_UNSET };
  if (!remote.statusField) {
    if (remote.projectOutcome === 'resolved') return { kind: 'blocked', reason: BOOTSTRAP_OPERATION_REASON.MISSING_STATUS_FIELD };
    return null;
  }

  const remoteOptions = remote.statusField.options ?? [];
  const { merged } = mergedOptionsArray(remoteOptions, strictMap);

  if (isConverged(merged, remoteOptions)) {
    return {
      kind: 'converged',
      checkpoints: GSD_STATUS_OPTIONS.map((gsdOption) => {
        const matched = merged.find((entry) => entry.name === gsdOption.name);
        return {
          logicalKey: BOOTSTRAP_LOGICAL_KEY.statusOption(gsdOption.name),
          nodeId: matched?.id as string,
          completionContext: context,
        };
      }),
    };
  }

  const keyMap: Record<string, string> = {};
  for (const gsdOption of GSD_STATUS_OPTIONS) keyMap[gsdOption.name] = BOOTSTRAP_LOGICAL_KEY.statusOption(gsdOption.name);

  const args: ArgvEntry[] = [
    'api', 'graphql',
    '-f', `query=${STATUS_MERGE_DOCUMENT}`,
    '-F', `fieldId=${remote.statusField.id}`,
    ...optionInputArgv('options', merged),
  ];

  const operation: MutationOperation = {
    kind: 'update',
    logicalKey: BOOTSTRAP_LOGICAL_KEY.field(STATUS_FIELD_NAME),
    args,
    completionContext: context,
    transport: OPERATION_TRANSPORT.GRAPHQL,
    action: OPERATION_ACTION.UPDATE,
    hasPointsBudget: false,
    contentCreation: false,
    captures: [{
      kind: 'each',
      listPath: 'updateProjectV2Field.projectV2Field.options',
      matchPath: 'name',
      nodeIdPath: 'id',
      keyMap,
    }],
  };
  return { kind: 'operation', operation };
}

// ─── planProject ────────────────────────────────────────────────────────────

const LINK_STATE = Object.freeze({
  LINKED: 'linked',
  UNLINKED: 'unlinked',
  INDETERMINATE: 'indeterminate',
} as const);

/** BOOT-01's default project title when no `github_sync.project_title` is configured (plan 03-03 Task 3). */
const DEFAULT_PROJECT_TITLE_SUFFIX = ' Roadmap';

// Duplicated from src/github-sync-bootstrap-remote.cts's BOOTSTRAP_DOCUMENTS,
// byte-for-byte — a differential test in tests/github-sync-bootstrap-plan.test.cjs
// pins the two copies against each other. Duplicated rather than imported
// because this module's header states zero I/O imports, and
// github-sync-bootstrap-remote.cts transitively requires the gh transport
// seam; STATUS_MERGE_DOCUMENT above sets the same precedent. No `rateLimit`
// selection — see the note at STATUS_MERGE_DOCUMENT (live-verified in plan
// 03-02: GitHub's `Mutation` type has no such field).
const CREATE_PROJECT_DOCUMENT =
  'mutation($ownerId:ID!,$title:String!) { # github-sync-bootstrap:createProject\n' +
  ' createProjectV2(input:{ownerId:$ownerId,title:$title}) { projectV2 { id number } } }';
const LINK_PROJECT_DOCUMENT =
  'mutation($projectId:ID!,$repositoryId:ID!) { # github-sync-bootstrap:linkProjectToRepository\n' +
  ' linkProjectV2ToRepository(input:{projectId:$projectId,repositoryId:$repositoryId}) { repository { id } } }';

interface ProjectPlanResult {
  operations: MutationOperation[];
  checkpoints: AdoptionCheckpoint[];
  blocked: Array<{ reason: string; detail?: string }>;
}

function emptyProjectPlan(): ProjectPlanResult {
  return { operations: [], checkpoints: [], blocked: [] };
}

/**
 * BOOT-01's project create/link/adopt/repair/not-found composer.
 *
 * - `target.projectNumber === null` → create-and-link: two operations under
 *   two DISTINCT logical keys (project, project-link), zero checkpoints.
 *   D-12: the create's owner id is the repository's OWNER node id, never a
 *   viewer id. RESEARCH Pitfall 4: the create input carries only ownerId and
 *   title — no repositoryId — so link stays independently retryable.
 * - `target.projectNumber` positive and the project resolved → adopt: an
 *   adoption checkpoint under the project key, recording what was observed
 *   rather than doing nothing (D-03, cycle-2 HIGH-A), then branches on the
 *   OBSERVED link state (D-14, cycle-2 HIGH-C) — linked emits a second
 *   checkpoint under the link key and zero operations; unlinked emits the
 *   link operation; indeterminate emits the link operation only when the
 *   strict map holds no link completion yet (converges after one run).
 *   D-15: no operation ever renames an adopted board's title.
 * - `target.projectNumber` positive and the project is absent → not-found:
 *   zero operations, zero checkpoints, one blocked entry (D-04).
 */
function planProject(
  remote: BootstrapRemoteForMerge,
  strictMap: StrictMapLike,
  target: BootstrapTarget,
  projectTitle: string | null,
  context: CompletionContext,
): ProjectPlanResult {
  const repository = remote.repository;
  if (!repository || typeof repository.ownerNodeId !== 'string' || repository.ownerNodeId.length === 0) {
    return { ...emptyProjectPlan(), blocked: [{ reason: BOOTSTRAP_OPERATION_REASON.OWNER_UNRESOLVABLE }] };
  }

  const projectKey = BOOTSTRAP_LOGICAL_KEY.project();
  const linkKey = BOOTSTRAP_LOGICAL_KEY.projectLink();

  if (target.projectNumber === null) {
    const title = projectTitle && projectTitle.length > 0 ? projectTitle : `${target.repo}${DEFAULT_PROJECT_TITLE_SUFFIX}`;
    const createOperation: MutationOperation = {
      kind: 'create-project',
      logicalKey: projectKey,
      args: [
        'api', 'graphql',
        '-f', `query=${CREATE_PROJECT_DOCUMENT}`,
        // SECURITY: every string variable rides the raw -f flag.
        '-f', `ownerId=${repository.ownerNodeId}`,
        '-f', `title=${title}`,
      ],
      completionContext: context,
      transport: OPERATION_TRANSPORT.GRAPHQL,
      action: OPERATION_ACTION.CREATE,
      hasPointsBudget: false,
      // Every operation that brings a new GitHub-side object into existence
      // declares content creation true (decided once for the whole phase —
      // see the paragraph at this flag's twin use in planStatusOptionMerge's
      // sibling create-path operations in plans 03-04/03-05).
      contentCreation: true,
      captures: [{ kind: 'node', logicalKey: projectKey, nodeIdPath: 'createProjectV2.projectV2.id', numberPath: 'createProjectV2.projectV2.number' }],
    };
    const linkArgs: ArgvEntry[] = [
      'api', 'graphql',
      '-f', `query=${LINK_PROJECT_DOCUMENT}`,
      '-f', { from: projectKey, part: ARGV_REF_PART.NODE_ID, prefix: 'projectId=' },
      '-f', `repositoryId=${repository.nodeId}`,
    ];
    const linkOperation: MutationOperation = {
      kind: 'link-project',
      logicalKey: linkKey,
      args: linkArgs,
      completionContext: context,
      transport: OPERATION_TRANSPORT.GRAPHQL,
      action: OPERATION_ACTION.LINK,
      hasPointsBudget: false,
      // Only re-points an existing object (the freshly created project) at
      // the repository — mints nothing new.
      contentCreation: false,
      captures: [{ kind: 'node', logicalKey: linkKey, nodeIdPath: 'linkProjectV2ToRepository.repository.id' }],
    };
    return { operations: [createOperation, linkOperation], checkpoints: [], blocked: [] };
  }

  // Adopt / repair / not-found: a positive project number is configured.
  if (remote.projectOutcome === 'absent') {
    return {
      ...emptyProjectPlan(),
      blocked: [{
        reason: BOOTSTRAP_OPERATION_REASON.PROJECT_NOT_FOUND,
        detail: `project number ${target.projectNumber} not found for owner ${repository.ownerLogin}`,
      }],
    };
  }

  // remote.projectOutcome === 'resolved' here: 'unset' cannot occur because
  // target.projectNumber !== null forces the caller to have issued the
  // project-scoped documents, and 'unavailable' is gated upstream in
  // planBootstrap's three-gate ordering.
  const projectNodeId = remote.projectNodeId;
  if (typeof projectNodeId !== 'string' || projectNodeId.length === 0) {
    return { ...emptyProjectPlan(), blocked: [{ reason: BOOTSTRAP_OPERATION_REASON.PROJECT_NOT_FOUND, detail: `project number ${target.projectNumber} resolved with no node id` }] };
  }

  const checkpoints: AdoptionCheckpoint[] = [{
    logicalKey: projectKey,
    nodeId: projectNodeId,
    remoteNumber: target.projectNumber,
    completionContext: context,
  }];

  if (repository.linkState === LINK_STATE.LINKED) {
    checkpoints.push({ logicalKey: linkKey, nodeId: repository.nodeId, completionContext: context });
    return { operations: [], checkpoints, blocked: [] };
  }

  const hasLinkCompletion = strictMap.kind === 'valid' && !!strictMap.map?.completions?.[linkKey];
  if (repository.linkState === LINK_STATE.INDETERMINATE && hasLinkCompletion) {
    return { operations: [], checkpoints, blocked: [] };
  }

  // unlinked, or indeterminate with no prior link completion: plan the link
  // (D-14/HIGH-C — never assumed linked merely because the project resolved).
  const linkArgs: ArgvEntry[] = [
    'api', 'graphql',
    '-f', `query=${LINK_PROJECT_DOCUMENT}`,
    '-f', `projectId=${projectNodeId}`,
    '-f', `repositoryId=${repository.nodeId}`,
  ];
  const linkOperation: MutationOperation = {
    kind: 'link-project',
    logicalKey: linkKey,
    args: linkArgs,
    completionContext: context,
    transport: OPERATION_TRANSPORT.GRAPHQL,
    action: OPERATION_ACTION.LINK,
    hasPointsBudget: false,
    contentCreation: false,
    captures: [{ kind: 'node', logicalKey: linkKey, nodeIdPath: 'linkProjectV2ToRepository.repository.id' }],
  };
  return { operations: [linkOperation], checkpoints, blocked: [] };
}

// ─── planBootstrap ──────────────────────────────────────────────────────────

interface DesiredStateLike { available: boolean; reason?: string; }
interface BootstrapTarget { owner: string; repo: string; repositoryNumber: number; projectNumber: number | null; }
interface PlanBootstrapInput {
  desired: DesiredStateLike;
  remote: BootstrapRemoteForMerge;
  strictMap: StrictMapLike;
  target: BootstrapTarget;
  projectTitle?: string | null;
}

interface BootstrapPlan {
  operations: MutationOperation[];
  checkpoints: AdoptionCheckpoint[];
  noops: Array<{ reason: string }>;
  blocked: Array<{ reason: string; detail?: string }>;
  uncertain: Array<{ reason: string }>;
}

function emptyPlan(): BootstrapPlan {
  return { operations: [], checkpoints: [], noops: [], blocked: [], uncertain: [] };
}

/**
 * The composer: applies the three-gate ordering in `planReconciliation`'s
 * exact sequence — desired unavailable, then remote unavailable, then map
 * blocking — each returning zero operations **and** zero checkpoints. The
 * remote-unavailable gate fires on `remote.available` alone, never on
 * `projectOutcome`: an `unset` or `absent` project is itself an available
 * read, and folding either into this gate would make the fresh-create path
 * unreachable (cycle-4 HIGH-4). The structure pass runs `planProject` first
 * and short-circuits every later structure builder (including their
 * checkpoints) when it blocks — plans 03-04/03-05 fill in the rest of the
 * structure pass on top of this. The options pass calls
 * `planStatusOptionMerge`.
 */
function planBootstrap(input: PlanBootstrapInput, { pass }: { pass: BootstrapPass }): BootstrapPlan {
  if (!input.desired.available) {
    return { ...emptyPlan(), blocked: [{ reason: BOOTSTRAP_OPERATION_REASON.DESIRED_UNAVAILABLE, detail: input.desired.reason }] };
  }
  if (!input.remote.available) {
    return { ...emptyPlan(), uncertain: [{ reason: BOOTSTRAP_OPERATION_REASON.REMOTE_UNAVAILABLE }] };
  }
  if (input.strictMap.kind === 'blocking') {
    return { ...emptyPlan(), blocked: [{ reason: BOOTSTRAP_OPERATION_REASON.MAP_BLOCKING, detail: input.strictMap.reason ?? 'invalid_schema' }] };
  }

  // Checkpoint contract clause 1a: one CompletionContext, built once here
  // from the resolved target, threaded verbatim to every stage builder.
  // planProject does not derive its own from the `target` it also receives.
  const context: CompletionContext = {
    owner: input.target.owner,
    repo: input.target.repo,
    repositoryNumber: input.target.repositoryNumber,
  };

  if (pass === BOOTSTRAP_PASS.STRUCTURE) {
    const projectPlan = planProject(input.remote, input.strictMap, input.target, input.projectTitle ?? null, context);
    if (projectPlan.blocked.length > 0) {
      return { ...emptyPlan(), blocked: projectPlan.blocked };
    }
    // Filled in further by plans 03-04/03-05 (fields, labels, milestones).
    return { ...emptyPlan(), operations: projectPlan.operations, checkpoints: projectPlan.checkpoints };
  }

  const merge = planStatusOptionMerge(input.remote, input.strictMap, context);
  if (!merge) return emptyPlan();
  if (merge.kind === 'noop') return { ...emptyPlan(), noops: [{ reason: merge.reason }] };
  if (merge.kind === 'blocked') return { ...emptyPlan(), blocked: [{ reason: merge.reason }] };
  if (merge.kind === 'converged') return { ...emptyPlan(), checkpoints: merge.checkpoints };
  return { ...emptyPlan(), operations: [merge.operation] };
}

export = {
  planBootstrap,
  planProject,
  planStatusOptionMerge,
  optionInputArgv,
  BOOTSTRAP_LOGICAL_KEY,
  BOOTSTRAP_OPERATION_REASON,
  BOOTSTRAP_PASS,
  GSD_STATUS_OPTIONS,
  STATUS_FIELD_NAME,
  DEFAULT_PROJECT_TITLE_SUFFIX,
  CREATE_PROJECT_DOCUMENT,
  LINK_PROJECT_DOCUMENT,
};
