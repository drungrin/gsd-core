'use strict';
/** Pure, deterministic reconciliation plan for desired state and typed inputs. */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import operationMod = require('./github-sync-operation.cjs');
import type { MutationOperation, ArgvEntry, CompletionContext } from './github-sync-operation.cts';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import bootstrapPlanMod = require('./github-sync-bootstrap-plan.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import issueBodyMod = require('./github-sync-issue-body.cjs');
import type { FieldValues, FieldName, ParsedFieldState, PlanStatus } from './github-sync-issue-body.cts';

const { OPERATION_TRANSPORT, OPERATION_ACTION, ARGV_REF_PART } = operationMod;
const { BOOTSTRAP_LOGICAL_KEY, GSD_LABELS, STATUS_FIELD_NAME } = bootstrapPlanMod;
const {
  renderNewIssueBody, renderPhaseRegion, contentHash, renderFieldState, parseFieldState, changedFields,
  renderNewPlanIssueBody, renderPlanRegion,
} = issueBodyMod;

const OPERATION_KIND = Object.freeze({ CREATE: 'create', UPDATE: 'update' } as const);
const OPERATION_REASON = Object.freeze({
  MAP_BLOCKING: 'map_blocking',
  REMOTE_UNAVAILABLE: 'remote_unavailable',
  DESIRED_UNAVAILABLE: 'desired_unavailable',
  IDENTITY_UNRESOLVABLE: 'identity_unresolvable',
  // Plan 04-01: a phase with no `issue:phase:<id>` completion and no
  // resolvable `milestone:<version>` completion cannot be created — an
  // issue is never created without the milestone it belongs to.
  MILESTONE_UNRESOLVED: 'milestone_unresolved',
  // Plan 04-01: the configured owner/repo carries a character `gh` treats
  // as magic in an endpoint path (brace, slash, at-sign, space) — the same
  // guard `github-sync-bootstrap-remote.cts`'s `assertPathSafeTarget` runs,
  // mirrored locally because this module declares no I/O and cannot import
  // that transport-adjacent module.
  UNSAFE_TARGET: 'unsafe_target',
  // Plan 04-04 Task 1: reserved for `github-sync-issue-update.cts`'s
  // read-splice-write stage (Task 2), which reports a damaged fence pair by
  // name rather than guessing a rewrite (D-03/D-11's report-don't-destroy
  // posture). This module never produces this reason itself — the
  // preparation stage's reports are surfaced separately from
  // `ReconciliationPlan.blocked` (see `github-sync-command-router.cts`'s
  // `sync` handler) — but `blocked`'s reason union is widened here so a
  // future caller that folds the two together type-checks without a cast.
  REGION_DAMAGED: 'region_damaged',
  // Plan 04-05 Task 2 (T-04-18): a phase whose `field:<slug>` or
  // `option:status:<slug>` completion is absent from the map — a field write
  // is never dispatched against an id that does not exist. Scoped to the one
  // phase whose id the field/option belongs to; every other phase in the
  // same run is unaffected.
  FIELD_UNRESOLVED: 'field_unresolved',
} as const);

/** The `gsd:phase` label's own name, as declared in `GSD_LABELS` (github-sync-bootstrap-plan.cts) — never re-spelled. */
const PHASE_LABEL_NAME = 'gsd:phase';
/** Phase 5: the `gsd:plan` label's own name, as declared in `GSD_LABELS` — never re-spelled. */
const PLAN_LABEL_NAME = 'gsd:plan';

/**
 * T-04-02: mirrors `PATH_SAFE_TARGET`/`assertPathSafeTarget` in
 * `github-sync-bootstrap-remote.cts` byte-for-byte. Duplicated rather than
 * imported for the same zero-I/O reason `github-sync-bootstrap-plan.cts`
 * duplicates its own mutation documents: that module transitively requires
 * the gh transport seam, and this module must not.
 */
const PATH_SAFE_TARGET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Returns the REST endpoint path for a phase issue, or `null` when the
 * guard fails. A `null` path is a typed blocked entry for every phase in
 * the run, never a thrown error and never a `gh` invocation — callers must
 * never invoke `gh` when this returns `null`.
 */
function phaseIssueRestPath(owner: string, repo: string, suffix: string): string | null {
  if (!PATH_SAFE_TARGET.test(owner) || !PATH_SAFE_TARGET.test(repo)) return null;
  return `repos/${owner}/${repo}${suffix}`;
}

interface DesiredPhase {
  id: string;
  title: string;
  goal: string;
  /** Plan 04-05: optional for the same fixture-compatibility reason as `requirements`/`status`; feeds `renderPhaseRegion`'s Success Criteria section. */
  successCriteria?: string[];
  /** Plan 04-04: optional so pre-04-02-shaped fixtures still type-check; `readDesiredState` always supplies it now. */
  requirements?: string[];
  /** Plan 04-04: optional for the same reason as `requirements`. */
  status?: string;
}
/** Mirrors `github-sync-desired.cts`'s `DesiredMilestone` shape — only the two fields this module needs. */
interface DesiredMilestone { version: string; archived: boolean; }
/**
 * Phase 5 (05-01 tracer scope): mirrors `github-sync-desired.cts`'s
 * `DesiredPlan` shape, limited to the fields this module's create branch
 * needs today. `wave`/`autonomous`/`dependsOn` arrive with plan 05-05's
 * field-value writer and dependency references — this tracer never reads
 * them, so they are deliberately absent here rather than declared unused.
 */
interface DesiredPlan {
  id: string;
  phaseId: string;
  title: string;
  tasks: string[];
  status: PlanStatus;
}
interface DesiredState { available: boolean; reason: string; phases: DesiredPhase[]; plans?: DesiredPlan[]; milestones?: DesiredMilestone[]; }
interface RemoteItem { id?: unknown; content?: { id?: unknown; number?: unknown } | null; }
interface RemoteSnapshot {
  available: boolean;
  reason: string;
  target?: { owner: string; repo: string; repositoryNumber: number; projectNumber: number; projectNodeId?: unknown };
  items?: RemoteItem[];
  issueNodeIds?: Record<string, string> | Record<number, string>;
}
interface StrictMapCompletion { nodeId: string; issueNumber?: number; contentHash?: string; fieldState?: string; }
interface StrictMap { kind: 'absent' | 'valid' | 'blocking'; reason?: string; map?: { completions?: Record<string, StrictMapCompletion> }; }

/**
 * Plan 04-04 Task 1: the read-splice-write stage's own input shape (D-08's
 * "the pure stage emits data, not a body string"). `milestoneKey` is not one
 * of the fields the plan's own truths enumerate by name, but
 * `github-sync-issue-update.cts` needs it to build the same late-bound
 * `ArgvRef` milestone reference `buildCreateIssueOperation` already uses —
 * carrying the literal `milestoneNumber` here would let the write drift from
 * whatever the map holds at apply time.
 */
interface PendingIssueUpdate {
  logicalKey: string;
  issueKey: string;
  issueNumber?: number;
  issueNodeId: string;
  title: string;
  region: string;
  milestoneNumber: number;
  milestoneKey: string;
  contentHash: string;
  completionContext: CompletionContext;
}

/** Plan 04-04 Task 1 (D-11): a phase whose completions still exist but is absent from the desired state. */
interface OrphanEntry {
  logicalKey: string;
  issueNumber?: number;
}

interface ReconciliationPlan {
  operations: MutationOperation[];
  noops: Array<{ logicalKey: string }>;
  blocked: Array<{
    reason: typeof OPERATION_REASON.MAP_BLOCKING
      | typeof OPERATION_REASON.DESIRED_UNAVAILABLE
      | typeof OPERATION_REASON.IDENTITY_UNRESOLVABLE
      | typeof OPERATION_REASON.MILESTONE_UNRESOLVED
      | typeof OPERATION_REASON.UNSAFE_TARGET
      | typeof OPERATION_REASON.REGION_DAMAGED
      | typeof OPERATION_REASON.FIELD_UNRESOLVED;
    detail?: string;
  }>;
  uncertain: Array<{ reason: typeof OPERATION_REASON.REMOTE_UNAVAILABLE }>;
  /** Plan 04-04 Task 1 (SC3/D-08/D-10): always present, empty when nothing applies — matches `noops`/`blocked`. */
  pendingIssueUpdates: PendingIssueUpdate[];
  /** Plan 04-04 Task 1 (D-11): always present, empty when nothing applies. */
  orphans: OrphanEntry[];
  /**
   * Plan 04-04 Task 1 (D-12) seam: the changed-field decision per phase,
   * computed here from `changedFields` but not yet built into
   * `MutationOperation`s — plan 04-05 supplies `buildFieldValueOperations`
   * and consumes this array rather than re-deriving the comparison. Extend,
   * do not rewrite, this seam.
   */
  pendingFieldChanges: Array<{ logicalKey: string; changed: FieldName[] }>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** `issue:phase:<id>` — the phase issue's own identity, distinct from `phase:<id>` (its project item, per the assumption-delta decision promoting the issue to a first-class mapped object). */
function issueKeyFor(id: string): string {
  return `issue:phase:${id}`;
}

/** Phase 5: `plan:<id>` — the plan sub-issue's own project-item identity, mirroring `phase:<id>`. */
function planKeyFor(id: string): string {
  return `plan:${id}`;
}

/** Phase 5: `issue:plan:<id>` — the plan sub-issue's own identity, mirroring `issue:phase:<id>`. */
function planIssueKeyFor(id: string): string {
  return `issue:plan:${id}`;
}

const PHASE_KEY_PREFIX = 'phase:';
const ISSUE_PHASE_KEY_PREFIX = 'issue:phase:';

/**
 * Plan 04-04 Task 1 (D-11): the phase id a `phase:<id>` or `issue:phase:<id>`
 * completion key names, or `null` for any other key (including every
 * reserved bootstrap-namespace key: `project`, `project-link`, `field:*`,
 * `option:status:*`, `label:*`, `milestone:*` — none of which start with
 * either prefix). `issue:phase:` is checked first since it is the longer,
 * more specific prefix.
 */
function orphanPhaseIdFromKey(key: string): string | null {
  if (key.startsWith(ISSUE_PHASE_KEY_PREFIX)) return key.slice(ISSUE_PHASE_KEY_PREFIX.length);
  if (key.startsWith(PHASE_KEY_PREFIX)) return key.slice(PHASE_KEY_PREFIX.length);
  return null;
}

/** The single current (non-archived) milestone's version, or `null` when none is declared. */
function currentMilestoneVersion(milestones: DesiredMilestone[] | undefined): string | null {
  const found = (milestones ?? []).find((milestone) => !milestone.archived);
  return found ? found.version : null;
}

/** Plan 04-04 Task 1 (D-15): the four item field values for a phase, derived from disk truth alone. `gsdId` is the phase's own logical key — never re-derived from the issue or the board. */
function desiredFieldValuesFor(phase: DesiredPhase, logicalKey: string): FieldValues {
  return {
    gsdId: logicalKey,
    phaseId: phase.id,
    requirements: phase.requirements ?? [],
    status: phase.status ?? '',
  };
}

/**
 * Plan 04-05 Task 2: the four item fields, in the fixed declared write order
 * (D-15/D-16) — `GSD ID`, `Phase`, `Requirements`, `Status`. Mirrors
 * `github-sync-issue-body.cts`'s `FIELD_NAMES` order exactly, so a run's
 * emitted operations group by phase with each phase's writes contiguous and
 * in this same order. `Wave` and `Autonomous` never appear here: both are
 * plan-level facts belonging to Phase 5 (D-15) — a phase-level guess written
 * into them would have to be unwritten later.
 */
const FIELD_VALUE_DATA_TYPE = Object.freeze({ TEXT: 'TEXT', SINGLE_SELECT: 'SINGLE_SELECT' } as const);
type FieldValueDataType = typeof FIELD_VALUE_DATA_TYPE[keyof typeof FIELD_VALUE_DATA_TYPE];
const FIELD_VALUE_SPEC: ReadonlyArray<{ fieldName: FieldName; declaredName: string; dataType: FieldValueDataType }> = Object.freeze([
  Object.freeze({ fieldName: 'gsdId' as const, declaredName: 'GSD ID', dataType: FIELD_VALUE_DATA_TYPE.TEXT }),
  Object.freeze({ fieldName: 'phaseId' as const, declaredName: 'Phase', dataType: FIELD_VALUE_DATA_TYPE.TEXT }),
  Object.freeze({ fieldName: 'requirements' as const, declaredName: 'Requirements', dataType: FIELD_VALUE_DATA_TYPE.TEXT }),
  Object.freeze({ fieldName: 'status' as const, declaredName: STATUS_FIELD_NAME, dataType: FIELD_VALUE_DATA_TYPE.SINGLE_SELECT }),
]);

/**
 * RESEARCH.md Pitfall 4: `gh api graphql`'s `-f`/`-F` flags cannot encode
 * `updateProjectV2ItemFieldValue`'s `value` argument (a oneof-style input
 * object) as a single flag value — every published example inlines the whole
 * object with the value interpolated, which would concatenate a
 * developer-influenced string into a query document
 * (`github-sync-operation.cts`'s SECURITY rule forbids this outright). The
 * resolution mirrors `CREATE_FIELD_TEXT_DOCUMENT`/
 * `CREATE_FIELD_SINGLE_SELECT_DOCUMENT` (github-sync-bootstrap-plan.cts) in
 * shape: one document per data type, the wrapper key (`text`/
 * `singleSelectOptionId`) a literal in the query text, only the scalar leaf
 * riding a variable. Both documents select
 * `projectV2Item { id content { ... on Issue { number } } }`, not merely
 * `id` — so re-recording the phase's project-item completion after a field
 * write preserves the issue number the add-to-project capture stored;
 * selecting only `id` would silently drop it. No `rateLimit` selection and
 * no points-budget selection, for the same live-verified reason every other
 * document in this capability declares `hasPointsBudget: false`.
 */
const UPDATE_FIELD_VALUE_TEXT_DOCUMENT =
  'mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$value:String!) { # github-sync:updateFieldValueText\n' +
  'updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{text:$value}}) { ' +
  'projectV2Item { id content { ... on Issue { number } } } } }';
const UPDATE_FIELD_VALUE_SINGLE_SELECT_DOCUMENT =
  'mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$value:String!) { # github-sync:updateFieldValueSingleSelect\n' +
  'updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{singleSelectOptionId:$value}}) { ' +
  'projectV2Item { id content { ... on Issue { number } } } } }';

/** Mirrors `fieldCreateDocument`'s shape (github-sync-bootstrap-plan.cts). */
function documentForFieldType(dataType: FieldValueDataType): string {
  return dataType === FIELD_VALUE_DATA_TYPE.SINGLE_SELECT ? UPDATE_FIELD_VALUE_SINGLE_SELECT_DOCUMENT : UPDATE_FIELD_VALUE_TEXT_DOCUMENT;
}

/** The raw text value for one of the three TEXT fields (never called for `status`, whose value is an `ArgvRef`). */
function textValueFor(fieldName: FieldName, values: FieldValues): string {
  if (fieldName === 'gsdId') return values.gsdId;
  if (fieldName === 'phaseId') return values.phaseId;
  return values.requirements.join(', ');
}

/**
 * Plan 04-05 Task 2: one `MutationOperation` per changed field, in
 * `FIELD_VALUE_SPEC`'s fixed order. Resolves each changed field's id — and,
 * for `status`, the phase's derived status option's id — synchronously
 * against `completions` (the reserved-key catalog Phase 3 populated, never a
 * live read). The first unresolved id stops the whole phase: zero operations,
 * one typed `FIELD_UNRESOLVED` blocked entry (T-04-18) — a field write is
 * never dispatched against an id that does not exist, and one phase's
 * unresolved field never suppresses a sibling phase in the same run (that
 * guarantee lives in the caller, which calls this function once per phase).
 *
 * Project id and item id ride `ArgvRef`s resolving from the `project`
 * completion and `projectItemKey`'s own completion — late-bound the same way
 * `buildCreateIssueOperation`'s milestone reference already is (D-12's
 * precedent), so a brand-new phase's own item id (recorded earlier in the
 * same run by the add-to-project operation, under this same logical key)
 * resolves correctly even though it does not exist yet when this function is
 * called. The status value is likewise an `ArgvRef` resolving the matched
 * `option:status:<slug>` completion's node id — never a literal name and
 * never a literal id. The three text values ride the raw value flag as
 * literals: the logical key for `GSD ID`, the phase id exactly as it appears
 * on disk for `Phase`, and the comma-separated requirement IDs for
 * `Requirements`.
 *
 * Only the LAST emitted operation's capture carries
 * `plannerFields.fieldState` (T-04-19): recording it on an earlier operation
 * would claim a write that has not happened yet, and leaving it off entirely
 * would mean the state never converges. An interrupted sequence therefore
 * leaves the field state unknown, which `changedFields` reads as every field
 * differing — the next run rewrites all four and converges, never silently
 * skips a write it cannot justify.
 */
function buildFieldValueOperations(
  phase: DesiredPhase,
  changed: FieldName[],
  completions: Record<string, StrictMapCompletion>,
  projectItemKey: string,
  context: CompletionContext,
): { operations: MutationOperation[]; blocked: Array<{ reason: typeof OPERATION_REASON.FIELD_UNRESOLVED; detail: string }> } {
  if (changed.length === 0) return { operations: [], blocked: [] };

  const changedSet = new Set(changed);
  const desiredValues = desiredFieldValuesFor(phase, projectItemKey);

  const resolved: Array<{ fieldName: FieldName; dataType: FieldValueDataType; fieldId: string; statusOptionKey?: string }> = [];

  for (const spec of FIELD_VALUE_SPEC) {
    if (!changedSet.has(spec.fieldName)) continue;
    const fieldKey = BOOTSTRAP_LOGICAL_KEY.field(spec.declaredName);
    const fieldCompletion = completions[fieldKey];
    if (!fieldCompletion || !isNonEmptyString(fieldCompletion.nodeId)) {
      return { operations: [], blocked: [{ reason: OPERATION_REASON.FIELD_UNRESOLVED, detail: `${fieldKey} has no resolved completion` }] };
    }

    let statusOptionKey: string | undefined;
    if (spec.fieldName === 'status') {
      statusOptionKey = BOOTSTRAP_LOGICAL_KEY.statusOption(desiredValues.status);
      const optionCompletion = completions[statusOptionKey];
      if (!optionCompletion || !isNonEmptyString(optionCompletion.nodeId)) {
        return { operations: [], blocked: [{ reason: OPERATION_REASON.FIELD_UNRESOLVED, detail: `${statusOptionKey} has no resolved completion` }] };
      }
    }

    resolved.push({ fieldName: spec.fieldName, dataType: spec.dataType, fieldId: fieldCompletion.nodeId, statusOptionKey });
  }

  const operations: MutationOperation[] = resolved.map((entry, index) => {
    const isLast = index === resolved.length - 1;
    const valueEntry: ArgvEntry = entry.statusOptionKey !== undefined
      ? { from: entry.statusOptionKey, part: ARGV_REF_PART.NODE_ID, prefix: 'value=' }
      : `value=${textValueFor(entry.fieldName, desiredValues)}`;

    const args: ArgvEntry[] = [
      'api', 'graphql',
      '-f', `query=${documentForFieldType(entry.dataType)}`,
      // SECURITY: projectId/itemId/fieldId are all opaque GitHub node ids and
      // ride the raw -f flag, never the typed -F flag (github-sync-operation
      // .cts's module header: new code puts node ids on the raw flag).
      '-f', { from: BOOTSTRAP_LOGICAL_KEY.project(), part: ARGV_REF_PART.NODE_ID, prefix: 'projectId=' },
      '-f', { from: projectItemKey, part: ARGV_REF_PART.NODE_ID, prefix: 'itemId=' },
      '-f', `fieldId=${entry.fieldId}`,
      '-f', valueEntry,
    ];

    return {
      kind: 'update-field-value',
      logicalKey: projectItemKey,
      args,
      completionContext: context,
      transport: OPERATION_TRANSPORT.GRAPHQL,
      action: OPERATION_ACTION.UPDATE,
      hasPointsBudget: false,
      // A field write creates no content and must not consume the
      // content-creation pacing budget the two create operations share.
      contentCreation: false,
      captures: [{
        kind: 'node',
        logicalKey: projectItemKey,
        nodeIdPath: 'updateProjectV2ItemFieldValue.projectV2Item.id',
        numberPath: 'updateProjectV2ItemFieldValue.projectV2Item.content.number',
        ...(isLast ? { plannerFields: { fieldState: renderFieldState(desiredValues) } } : {}),
      }],
    };
  });

  return { operations, blocked: [] };
}

/**
 * Emits the shared `MutationOperation` shape (plan 03-02 migration).
 *
 * Resolved in Phase 04 (plan 04-01): a live schema probe (see
 * `.planning/phases/03-project-bootstrap/deferred-items.md`'s "Resolved in
 * Phase 04" entry for the verbatim output) confirmed GitHub's `Mutation`
 * root type carries no `addProjectV2Item` field at all — only
 * `addProjectV2ItemById` exists — and no `rateLimit` field, which lives
 * solely on `Query`. This document therefore selects no `rateLimit` block,
 * declares `hasPointsBudget: false`, dispatches `addProjectV2ItemById`, and
 * reads its response back through that mutation's own payload shape
 * (`item`, not `projectV2Item` — also settled by the same live probe, not
 * assumed unchanged). The response capture walks the mutation payload key,
 * then the added item, then its `id`; and the same payload key, the item,
 * its `content`, then `number`. `projectId`/`contentId` now ride the raw
 * `-f` flag rather than the typed `-F` flag: this is new code (a rewrite of
 * the prior defective document), not the pre-existing exception
 * `src/github-sync-operation.cts`'s module header used to name at this call
 * site.
 *
 * `contentId` accepts either an already-resolved node id (the pre-existing
 * mapped-issue and legacy-resolution branches, which have a real node id in
 * hand) or a reference to a logical key whose completion is captured
 * earlier in the same plan (plan 04-01's new create branch: the REST
 * create's own capture, late-bound within one run).
 *
 * `plannerFields` (plan 04-04 Task 1) is passed only from the create branch,
 * carrying the desired field state so a create immediately followed by a
 * re-plan is a no-op with no extra write (D-12).
 */
function operationFor(
  logicalKey: string,
  projectNodeId: string,
  contentId: string | { from: string },
  target: NonNullable<RemoteSnapshot['target']>,
  plannerFields?: Record<string, string>,
): MutationOperation {
  const query = 'mutation($projectId:ID!,$contentId:ID!) { # github-sync:addProjectV2ItemById\n' +
    'addProjectV2ItemById(input:{projectId:$projectId,contentId:$contentId}) { item { id content { ... on Issue { number } } } } }';
  const contentIdEntry: ArgvEntry = typeof contentId === 'string'
    ? `contentId=${contentId}`
    : { from: contentId.from, part: ARGV_REF_PART.NODE_ID, prefix: 'contentId=' };
  return {
    kind: OPERATION_KIND.CREATE,
    logicalKey,
    args: ['api', 'graphql', '-f', `query=${query}`, '-f', `projectId=${projectNodeId}`, '-f', contentIdEntry],
    completionContext: { owner: target.owner, repo: target.repo, repositoryNumber: target.repositoryNumber },
    transport: OPERATION_TRANSPORT.GRAPHQL,
    action: OPERATION_ACTION.CREATE,
    hasPointsBudget: false,
    contentCreation: true,
    captures: [{
      kind: 'node',
      logicalKey,
      nodeIdPath: 'addProjectV2ItemById.item.id',
      numberPath: 'addProjectV2ItemById.item.content.number',
      ...(plannerFields === undefined ? {} : { plannerFields }),
    }],
  };
}

/**
 * BOOT-04-style REST create-with-capture, following
 * `buildCreateLabelOperation`'s shape verbatim: an explicit `-X POST` (`gh`
 * silently switches to POST the instant any value flag is present, so the
 * method is always explicit regardless), the title and rendered body on the
 * raw value flag (T-04-01 — no roadmap text is ever concatenated into a
 * query document), the `gsd:phase` label literal on the bracket-suffixed
 * raw value flag, and the milestone number late-bound from the milestone
 * completion. Transport REST, no points budget, content-creating, one node
 * capture under `issueKey` reading `node_id`/`number` from the bare REST
 * body root.
 *
 * `plannerFields` (plan 04-04 Task 1) carries the freshly computed content
 * hash, so an immediate re-plan after this create sees the stored hash
 * already equal to the recomputed one and contributes a no-op rather than a
 * pending update.
 */
function buildCreateIssueOperation(
  phase: DesiredPhase,
  issueKey: string,
  milestoneKey: string,
  restApiPath: string,
  context: CompletionContext,
  plannerFields?: Record<string, string>,
): MutationOperation {
  const phaseLabel = GSD_LABELS.find((label) => label.name === PHASE_LABEL_NAME);
  const labelName = phaseLabel ? phaseLabel.name : PHASE_LABEL_NAME;
  const args: ArgvEntry[] = [
    'api', restApiPath, '-X', 'POST',
    // SECURITY: every developer-sourced string (title, rendered body) rides
    // the raw -f flag — never the typed -F flag, which performs @-file and
    // {owner}/{repo} substitution on the value.
    '-f', `title=${phase.title}`,
    '-f', `body=${renderNewIssueBody(phase)}`,
    '-f', `labels[]=${labelName}`,
    '-F', { from: milestoneKey, part: ARGV_REF_PART.NUMBER, prefix: 'milestone=' },
  ];
  return {
    kind: 'create-issue',
    logicalKey: issueKey,
    args,
    completionContext: context,
    transport: OPERATION_TRANSPORT.REST,
    action: OPERATION_ACTION.CREATE,
    hasPointsBudget: false,
    contentCreation: true,
    captures: [{
      kind: 'node',
      logicalKey: issueKey,
      nodeIdPath: 'node_id',
      numberPath: 'number',
      ...(plannerFields === undefined ? {} : { plannerFields }),
    }],
  };
}

/**
 * Phase 5 (05-CONTEXT.md D-13, 05-RESEARCH.md Code Examples): the one
 * GraphQL surface with no prior call site in this codebase
 * (05-RESEARCH.md "No Analog Found"). Plan 05-01 Task 2 settles the live
 * schema and corrects this document text and the capture paths below in
 * place if the live shape disagrees — see
 * `.planning/phases/05-plan-sub-issues-task-rendering/05-ADDSUBISSUE-PROBE.md`.
 * Deliberately NOT registered in
 * `tests/fixtures/github-sync/graphql-documents-contract.json` (05-CONTEXT.md
 * research-correction note): that fixture's guard asserts two-way equality
 * with the documents `readRemoteSnapshot` dispatches, and this is a
 * reconcile-side mutation, never dispatched by the remote reader. Pinned
 * instead by an inline assertion in `tests/github-sync-reconcile.test.cjs`,
 * following the `addProjectV2ItemById` precedent.
 */
const ADD_SUB_ISSUE_DOCUMENT =
  'mutation($issueId:ID!,$subIssueId:ID!) { # github-sync:addSubIssue\n' +
  'addSubIssue(input:{issueId:$issueId,subIssueId:$subIssueId}) { issue { id } subIssue { id number } } }';

/**
 * Phase 5: the plan-issue equivalent of `buildCreateIssueOperation` — REST
 * create with the `gsd:plan` label, the rendered plan body
 * (`renderNewPlanIssueBody`), and the milestone number late-bound from the
 * milestone completion (D-15). `plannerFields` carries the freshly computed
 * content hash so an immediate re-plan sees the create's own hash already
 * equal to the recomputed one.
 */
function buildCreatePlanIssueOperation(
  plan: DesiredPlan,
  issueKey: string,
  milestoneKey: string,
  restApiPath: string,
  context: CompletionContext,
  plannerFields?: Record<string, string>,
): MutationOperation {
  const planLabel = GSD_LABELS.find((label) => label.name === PLAN_LABEL_NAME);
  const labelName = planLabel ? planLabel.name : PLAN_LABEL_NAME;
  const args: ArgvEntry[] = [
    'api', restApiPath, '-X', 'POST',
    // SECURITY: every plan-sourced string (title, rendered body) rides the
    // raw -f flag — never the typed -F flag, which performs @-file and
    // {owner}/{repo} substitution on the value.
    '-f', `title=${plan.title}`,
    '-f', `body=${renderNewPlanIssueBody({ id: plan.id, title: plan.title, status: plan.status, tasks: plan.tasks })}`,
    '-f', `labels[]=${labelName}`,
    '-F', { from: milestoneKey, part: ARGV_REF_PART.NUMBER, prefix: 'milestone=' },
  ];
  return {
    kind: 'create-plan-issue',
    logicalKey: issueKey,
    args,
    completionContext: context,
    transport: OPERATION_TRANSPORT.REST,
    action: OPERATION_ACTION.CREATE,
    hasPointsBudget: false,
    contentCreation: true,
    captures: [{
      kind: 'node',
      logicalKey: issueKey,
      nodeIdPath: 'node_id',
      numberPath: 'number',
      ...(plannerFields === undefined ? {} : { plannerFields }),
    }],
  };
}

/**
 * Phase 5 (D-13): attaches a just-created (or already-existing) plan issue to
 * its parent phase issue as a native GitHub sub-issue. `issueId` late-binds
 * to the parent's `issue:phase:<phaseId>` completion; `subIssueId` late-binds
 * to this plan's own `issue:plan:<planId>` completion — resolved from a
 * prior run, or (the common case) from the create operation immediately
 * preceding this one within the same plan, mirroring `operationFor`'s own
 * late-binding idiom (line ~401-403). Both ride the raw `-f` flag: both are
 * opaque GitHub-minted node ids GSD is echoing back, per
 * `github-sync-operation.cts`'s SECURITY rule ("new code puts node ids on
 * the raw flag").
 */
function buildAddSubIssueOperation(planId: string, phaseId: string, context: CompletionContext): MutationOperation {
  const planIssueKey = planIssueKeyFor(planId);
  const phaseIssueKey = issueKeyFor(phaseId);
  const args: ArgvEntry[] = [
    'api', 'graphql',
    '-f', `query=${ADD_SUB_ISSUE_DOCUMENT}`,
    '-f', { from: phaseIssueKey, part: ARGV_REF_PART.NODE_ID, prefix: 'issueId=' },
    '-f', { from: planIssueKey, part: ARGV_REF_PART.NODE_ID, prefix: 'subIssueId=' },
  ];
  return {
    kind: 'add-sub-issue',
    logicalKey: planIssueKey,
    args,
    completionContext: context,
    transport: OPERATION_TRANSPORT.GRAPHQL,
    action: OPERATION_ACTION.LINK,
    hasPointsBudget: false,
    contentCreation: true,
    captures: [{
      kind: 'node',
      logicalKey: planIssueKey,
      nodeIdPath: 'addSubIssue.subIssue.id',
      numberPath: 'addSubIssue.subIssue.number',
    }],
  };
}

function bindingOnBoard(completion: { nodeId: string; issueNumber?: number } | undefined, remote: RemoteSnapshot): boolean {
  if (!completion) return false;
  for (const item of remote.items ?? []) {
    if (isNonEmptyString(item.id) && item.id === completion.nodeId) return true;
    const content = item.content;
    if (content === null || typeof content !== 'object') continue;
    if (completion.issueNumber !== undefined && content.number === completion.issueNumber && isNonEmptyString(content.id)) return true;
  }
  return false;
}

function resolvedIssueNodeId(issueNodeIds: RemoteSnapshot['issueNodeIds'], issueNumber: number | undefined): string | null {
  if (issueNumber === undefined || issueNodeIds === null || typeof issueNodeIds !== 'object') return null;
  const value = (issueNodeIds as Record<string, unknown>)[String(issueNumber)];
  return isNonEmptyString(value) ? value : null;
}

/**
 * Per-phase decision order (plan 04-01, extended by plan 04-04 Task 1):
 *
 * 1. Already bound on the project board (`phase:<id>` completion resolves
 *    against a live item). Unlike Phase 2/plan 04-01, this no longer
 *    `continue`s unconditionally: when an `issue:phase:<id>` completion also
 *    exists, the issue-content unit (title/region/milestone hash) and the
 *    item-field unit (D-12) are each independently checked for convergence,
 *    and only a phase converged on BOTH units contributes a no-op (SC3). A
 *    phase bound on the board with no `issue:phase:<id>` completion (a
 *    pre-Phase-4 map) has never migrated onto the new content-hash system
 *    and is left a plain no-op, exactly as before.
 * 2. An `issue:phase:<id>` completion exists but the project item is not yet
 *    bound — GSD created this issue on an earlier run — → bind it to the
 *    project via a literal content id, no create.
 * 3. No `issue:phase:<id>` completion, but a legacy `phase:<id>` completion
 *    exists (the pre-Phase-4 map shape, carrying only an issue number) →
 *    resolve it against the remote's issue-number lookup (unchanged from
 *    Phase 2); resolves → bind; does not resolve → `identity_unresolvable`.
 *    A legacy completion is never treated as license to create a second
 *    issue for the same phase.
 * 4. No completion of any kind → this phase has never been created or
 *    bound. Creating it requires its milestone to already be checkpointed
 *    (`milestone_unresolved` otherwise) — an issue is never created without
 *    the milestone it belongs to. Emits the REST create paired with an
 *    add-to-project operation whose content id late-binds to the create's
 *    own capture within this same plan, both carrying the freshly computed
 *    content hash / field state in their planner fields.
 *
 * A post-loop pass (D-11) reports every `phase:`/`issue:phase:` completion
 * whose id is absent from the desired phase set as an orphan — reported by
 * name, never acted on.
 */
function planReconciliation(desired: DesiredState, remote: RemoteSnapshot, strictMap: StrictMap): ReconciliationPlan {
  const empty = { operations: [], noops: [], pendingIssueUpdates: [], orphans: [], pendingFieldChanges: [] };
  if (!desired.available) return { ...empty, blocked: [{ reason: OPERATION_REASON.DESIRED_UNAVAILABLE, detail: desired.reason }], uncertain: [] };
  if (!remote.available) return { ...empty, blocked: [], uncertain: [{ reason: OPERATION_REASON.REMOTE_UNAVAILABLE }] };
  if (strictMap.kind === 'blocking') return { ...empty, blocked: [{ reason: OPERATION_REASON.MAP_BLOCKING, detail: strictMap.reason ?? 'invalid' }], uncertain: [] };
  if (
    !remote.target
    || !Number.isSafeInteger(remote.target.repositoryNumber)
    || remote.target.repositoryNumber <= 0
    || !isNonEmptyString(remote.target.projectNodeId)
  ) {
    return { ...empty, blocked: [], uncertain: [{ reason: OPERATION_REASON.REMOTE_UNAVAILABLE }] };
  }
  if (!PATH_SAFE_TARGET.test(remote.target.owner) || !PATH_SAFE_TARGET.test(remote.target.repo)) {
    return { ...empty, blocked: [{ reason: OPERATION_REASON.UNSAFE_TARGET }], uncertain: [] };
  }

  const completions = strictMap.kind === 'valid' ? strictMap.map?.completions ?? {} : {};
  const context: CompletionContext = { owner: remote.target.owner, repo: remote.target.repo, repositoryNumber: remote.target.repositoryNumber };
  const milestoneVersion = currentMilestoneVersion(desired.milestones);
  const milestoneKey = milestoneVersion !== null ? BOOTSTRAP_LOGICAL_KEY.milestone(milestoneVersion) : null;

  const operations: ReconciliationPlan['operations'] = [];
  const noops: ReconciliationPlan['noops'] = [];
  const blocked: ReconciliationPlan['blocked'] = [];
  const pendingIssueUpdates: ReconciliationPlan['pendingIssueUpdates'] = [];
  const pendingFieldChanges: ReconciliationPlan['pendingFieldChanges'] = [];

  for (const phase of [...desired.phases].sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))) {
    const logicalKey = `phase:${phase.id}`;
    const completion = completions[logicalKey];
    const issueKey = issueKeyFor(phase.id);
    const issueCompletion = completions[issueKey];
    const milestoneCompletion = milestoneKey ? completions[milestoneKey] : undefined;

    if (bindingOnBoard(completion, remote)) {
      if (!issueCompletion) {
        // A pre-Phase-4 (or otherwise not-yet-migrated) phase: bound on the
        // board, but never went through the new content-hash system. Left a
        // plain no-op, exactly as Phase 2/plan 04-01 behaved.
        noops.push({ logicalKey });
        continue;
      }
      if (!milestoneCompletion || milestoneCompletion.issueNumber === undefined) {
        // The issue exists, but its milestone can no longer be resolved to a
        // number (e.g. the milestone completion was lost) — the freshly
        // computed hash could not be trusted, so this phase is reported
        // rather than silently treated as converged.
        blocked.push({ reason: OPERATION_REASON.MILESTONE_UNRESOLVED, detail: logicalKey });
        continue;
      }

      const region = renderPhaseRegion(phase);
      const milestoneNumber = milestoneCompletion.issueNumber;
      const desiredHash = contentHash({ title: phase.title, region, milestoneNumber });
      const contentConverged = issueCompletion.contentHash !== undefined && issueCompletion.contentHash === desiredHash;

      const desiredFieldValues = desiredFieldValuesFor(phase, logicalKey);
      const previousFieldState: ParsedFieldState = completion.fieldState !== undefined
        ? parseFieldState(completion.fieldState)
        : { kind: 'unknown' };
      const changed = changedFields(previousFieldState, desiredFieldValues);

      if (!contentConverged) {
        pendingIssueUpdates.push({
          logicalKey,
          issueKey,
          issueNumber: issueCompletion.issueNumber,
          issueNodeId: issueCompletion.nodeId,
          title: phase.title,
          region,
          milestoneNumber,
          milestoneKey: milestoneKey as string,
          contentHash: desiredHash,
          completionContext: context,
        });
      }
      if (changed.length > 0) {
        pendingFieldChanges.push({ logicalKey, changed });
        // Plan 04-05 Task 2: the builder consumes this same `changed` set
        // rather than re-deriving the comparison — extends, not replaces,
        // plan 04-04's seam.
        const fieldResult = buildFieldValueOperations(phase, changed, completions, logicalKey, context);
        operations.push(...fieldResult.operations);
        blocked.push(...fieldResult.blocked);
      }
      if (contentConverged && changed.length === 0) noops.push({ logicalKey });
      continue;
    }

    if (issueCompletion) {
      operations.push(operationFor(logicalKey, remote.target.projectNodeId, issueCompletion.nodeId, remote.target));
      continue;
    }

    if (completion) {
      const legacyIssueNodeId = resolvedIssueNodeId(remote.issueNodeIds, completion.issueNumber);
      if (legacyIssueNodeId) {
        operations.push(operationFor(logicalKey, remote.target.projectNodeId, legacyIssueNodeId, remote.target));
        continue;
      }
      blocked.push({ reason: OPERATION_REASON.IDENTITY_UNRESOLVABLE, detail: logicalKey });
      continue;
    }

    if (!milestoneCompletion || milestoneCompletion.issueNumber === undefined) {
      blocked.push({ reason: OPERATION_REASON.MILESTONE_UNRESOLVED, detail: logicalKey });
      continue;
    }

    const restApiPath = phaseIssueRestPath(remote.target.owner, remote.target.repo, '/issues');
    if (!restApiPath) {
      // Unreachable in practice — the whole-run unsafe-target gate above
      // already rejected this owner/repo before any phase reached this
      // point. Kept as a typed fallback rather than a non-null assertion.
      blocked.push({ reason: OPERATION_REASON.UNSAFE_TARGET, detail: logicalKey });
      continue;
    }

    const region = renderPhaseRegion(phase);
    const milestoneNumber = milestoneCompletion.issueNumber;
    const desiredHash = contentHash({ title: phase.title, region, milestoneNumber });

    operations.push(buildCreateIssueOperation(phase, issueKey, milestoneKey as string, restApiPath, context, { contentHash: desiredHash }));
    operations.push(operationFor(logicalKey, remote.target.projectNodeId, { from: issueKey }, remote.target));

    // Plan 04-05 Task 2: a brand-new phase carries no previous field state at
    // all — every field is "changed" by construction, mirroring
    // `changedFields({ kind: 'unknown' }, ...)`'s own all-four result — so
    // every field write is attempted in the same run, late-binding its item
    // id to this very add-to-project operation's own capture (both share
    // `logicalKey`). `fieldState` no longer rides the add-to-project
    // operation's planner fields (plan 04-04's mechanism): it now rides only
    // the LAST field-value operation's capture, so an interrupted sequence
    // reads as unknown rather than claiming a write that has not happened.
    const allFieldNames = changedFields({ kind: 'unknown' }, desiredFieldValuesFor(phase, logicalKey));
    const fieldResult = buildFieldValueOperations(phase, allFieldNames, completions, logicalKey, context);
    operations.push(...fieldResult.operations);
    blocked.push(...fieldResult.blocked);
  }

  // Plan 05-01 Task 1: a second pass over `desired.plans`, appended after the
  // phase loop above rather than interleaved with it — this is what makes
  // D-13's ordering constraint (phase creates before any plan create) hold
  // structurally, not by convention. This tracer implements exactly one
  // branch: no `issue:plan:<id>` completion, a resolvable
  // `issue:phase:<phaseId>` completion, and a resolvable milestone
  // completion push the three content-creating operations, in order (REST
  // create, addSubIssue, add-to-project), carrying the freshly computed
  // content hash on the create's planner fields. Every other case — an
  // existing `issue:plan:<id>` completion, an unresolvable parent, or an
  // unresolvable milestone — `continue`s with no operation and no blocked
  // entry: plan 05-05 supplies the real convergence/bind branches and the
  // typed PARENT_UNRESOLVED refusal this tracer deliberately leaves unbuilt
  // (noted here, not silently assumed complete).
  const milestoneCompletionForPlans = milestoneKey ? completions[milestoneKey] : undefined;
  for (const plan of [...(desired.plans ?? [])].sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))) {
    const planLogicalKey = planKeyFor(plan.id);
    const planIssueKey = planIssueKeyFor(plan.id);
    if (completions[planIssueKey]) continue;

    const phaseIssueCompletion = completions[issueKeyFor(plan.phaseId)];
    if (!phaseIssueCompletion || !isNonEmptyString(phaseIssueCompletion.nodeId)) continue;

    if (!milestoneCompletionForPlans || milestoneCompletionForPlans.issueNumber === undefined) continue;

    const restApiPath = phaseIssueRestPath(remote.target.owner, remote.target.repo, '/issues');
    if (!restApiPath) continue;

    const planRegion = renderPlanRegion({ id: plan.id, title: plan.title, status: plan.status, tasks: plan.tasks });
    const milestoneNumber = milestoneCompletionForPlans.issueNumber;
    const desiredPlanHash = contentHash({ title: plan.title, region: planRegion, milestoneNumber });

    operations.push(buildCreatePlanIssueOperation(plan, planIssueKey, milestoneKey as string, restApiPath, context, { contentHash: desiredPlanHash }));
    operations.push(buildAddSubIssueOperation(plan.id, plan.phaseId, context));
    operations.push(operationFor(planLogicalKey, remote.target.projectNodeId, { from: planIssueKey }, remote.target));
  }

  // Plan 04-04 Task 1 (D-11): a post-loop pass, scoped to the two phase
  // namespaces by prefix — a bootstrap-namespace key (`project`, `field:*`,
  // `option:status:*`, `label:*`, `milestone:*`) never starts with either
  // prefix and is never reported. Both completions for the same phase id
  // collapse into one orphan entry; whichever holds a number wins.
  const desiredIds = new Set(desired.phases.map((phase) => phase.id));
  const orphanNumbers = new Map<string, number | undefined>();
  for (const [key, entry] of Object.entries(completions)) {
    const id = orphanPhaseIdFromKey(key);
    if (id === null || desiredIds.has(id)) continue;
    const existing = orphanNumbers.get(id);
    if (!orphanNumbers.has(id) || (existing === undefined && entry.issueNumber !== undefined)) {
      orphanNumbers.set(id, entry.issueNumber);
    }
  }
  const orphans: ReconciliationPlan['orphans'] = [...orphanNumbers.entries()]
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .map(([id, issueNumber]) => (issueNumber === undefined ? { logicalKey: `phase:${id}` } : { logicalKey: `phase:${id}`, issueNumber }));

  return { operations, noops, blocked, uncertain: [], pendingIssueUpdates, orphans, pendingFieldChanges };
}

export = {
  planReconciliation,
  OPERATION_KIND,
  OPERATION_REASON,
  issueKeyFor,
  planKeyFor,
  planIssueKeyFor,
  phaseIssueRestPath,
  PATH_SAFE_TARGET,
  buildCreateIssueOperation,
  buildCreatePlanIssueOperation,
  buildAddSubIssueOperation,
  ADD_SUB_ISSUE_DOCUMENT,
  buildFieldValueOperations,
  documentForFieldType,
  UPDATE_FIELD_VALUE_TEXT_DOCUMENT,
  UPDATE_FIELD_VALUE_SINGLE_SELECT_DOCUMENT,
};
