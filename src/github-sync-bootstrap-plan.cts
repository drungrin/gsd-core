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
  // Task 3: a GSD label or milestone already exists (exact or, for a label,
  // case-variant) — the noop reason recorded alongside its adoption checkpoint.
  LABEL_EXISTS: 'label_exists',
  MILESTONE_EXISTS: 'milestone_exists',
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
/** Mirrors github-sync-bootstrap-remote.cts's `RestListEntry` — not imported (zero I/O). One decoded REST label or milestone. */
interface RestEntryLike { nodeId: string; name: string; number?: number; state?: string; }

interface BootstrapRemoteForMerge {
  available: boolean;
  /** Present on an unavailable read; the remote-layer reason, translated at the plan boundary — see translateRemoteReason. */
  reason?: string;
  projectOutcome: ProjectOutcome;
  statusField: RemoteStatusField | null;
  repository?: BootstrapRepositoryLike | null;
  projectNodeId?: string | null;
  /** Every field on the project, `Status` included — the shape plan 03-04's planFields/planAutonomousOptions consume. */
  fields?: RemoteStatusField[];
  /** BOOT-04: every repository label, from the REST list read (Task 2). */
  labels?: RestEntryLike[];
  /** BOOT-05: every repository Milestone (open and closed), from the REST list read (Task 2). */
  milestones?: RestEntryLike[];
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
    // remote rename), then by exact name (BOOT-03 adjacency edge). Both
    // lookups exclude a remote id already claimed by an earlier GSD option in
    // this same loop (LIVE FINDING, plan 03-03 -> plan 03-04): a stale or
    // cross-contaminated stored id could otherwise let two different GSD
    // options both resolve to the same remote entry, leaving the genuinely
    // correct remote option for the second name unmatched and pushed through
    // the catch-all below as if it were an unrelated custom option — the
    // outgoing array would then carry the same id twice under two different
    // names, which is exactly the shape a full-replace write cannot honor for
    // both entries.
    const storedId = completions[BOOTSTRAP_LOGICAL_KEY.statusOption(gsdOption.name)]?.nodeId;
    const byStoredId = storedId
      ? remoteOptions.find((option) => option.id === storedId && !matchedRemoteIds.has(option.id))
      : undefined;
    const byName = byStoredId ?? remoteOptions.find((option) => option.name === gsdOption.name && !matchedRemoteIds.has(option.id));
    if (byName) {
      matchedRemoteIds.add(byName.id);
      merged.push({ id: byName.id, name: byName.name, color: byName.color, description: byName.description });
    } else {
      merged.push({ name: gsdOption.name, color: gsdOption.color, description: gsdOption.description });
    }
  }
  for (const remoteOption of remoteOptions) {
    if (!matchedRemoteIds.has(remoteOption.id)) {
      matchedRemoteIds.add(remoteOption.id);
      merged.push({ id: remoteOption.id, name: remoteOption.name, color: remoteOption.color, description: remoteOption.description });
    }
  }
  return { merged, matchedRemoteIds };
}

/**
 * LIVE FINDING (plan 03-03 -> plan 03-04): the original implementation
 * compared `merged` against `remoteOptions` by ARRAY POSITION. `merged` is
 * always built in `GSD_STATUS_OPTIONS`' fixed declaration order followed by
 * unmatched remote options in their read order; `remoteOptions` is whatever
 * order the live read returns, which is not contractually the write-time
 * order (observed live, 2026-08-01, board #9: a positional comparison
 * disagreed with a byName-correct merge for `Blocked`/`Deferred`/a custom
 * option purely because their remote-read position did not match
 * `GSD_STATUS_OPTIONS`' declared position, even though every one of them had
 * already matched by id or by name in `mergedOptionsArray`). A positional
 * mismatch alone triggered a real, destructive `singleSelectOptions`
 * full-replace write for options that were already correctly identified —
 * exactly the needless-write exposure D-16/T-03-22 exist to avoid, and the
 * live evidence shows that exposure is not merely theoretical: some of those
 * options came back from that live write re-minted under fresh ids despite
 * the merge having sent their existing ones.
 *
 * Convergence is therefore now a multiset comparison keyed by id, order
 * -independent: every remote option must appear exactly once in `merged`
 * under the same id, name, color, and description, and vice versa. Only a
 * genuine content divergence (a missing/extra option, or a changed name,
 * color, or description) is a real divergence; a same-content reordering is
 * not.
 */
function isConverged(merged: OptionInput[], remoteOptions: RemoteSingleSelectOption[]): boolean {
  if (merged.length !== remoteOptions.length) return false;
  const remoteById = new Map(remoteOptions.map((option) => [option.id, option]));
  if (remoteById.size !== remoteOptions.length) return false; // duplicate remote ids: never claim convergence
  const seenIds = new Set<string>();
  for (const entry of merged) {
    if (entry.id === undefined) return false; // an id-less entry has no remote counterpart yet
    if (seenIds.has(entry.id)) return false; // merged itself must carry no duplicate id
    seenIds.add(entry.id);
    const remote = remoteById.get(entry.id);
    if (!remote) return false;
    if (entry.name !== remote.name || entry.color !== remote.color || entry.description !== remote.description) return false;
  }
  return true;
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

// ─── planFields ─────────────────────────────────────────────────────────────

/**
 * The stage a builder's operation/checkpoint was produced by — read by plan
 * 03-06's report instead of inferred from the logical key's prefix (plan
 * 03-04 Task 3). `planAutonomousOptions`' merged write is the case that
 * forces this: it is produced by the AUTONOMOUS stage but its logical key
 * carries the `field:` prefix (the `Autonomous` field's own reserved key),
 * so a prefix-inferring report would silently file it under FIELDS instead.
 * Declared here (not in `github-sync-operation.cts`, which this plan does
 * not touch) as a local intersection type — `MutationOperation` and
 * `AdoptionCheckpoint` accept any variable carrying their required shape
 * plus extra properties, so a stage-tagged value still satisfies both.
 */
const BOOTSTRAP_STAGE = Object.freeze({
  PROJECT: 'project',
  FIELDS: 'fields',
  STATUS: 'status',
  AUTONOMOUS: 'autonomous',
  LABELS: 'labels',
  MILESTONES: 'milestones',
} as const);
type BootstrapStage = typeof BOOTSTRAP_STAGE[keyof typeof BOOTSTRAP_STAGE];
type StageTaggedOperation = MutationOperation & { stage: BootstrapStage };
type StageTaggedCheckpoint = AdoptionCheckpoint & { stage: BootstrapStage };

const FIELD_DATA_TYPE = Object.freeze({
  TEXT: 'TEXT',
  NUMBER: 'NUMBER',
  SINGLE_SELECT: 'SINGLE_SELECT',
} as const);
type FieldDataType = typeof FIELD_DATA_TYPE[keyof typeof FIELD_DATA_TYPE];

interface GsdFieldDeclaration { name: string; dataType: FieldDataType; }

/**
 * D-20's five fixed field declarations, in create order. `Phase` is TEXT so
 * an inserted decimal phase id (e.g. `2.1`) round-trips exactly as it
 * appears on disk — a NUMBER field would coerce or reject it. `Wave` is
 * NUMBER so Phase 6's By-Wave view can sort and filter numerically — a TEXT
 * field would only ever string-sort. Slugs are never concatenated inline;
 * every consumer derives the reserved key through `BOOTSTRAP_LOGICAL_KEY.field`.
 */
const GSD_FIELDS: readonly GsdFieldDeclaration[] = Object.freeze([
  Object.freeze({ name: 'GSD ID', dataType: FIELD_DATA_TYPE.TEXT }),
  Object.freeze({ name: 'Phase', dataType: FIELD_DATA_TYPE.TEXT }),
  Object.freeze({ name: 'Requirements', dataType: FIELD_DATA_TYPE.TEXT }),
  Object.freeze({ name: 'Wave', dataType: FIELD_DATA_TYPE.NUMBER }),
  Object.freeze({ name: 'Autonomous', dataType: FIELD_DATA_TYPE.SINGLE_SELECT }),
]);

/**
 * D-22: the `Autonomous` single-select GSD itself creates. Colours/
 * descriptions are set once on create and never reconciled afterward (D-18,
 * the same rule `GSD_STATUS_OPTIONS` follows) — chosen to match the create
 * example RESEARCH.md records for this exact field.
 */
const GSD_AUTONOMOUS_OPTIONS = Object.freeze([
  Object.freeze({ name: 'Yes', color: 'GREEN', description: '' }),
  Object.freeze({ name: 'No', color: 'RED', description: '' }),
] as const);

const AUTONOMOUS_FIELD_NAME = 'Autonomous';

// Duplicated from src/github-sync-bootstrap-remote.cts's BOOTSTRAP_DOCUMENTS,
// byte-for-byte — a differential test pins the copies against each other, the
// same pattern CREATE_PROJECT_DOCUMENT/LINK_PROJECT_DOCUMENT establish above.
// No `rateLimit` selection, for the same live-verified reason.
const CREATE_FIELD_TEXT_DOCUMENT =
  'mutation($projectId:ID!,$name:String!) { # github-sync-bootstrap:createFieldText\n' +
  ' createProjectV2Field(input:{projectId:$projectId,dataType:TEXT,name:$name}) { projectV2Field { ... on ProjectV2FieldCommon { id name dataType } } } }';
const CREATE_FIELD_NUMBER_DOCUMENT =
  'mutation($projectId:ID!,$name:String!) { # github-sync-bootstrap:createFieldNumber\n' +
  ' createProjectV2Field(input:{projectId:$projectId,dataType:NUMBER,name:$name}) { projectV2Field { ... on ProjectV2FieldCommon { id name dataType } } } }';
const CREATE_FIELD_SINGLE_SELECT_DOCUMENT =
  'mutation($projectId:ID!,$name:String!,$options:[ProjectV2SingleSelectFieldOptionInput!]!) { # github-sync-bootstrap:createFieldSingleSelect\n' +
  ' createProjectV2Field(input:{projectId:$projectId,dataType:SINGLE_SELECT,name:$name,singleSelectOptions:$options}) { projectV2Field { ... on ProjectV2FieldCommon { id name dataType } } } }';
const RENAME_FIELD_DOCUMENT =
  'mutation($fieldId:ID!,$name:String!) { # github-sync-bootstrap:renameField\n' +
  ' updateProjectV2Field(input:{fieldId:$fieldId,name:$name}) { projectV2Field { ... on ProjectV2FieldCommon { id name dataType } } } }';

function fieldCreateDocument(dataType: FieldDataType): string {
  if (dataType === FIELD_DATA_TYPE.TEXT) return CREATE_FIELD_TEXT_DOCUMENT;
  if (dataType === FIELD_DATA_TYPE.NUMBER) return CREATE_FIELD_NUMBER_DOCUMENT;
  return CREATE_FIELD_SINGLE_SELECT_DOCUMENT;
}

function fieldTypeMismatchDetail(gsdField: GsdFieldDeclaration, observedDataType: string): string {
  return `field "${gsdField.name}" is ${observedDataType} but GSD requires ${gsdField.dataType}`;
}

/**
 * D-23/D-17's shared identity rule: resolve a GSD field declaration against
 * the remote's field list by the sync map's stored node id first (survives a
 * remote rename), then by exact name. `claimedRemoteIds` excludes a remote
 * field already matched to an earlier GSD field in the same pass — the same
 * cross-contamination guard `mergedOptionsArray` carries (LIVE FINDING, plan
 * 03-03 -> plan 03-04): a stale or duplicated stored id must never let two
 * different GSD fields resolve to the same remote object.
 */
function resolveFieldIdentity(
  gsdField: GsdFieldDeclaration,
  remoteFields: RemoteStatusField[],
  strictMap: StrictMapLike,
  claimedRemoteIds: Set<string>,
): { field: RemoteStatusField; matchedBy: 'id' | 'name' } | undefined {
  const completions = strictMap.kind === 'valid' ? strictMap.map?.completions ?? {} : {};
  const storedId = completions[BOOTSTRAP_LOGICAL_KEY.field(gsdField.name)]?.nodeId;
  if (storedId) {
    const byId = remoteFields.find((field) => field.id === storedId && !claimedRemoteIds.has(field.id));
    if (byId) return { field: byId, matchedBy: 'id' };
  }
  const byName = remoteFields.find((field) => field.name === gsdField.name && !claimedRemoteIds.has(field.id));
  if (byName) return { field: byName, matchedBy: 'name' };
  return undefined;
}

/**
 * Every run-fatal condition this phase declares — today exactly a field
 * whose name matches a GSD declaration but whose `dataType` does not (D-21).
 * Run first in `planBootstrap`, before any stage builder contributes
 * anything, for both passes: because it runs before the pass dispatch rather
 * than inside `planFields` itself, it suppresses every stage the dispatch
 * would otherwise have reached — the project create, the `Status` merge, and
 * every checkpoint alike — never only the field stage. The
 * `deleteProjectV2Field` mutation is never referenced anywhere in this
 * module; a wrong-typed field is reported, not repaired, because that
 * mutation destroys every value the field holds and for a field GSD did not
 * create that is the developer's data.
 */
function validateFatalConditions(remote: BootstrapRemoteForMerge, strictMap: StrictMapLike): Array<{ reason: string; detail?: string }> {
  const remoteFields = remote.fields ?? [];
  const claimedRemoteIds = new Set<string>();
  const blocked: Array<{ reason: string; detail?: string }> = [];
  for (const gsdField of GSD_FIELDS) {
    const match = resolveFieldIdentity(gsdField, remoteFields, strictMap, claimedRemoteIds);
    if (!match) continue;
    claimedRemoteIds.add(match.field.id);
    if (match.field.dataType !== gsdField.dataType) {
      blocked.push({ reason: BOOTSTRAP_OPERATION_REASON.FIELD_TYPE_MISMATCH, detail: fieldTypeMismatchDetail(gsdField, match.field.dataType) });
    }
  }
  return blocked;
}

interface FieldPlanResult {
  operations: StageTaggedOperation[];
  checkpoints: StageTaggedCheckpoint[];
  blocked: Array<{ reason: string; detail?: string }>;
}

function buildCreateFieldOperation(gsdField: GsdFieldDeclaration, fieldKey: string, context: CompletionContext): StageTaggedOperation {
  const projectRef: ArgvEntry = { from: BOOTSTRAP_LOGICAL_KEY.project(), part: ARGV_REF_PART.NODE_ID, prefix: 'projectId=' };
  const args: ArgvEntry[] = [
    'api', 'graphql',
    '-f', `query=${fieldCreateDocument(gsdField.dataType)}`,
    '-f', projectRef,
    '-f', `name=${gsdField.name}`,
  ];
  if (gsdField.dataType === FIELD_DATA_TYPE.SINGLE_SELECT) {
    args.push(...optionInputArgv('options', GSD_AUTONOMOUS_OPTIONS.map((option) => ({ ...option }))));
  }
  return {
    kind: 'create-field',
    logicalKey: fieldKey,
    args,
    completionContext: context,
    transport: OPERATION_TRANSPORT.GRAPHQL,
    action: OPERATION_ACTION.CREATE,
    hasPointsBudget: false,
    // Every operation that brings a new GitHub-side object into existence
    // declares content creation true (decided once for the whole phase — see
    // the paragraph at this flag's first use in planProject's create path).
    contentCreation: true,
    captures: [{ kind: 'node', logicalKey: fieldKey, nodeIdPath: 'createProjectV2Field.projectV2Field.id' }],
    stage: BOOTSTRAP_STAGE.FIELDS,
  };
}

function buildRenameFieldOperation(matchedField: RemoteStatusField, gsdField: GsdFieldDeclaration, fieldKey: string, context: CompletionContext): StageTaggedOperation {
  return {
    kind: 'rename-field',
    logicalKey: fieldKey,
    args: [
      'api', 'graphql',
      '-f', `query=${RENAME_FIELD_DOCUMENT}`,
      // The matched field's id is already known (observed on this run's
      // remote read), so it rides a literal, not a late-bound reference.
      '-f', `fieldId=${matchedField.id}`,
      '-f', `name=${gsdField.name}`,
    ],
    completionContext: context,
    transport: OPERATION_TRANSPORT.GRAPHQL,
    action: OPERATION_ACTION.UPDATE,
    hasPointsBudget: false,
    // Re-points an existing field's name — mints nothing new.
    contentCreation: false,
    captures: [{ kind: 'node', logicalKey: fieldKey, nodeIdPath: 'updateProjectV2Field.projectV2Field.id' }],
    stage: BOOTSTRAP_STAGE.FIELDS,
  };
}

/**
 * D-20/D-21/D-23's field composer. For each `GSD_FIELDS` declaration,
 * resolves identity via `resolveFieldIdentity` and branches:
 *
 * - **no match** → create, project id late-bound (the field may be planned
 *   before the project exists — the same late-binding `planProject`'s link
 *   operation uses).
 * - **matched, correct type, canonical name** (by id or by name) → no
 *   operation; a checkpoint carrying the observed node id, unconditionally.
 *   The by-id case keeps an already-recorded entry current at zero I/O cost
 *   (plan 03-02's fold compares and skips the write when nothing changed);
 *   the by-name case is BOTH the HIGH-A repair path for a board GSD did not
 *   create AND the stale-id repair (non-HIGH #7's field analogue) in one
 *   branch, because `recordCompletion` replaces the entry at a repeated key.
 * - **matched, correct type, name differs** → one rename operation
 *   restoring the canonical name, no checkpoint (the rename's own capture
 *   records it from the confirmed response).
 * - **matched, `dataType` differs** → a blocked entry. In practice
 *   `validateFatalConditions` already suppressed the whole run before this
 *   function is even called from `planBootstrap` — this branch exists so
 *   `planFields` is independently correct when exercised directly.
 *
 * The built-in `Status` field, when present in the remote snapshot, is
 * always checkpointed under its own field-namespace key: BOOT-06 needs its
 * node id, and it arrives in the same read this function already consumes.
 */
function planFields(remote: BootstrapRemoteForMerge, strictMap: StrictMapLike, context: CompletionContext): FieldPlanResult {
  const remoteFields = remote.fields ?? [];
  const claimedRemoteIds = new Set<string>();
  const operations: StageTaggedOperation[] = [];
  const checkpoints: StageTaggedCheckpoint[] = [];
  const blocked: Array<{ reason: string; detail?: string }> = [];

  for (const gsdField of GSD_FIELDS) {
    const fieldKey = BOOTSTRAP_LOGICAL_KEY.field(gsdField.name);
    const match = resolveFieldIdentity(gsdField, remoteFields, strictMap, claimedRemoteIds);
    if (!match) {
      operations.push(buildCreateFieldOperation(gsdField, fieldKey, context));
      continue;
    }
    claimedRemoteIds.add(match.field.id);
    if (match.field.dataType !== gsdField.dataType) {
      blocked.push({ reason: BOOTSTRAP_OPERATION_REASON.FIELD_TYPE_MISMATCH, detail: fieldTypeMismatchDetail(gsdField, match.field.dataType) });
      continue;
    }
    if (match.field.name !== gsdField.name) {
      operations.push(buildRenameFieldOperation(match.field, gsdField, fieldKey, context));
      continue;
    }
    checkpoints.push({ logicalKey: fieldKey, nodeId: match.field.id, completionContext: context, stage: BOOTSTRAP_STAGE.FIELDS });
  }

  if (remote.statusField) {
    checkpoints.push({
      logicalKey: BOOTSTRAP_LOGICAL_KEY.field(STATUS_FIELD_NAME),
      nodeId: remote.statusField.id,
      completionContext: context,
      stage: BOOTSTRAP_STAGE.FIELDS,
    });
  }

  return { operations, checkpoints, blocked };
}

// ─── planAutonomousOptions ──────────────────────────────────────────────────

interface AutonomousPlanResult {
  operations: StageTaggedOperation[];
}

/**
 * D-22's prune-to-exactly-declared composer for `Autonomous`, the one
 * single-select GSD itself creates. Deliberately the opposite policy from
 * `planStatusOptionMerge`'s preserve-and-append: `Status` is a built-in field
 * a developer may already be using, so every existing option (GSD-named or
 * custom) is kept; `Autonomous` carries no prior developer claim, so its
 * option set is exactly `GSD_AUTONOMOUS_OPTIONS` and any extra is dropped.
 * Two policies, each with a stated reason (D-16 vs D-22) — not an
 * inconsistency.
 *
 * Resolves the field by its own reserved completion first, then by exact
 * name (the same identity rule `planFields` uses for the field itself — this
 * builder never re-derives it independently). Absent from the snapshot ->
 * zero operations, both because the field genuinely does not exist yet (its
 * own create call already supplies both options in the same request) and
 * because a field created THIS run may not yet be visible in a stale
 * snapshot — the caller re-reads before calling this builder in that case
 * (the router's mutated-key re-read boundary).
 */
function planAutonomousOptions(remote: BootstrapRemoteForMerge, strictMap: StrictMapLike, context: CompletionContext): AutonomousPlanResult {
  const remoteFields = remote.fields ?? [];
  const claimedRemoteIds = new Set<string>();
  const match = resolveFieldIdentity({ name: AUTONOMOUS_FIELD_NAME, dataType: FIELD_DATA_TYPE.SINGLE_SELECT }, remoteFields, strictMap, claimedRemoteIds);
  if (!match) return { operations: [] };

  const remoteOptions = match.field.options ?? [];
  const merged: OptionInput[] = [];
  const matchedRemoteOptionIds = new Set<string>();
  for (const gsdOption of GSD_AUTONOMOUS_OPTIONS) {
    const byName = remoteOptions.find((option) => option.name === gsdOption.name && !matchedRemoteOptionIds.has(option.id));
    if (byName) {
      matchedRemoteOptionIds.add(byName.id);
      // D-18: colour/description are echoed verbatim from the remote, never
      // overwritten from the local declaration once an option exists.
      merged.push({ id: byName.id, name: byName.name, color: byName.color, description: byName.description });
    } else {
      merged.push({ name: gsdOption.name, color: gsdOption.color, description: gsdOption.description });
    }
  }
  // Every remote option not corresponding to a declared GSD option is
  // omitted here (D-22's prune) — the deliberate opposite of
  // mergedOptionsArray's catch-all append.

  const alreadyConverged = merged.length === remoteOptions.length && merged.every((entry) => {
    const remoteOption = remoteOptions.find((option) => option.id === entry.id);
    return !!remoteOption && entry.name === remoteOption.name && entry.color === remoteOption.color && entry.description === remoteOption.description;
  });
  if (alreadyConverged) return { operations: [] };

  const mintsNewOption = merged.some((entry) => entry.id === undefined);
  const fieldKey = BOOTSTRAP_LOGICAL_KEY.field(AUTONOMOUS_FIELD_NAME);
  const operation: StageTaggedOperation = {
    kind: 'update',
    logicalKey: fieldKey,
    args: [
      'api', 'graphql',
      '-f', `query=${STATUS_MERGE_DOCUMENT}`,
      '-F', `fieldId=${match.field.id}`,
      ...optionInputArgv('options', merged),
    ],
    completionContext: context,
    transport: OPERATION_TRANSPORT.GRAPHQL,
    action: OPERATION_ACTION.UPDATE,
    hasPointsBudget: false,
    contentCreation: mintsNewOption,
    // A single node capture under the field's own key — not an each-capture:
    // only Status options get per-option completions (D-08), because only
    // Status options are individually referenced by later phases.
    captures: [{ kind: 'node', logicalKey: fieldKey, nodeIdPath: 'updateProjectV2Field.projectV2Field.id' }],
    // Produced by the AUTONOMOUS stage even though its logical key carries
    // the field: prefix — the case that breaks prefix-inferred reporting
    // (plan 03-04 Task 3 / plan 03-06's per-stage counts).
    stage: BOOTSTRAP_STAGE.AUTONOMOUS,
  };
  return { operations: [operation] };
}

// ─── REST endpoint path (duplicated from github-sync-bootstrap-remote.cts) ──
//
// This module declares zero I/O imports (its own header, and every mutation
// document above is duplicated rather than imported for the same reason).
// `bootstrapRestPath` therefore duplicates only the pure path-BUILDING half
// of that module's `restPath` — not the `assertPathSafeTarget` safety check,
// which stays exactly where it is: `context.owner`/`context.repo` reaching
// this module have already passed that guard, because `planBootstrap` only
// ever runs once `input.remote.available` is true, and the remote reader
// (Task 2) never sets that flag for a target that failed the guard.

function bootstrapRestPath(owner: string, repo: string, suffix: string): string {
  return `repos/${owner}/${repo}${suffix}`;
}

// ─── planLabels ─────────────────────────────────────────────────────────────

interface GsdLabelDeclaration { name: string; color: string; description: string; }

/** BOOT-04's two fixed label declarations. Colour/description chosen at implementation time — never reconciled after creation (D-18's sibling rule). */
const GSD_LABELS: readonly GsdLabelDeclaration[] = Object.freeze([
  Object.freeze({ name: 'gsd:phase', color: '5319E7', description: 'GSD phase-scoped issue' }),
  Object.freeze({ name: 'gsd:plan', color: '1D76DB', description: 'GSD plan-scoped issue' }),
]);

/** ASCII-only case fold — every GSD label literal is ASCII, so this is sufficient and avoids any locale-dependent Unicode casing behavior. */
function asciiLowerCase(value: string): string {
  return value.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

function buildCreateLabelOperation(gsdLabel: GsdLabelDeclaration, labelKey: string, context: CompletionContext): StageTaggedOperation {
  const restApiPath = bootstrapRestPath(context.owner, context.repo, '/labels');
  return {
    kind: 'create-label',
    logicalKey: labelKey,
    args: [
      'api', restApiPath, '-X', 'POST',
      '-f', `name=${gsdLabel.name}`,
      '-f', `color=${gsdLabel.color}`,
      '-f', `description=${gsdLabel.description}`,
    ],
    completionContext: context,
    transport: OPERATION_TRANSPORT.REST,
    action: OPERATION_ACTION.CREATE,
    hasPointsBudget: false,
    // Every operation that brings a new GitHub-side object into existence
    // declares content creation true — the phase-wide decision (planProject's
    // create path) now covers REST creates too (D-10).
    contentCreation: true,
    captures: [{ kind: 'node', logicalKey: labelKey, nodeIdPath: 'node_id' }],
    stage: BOOTSTRAP_STAGE.LABELS,
  };
}

interface LabelPlanResult {
  operations: StageTaggedOperation[];
  checkpoints: StageTaggedCheckpoint[];
  noops: Array<{ reason: string; detail?: string }>;
}

/**
 * BOOT-04's list-then-create composer. Existence is decided from the live
 * label list every run — never from `.planning/.github-sync.json` — because
 * a label is a named, human-discoverable object a developer can create by
 * hand outside `init`; `strictMap` is accepted for signature symmetry with
 * `planFields`/`planMilestones` but is never consulted here for that reason.
 *
 * Two-tier comparison per GSD label (T-03-32):
 *   1. **Exact** — a live label whose raw name equals the GSD literal under
 *      `===` — zero operations, one noop, one adoption checkpoint carrying
 *      its node id.
 *   2. **Case variant** — failing tier one, a live label whose name equals
 *      the GSD literal after ASCII case folding on both sides — zero
 *      operations, one noop whose detail names the observed spelling, one
 *      adoption checkpoint under GSD's own reserved key carrying that
 *      label's node id. Never renamed, never duplicated.
 * Anything else is missing: one create operation. A label differing by more
 * than case is not GSD's and produces no operation, no noop, no checkpoint.
 * Never an edit or a delete — only creates.
 */
function planLabels(remote: BootstrapRemoteForMerge, strictMap: StrictMapLike, context: CompletionContext): LabelPlanResult {
  const remoteLabels = remote.labels ?? [];
  const operations: StageTaggedOperation[] = [];
  const checkpoints: StageTaggedCheckpoint[] = [];
  const noops: Array<{ reason: string; detail?: string }> = [];

  for (const gsdLabel of GSD_LABELS) {
    const labelKey = BOOTSTRAP_LOGICAL_KEY.label(gsdLabel.name);
    const exact = remoteLabels.find((label) => label.name === gsdLabel.name);
    if (exact) {
      noops.push({ reason: BOOTSTRAP_OPERATION_REASON.LABEL_EXISTS });
      checkpoints.push({ logicalKey: labelKey, nodeId: exact.nodeId, completionContext: context, stage: BOOTSTRAP_STAGE.LABELS });
      continue;
    }
    const variant = remoteLabels.find((label) => asciiLowerCase(label.name) === asciiLowerCase(gsdLabel.name));
    if (variant) {
      noops.push({ reason: BOOTSTRAP_OPERATION_REASON.LABEL_EXISTS, detail: `existing label spelled "${variant.name}"` });
      checkpoints.push({ logicalKey: labelKey, nodeId: variant.nodeId, completionContext: context, stage: BOOTSTRAP_STAGE.LABELS });
      continue;
    }
    operations.push(buildCreateLabelOperation(gsdLabel, labelKey, context));
  }
  return { operations, checkpoints, noops };
}

// ─── planMilestones ─────────────────────────────────────────────────────────

/**
 * Matches a leading version token: optional leading ASCII whitespace, a
 * lowercase `v`, one or more digits, zero or more dot-separated digit
 * groups, terminated at a word boundary. Returns null when the token is not
 * in the leading position — identity is the token in the leading position,
 * never anywhere in the string (D-26).
 */
const MILESTONE_VERSION_TOKEN = /^[ \t]*(v\d+(?:\.\d+)*)\b/;

function parseMilestoneVersionToken(title: string): string | null {
  const match = MILESTONE_VERSION_TOKEN.exec(title);
  return match ? match[1] : null;
}

function buildCreateMilestoneOperation(desiredMilestone: DesiredMilestoneLike, milestoneKey: string, context: CompletionContext): StageTaggedOperation {
  const restApiPath = bootstrapRestPath(context.owner, context.repo, '/milestones');
  return {
    kind: 'create-milestone',
    logicalKey: milestoneKey,
    args: [
      'api', restApiPath, '-X', 'POST',
      '-f', `title=${desiredMilestone.title}`,
      '-f', `description=${desiredMilestone.description}`,
      '-f', `state=${desiredMilestone.archived ? 'closed' : 'open'}`,
    ],
    completionContext: context,
    transport: OPERATION_TRANSPORT.REST,
    action: OPERATION_ACTION.CREATE,
    hasPointsBudget: false,
    contentCreation: true,
    captures: [{ kind: 'node', logicalKey: milestoneKey, nodeIdPath: 'node_id', numberPath: 'number' }],
    stage: BOOTSTRAP_STAGE.MILESTONES,
  };
}

/**
 * Resolves a desired milestone against the live list by stored completion
 * id first (D-17/D-23's shared rule), then by the parsed leading version
 * token of each remote title matching the desired version (D-26).
 */
function resolveMilestoneIdentity(desiredMilestone: DesiredMilestoneLike, remoteMilestones: RestEntryLike[], strictMap: StrictMapLike): RestEntryLike | undefined {
  const completions = strictMap.kind === 'valid' ? strictMap.map?.completions ?? {} : {};
  const storedId = completions[BOOTSTRAP_LOGICAL_KEY.milestone(desiredMilestone.version)]?.nodeId;
  if (storedId) {
    const byId = remoteMilestones.find((milestone) => milestone.nodeId === storedId);
    if (byId) return byId;
  }
  return remoteMilestones.find((milestone) => parseMilestoneVersionToken(milestone.name) === desiredMilestone.version);
}

interface MilestonePlanResult {
  operations: StageTaggedOperation[];
  checkpoints: StageTaggedCheckpoint[];
  noops: Array<{ reason: string; detail?: string }>;
}

/**
 * BOOT-05's list-then-create composer, D-28: consumes the desired-state
 * milestone array `readDesiredState` already deduplicated — never a local
 * ROADMAP.md or STATE.md read. A match emits zero operations, one noop, and
 * one adoption checkpoint carrying the live entry's node id and its number
 * in the remote-number slot; no match emits a create with the closed state
 * when the desired entry's `archived` flag is true, open otherwise (D-25).
 * Never emits a field that sets a due date, and never emits an operation
 * that updates an existing milestone's title, description, or state — D-27
 * sets the description once at creation and never reconciles it.
 */
function planMilestones(desired: DesiredStateLike, remote: BootstrapRemoteForMerge, strictMap: StrictMapLike, context: CompletionContext): MilestonePlanResult {
  const desiredMilestones = desired.milestones ?? [];
  const remoteMilestones = remote.milestones ?? [];
  const operations: StageTaggedOperation[] = [];
  const checkpoints: StageTaggedCheckpoint[] = [];
  const noops: Array<{ reason: string; detail?: string }> = [];

  for (const desiredMilestone of desiredMilestones) {
    const milestoneKey = BOOTSTRAP_LOGICAL_KEY.milestone(desiredMilestone.version);
    const match = resolveMilestoneIdentity(desiredMilestone, remoteMilestones, strictMap);
    if (match) {
      noops.push({ reason: BOOTSTRAP_OPERATION_REASON.MILESTONE_EXISTS });
      checkpoints.push({
        logicalKey: milestoneKey, nodeId: match.nodeId, completionContext: context, stage: BOOTSTRAP_STAGE.MILESTONES,
        ...(match.number === undefined ? {} : { remoteNumber: match.number }),
      });
      continue;
    }
    operations.push(buildCreateMilestoneOperation(desiredMilestone, milestoneKey, context));
  }
  return { operations, checkpoints, noops };
}

// ─── remote-layer to operation-layer reason translation (cycle-2 non-HIGH #14) ──

/**
 * Maps every `BootstrapRemoteReason` value (github-sync-bootstrap-remote.cts,
 * not imported here — zero I/O) onto this module's own reason catalog, so
 * `planBootstrap`'s blocked/uncertain lists only ever carry
 * `BOOTSTRAP_OPERATION_REASON` members. Both catalogs carry a
 * similarly-spelled member with different ownership; this is the single
 * translation point, tested by iterating every member of the remote-layer
 * reason enum rather than trusting that today's string values happen to
 * match.
 */
const REMOTE_REASON_TO_OPERATION_REASON: Record<string, string> = Object.freeze({
  ok: BOOTSTRAP_OPERATION_REASON.REMOTE_UNAVAILABLE,
  unsafe_target: BOOTSTRAP_OPERATION_REASON.UNSAFE_TARGET,
  remote_unavailable: BOOTSTRAP_OPERATION_REASON.REMOTE_UNAVAILABLE,
  rest_unavailable: BOOTSTRAP_OPERATION_REASON.REST_UNAVAILABLE,
});

function translateRemoteReason(remoteReason: string | undefined): string {
  return REMOTE_REASON_TO_OPERATION_REASON[remoteReason ?? ''] ?? BOOTSTRAP_OPERATION_REASON.REMOTE_UNAVAILABLE;
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

/** Mirrors github-sync-desired.cts's `DesiredMilestone` — not imported (D-28's single planning-file reader lives there, not here). */
interface DesiredMilestoneLike { version: string; name: string; title: string; description: string; archived: boolean; }
interface DesiredStateLike { available: boolean; reason?: string; milestones?: DesiredMilestoneLike[]; }
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
    return { ...emptyPlan(), uncertain: [{ reason: translateRemoteReason(input.remote.reason) }] };
  }
  if (input.strictMap.kind === 'blocking') {
    return { ...emptyPlan(), blocked: [{ reason: BOOTSTRAP_OPERATION_REASON.MAP_BLOCKING, detail: input.strictMap.reason ?? 'invalid_schema' }] };
  }

  // Run-scoped suppression (D-21), before any stage builder contributes
  // anything and before the pass dispatch below — the four stages that exist
  // at this wave (project, fields, Status, Autonomous) are all reached only
  // after this point, so a fatal condition here suppresses every one of them
  // with zero operations and zero checkpoints, not merely the field stage.
  // Plan 03-05's labels/milestones stages arrive after this gate too, once
  // they exist; plan 03-06's run-fatal composition case covers all six
  // together.
  const fatalBlocked = validateFatalConditions(input.remote, input.strictMap);
  if (fatalBlocked.length > 0) {
    return { ...emptyPlan(), blocked: fatalBlocked };
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
    const fieldsPlan = planFields(input.remote, input.strictMap, context);
    if (fieldsPlan.blocked.length > 0) {
      return { ...emptyPlan(), blocked: fieldsPlan.blocked };
    }
    // Labels then milestones, after fields (plan 03-05 Task 3) — one `init`
    // run's structure pass now covers project, fields, labels, and
    // milestones, in that order.
    const labelsPlan = planLabels(input.remote, input.strictMap, context);
    const milestonesPlan = planMilestones(input.desired, input.remote, input.strictMap, context);
    return {
      ...emptyPlan(),
      operations: [...projectPlan.operations, ...fieldsPlan.operations, ...labelsPlan.operations, ...milestonesPlan.operations],
      checkpoints: [...projectPlan.checkpoints, ...fieldsPlan.checkpoints, ...labelsPlan.checkpoints, ...milestonesPlan.checkpoints],
      noops: [...labelsPlan.noops, ...milestonesPlan.noops],
    };
  }

  const merge = planStatusOptionMerge(input.remote, input.strictMap, context);
  if (!merge) return emptyPlan();
  if (merge.kind === 'blocked') return { ...emptyPlan(), blocked: [{ reason: merge.reason }] };

  // planAutonomousOptions runs after planStatusOptionMerge, on every
  // non-null, non-blocked merge outcome — its own identity resolution
  // naturally contributes zero operations when the Autonomous field does not
  // yet exist in this snapshot (an unset/fresh-create project, or a project
  // whose structure pass has not created it yet).
  const autonomousPlan = planAutonomousOptions(input.remote, input.strictMap, context);

  if (merge.kind === 'noop') return { ...emptyPlan(), noops: [{ reason: merge.reason }], operations: autonomousPlan.operations };
  if (merge.kind === 'converged') return { ...emptyPlan(), checkpoints: merge.checkpoints, operations: autonomousPlan.operations };
  return { ...emptyPlan(), operations: [merge.operation, ...autonomousPlan.operations] };
}

export = {
  planBootstrap,
  planProject,
  planStatusOptionMerge,
  planFields,
  planAutonomousOptions,
  planLabels,
  planMilestones,
  parseMilestoneVersionToken,
  validateFatalConditions,
  optionInputArgv,
  BOOTSTRAP_LOGICAL_KEY,
  BOOTSTRAP_OPERATION_REASON,
  BOOTSTRAP_PASS,
  BOOTSTRAP_STAGE,
  GSD_STATUS_OPTIONS,
  GSD_FIELDS,
  GSD_AUTONOMOUS_OPTIONS,
  GSD_LABELS,
  STATUS_FIELD_NAME,
  DEFAULT_PROJECT_TITLE_SUFFIX,
  CREATE_PROJECT_DOCUMENT,
  LINK_PROJECT_DOCUMENT,
  CREATE_FIELD_TEXT_DOCUMENT,
  CREATE_FIELD_NUMBER_DOCUMENT,
  CREATE_FIELD_SINGLE_SELECT_DOCUMENT,
  RENAME_FIELD_DOCUMENT,
};
