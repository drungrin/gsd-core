'use strict';
/** Pure, deterministic reconciliation plan for desired state and typed inputs. */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import operationMod = require('./github-sync-operation.cjs');
import type { MutationOperation, ArgvEntry, ArgvRef, CompletionContext } from './github-sync-operation.cts';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import bootstrapPlanMod = require('./github-sync-bootstrap-plan.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import issueBodyMod = require('./github-sync-issue-body.cjs');
import type { FieldValues, FieldName, ParsedFieldState, PlanStatus } from './github-sync-issue-body.cts';
// Plan 07-04 Task 2 (D-06): safe in this one direction only —
// `github-sync-existence.cts` must never import this module back (see that
// module's own header comment on why the classifier lives in a dedicated file).
// eslint-disable-next-line @typescript-eslint/no-require-imports
import existenceMod = require('./github-sync-existence.cjs');

const { OPERATION_TRANSPORT, OPERATION_ACTION, ARGV_REF_PART } = operationMod;
const { BOOTSTRAP_LOGICAL_KEY, GSD_LABELS, STATUS_FIELD_NAME } = bootstrapPlanMod;
const { EXISTENCE_VERDICT } = existenceMod;
const {
  renderNewIssueBody, renderPhaseRegion, contentHash, renderFieldState, parseFieldState, changedFields,
  renderNewPlanIssueBody, renderPlanRegion, PLAN_FIELD_NAMES,
  countDependencyRefSlots, DEPENDENCY_REF_SENTINEL, substituteDependencyRefs,
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
  // Plan 05-05 Task 2 (D-13): a plan whose parent phase issue cannot be
  // resolved — neither from a prior run's `issue:phase:<phaseId>` completion
  // nor from a phase-create operation emitted earlier in this same run's
  // plan-loop-preceding phase loop. GSD never creates an unparented plan
  // issue to attach later, which would invent an "exists but unattached"
  // state the reconciler would then have to recognize and repair. Scoped to
  // the one plan whose parent is unresolved; every other plan in the same
  // run is unaffected.
  PARENT_UNRESOLVED: 'parent_unresolved',
  // Plan 05-06 Task 2 (D-03/T-5-06): one reason serving two related refusals,
  // both of which withhold a body rather than dispatch one carrying an
  // unsubstituted or wrongly-bound slot — a structural disagreement between
  // a rendered region's observed sentinel count and the plan's own
  // `dependsOn` length (the anti-forgery guarantee plan 05-03 established),
  // and a dependency plan whose `issue:plan:<depId>` completion resolves
  // from neither a prior run nor a plan-create this run already pushed
  // earlier in the same ascending-id pass.
  DEPENDENCY_SLOT_MISMATCH: 'dependency_slot_mismatch',
  // Plan 07-04 Task 2 (D-06): an object whose existence this run could not
  // determine — the bootstrap read that would confirm or deny it failed.
  // Reported per object, with the object's logical key as `detail`, so a
  // developer reading the report knows which object was unreadable rather
  // than only that something was. A member of `PER_ITEM_BLOCKED_REASONS`
  // below: one unreadable object never discards the rest of the run's plan.
  EXISTENCE_UNKNOWN: 'existence_unknown',
} as const);

/**
 * 07-04 Task 2 (D-06), mirroring `github-sync-bootstrap-plan.cts`'s
 * `PER_ITEM_BLOCKED_REASONS`/`isRunFatalBlockedReason` split exactly: the
 * closed set of `OPERATION_REASON` members whose semantics are "skip this
 * one item" rather than "stop the whole plan's apply." Membership here is a
 * deliberate fatality decision, made once per reason as it is introduced —
 * omission is the safe default (`isRunFatalBlockedReason` treats every
 * non-member as run-fatal), so a future blocked reason added to this module
 * without updating this set still reads as run-fatal instead of silently
 * gaining per-item dispatch permission. Today exactly one member: an object
 * whose existence this run could not determine.
 */
const PER_ITEM_BLOCKED_REASONS: ReadonlySet<string> = new Set([
  OPERATION_REASON.EXISTENCE_UNKNOWN,
]);

/**
 * Fail-closed classifier: `false` only for a reason in
 * `PER_ITEM_BLOCKED_REASONS`, `true` for every other string — including one
 * this module has never heard of. Mirrors `github-sync-bootstrap-plan.cts`'s
 * `isRunFatalBlockedReason` exactly (same name, same predicate shape) so a
 * caller consuming both modules' blocked arrays reads one discipline, not
 * two.
 */
function isRunFatalBlockedReason(reason: string): boolean {
  return !PER_ITEM_BLOCKED_REASONS.has(reason);
}

/**
 * Plan 05-07 (D-14): GitHub's own documented ceiling on sub-issues per
 * parent issue.
 */
const PLAN_SUB_ISSUE_LIMIT = 100;
/**
 * Plan 05-07 (D-14): the count at which a developer is warned — ten plans
 * before the ceiling, cheap runway to split an oversized phase before a
 * create ever fails.
 */
const PLAN_SUB_ISSUE_WARN_THRESHOLD = 90;

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
 * Plan 05-06 Task 3 (D-08): mirrors `github-sync-map.cts`'s `ISSUE_STATE`
 * byte-for-byte. Duplicated rather than imported for the same zero-I/O
 * reason `PATH_SAFE_TARGET` above is duplicated: `github-sync-map.cts`
 * imports `node:fs`/`node:path`/`node:crypto` for its own persistence job,
 * and this module must stay free of any transitively fs-touching import.
 */
const PLAN_ISSUE_STATE = Object.freeze({
  OPEN: 'open',
  CLOSED: 'closed',
} as const);
type PlanIssueStateValue = typeof PLAN_ISSUE_STATE[keyof typeof PLAN_ISSUE_STATE];

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
  /**
   * Plan 05-05: the six field values' remaining three plan-only inputs.
   * Optional so pre-05-05 fixtures (which never set them) still type-check —
   * `desiredPlanFieldValuesFor` below falls back to `null`/`false`/`[]`,
   * mirroring `github-sync-desired.cts`'s own `DesiredPlan` defaults.
   */
  wave?: number | null;
  autonomous?: boolean;
  requirements?: string[];
  /** Plan 05-06's own concern; declared here only so a caller passing the real `DesiredPlan` (which always carries it) still type-checks with no cast. */
  dependsOn?: string[];
  /**
   * Plan 05-06 Task 3 (D-08): whether a sibling SUMMARY.md exists on disk —
   * `github-sync-desired.cts`'s own `readPlans` signal, the ONE input the
   * open/closed state machine reads. Optional so pre-05-06 fixtures (which
   * never set it) still type-check; treated as `false` (open) when absent,
   * mirroring every other plan-only field's total-by-construction default.
   */
  complete?: boolean;
}
interface DesiredState { available: boolean; reason: string; phases: DesiredPhase[]; plans?: DesiredPlan[]; milestones?: DesiredMilestone[]; }
interface RemoteItem { id?: unknown; content?: { id?: unknown; number?: unknown } | null; }
/**
 * Plan 05-07: only the two fields the per-parent sub-issue ceiling count
 * needs — `readRemoteSnapshot` (`github-sync-remote.cts`) tags every node
 * with the parent issue number it was read under; `number` is declared but
 * unused by the count itself, kept for shape fidelity with the real node.
 */
interface RemoteSubIssueNode { number?: unknown; parentIssueNumber?: unknown; }
interface RemoteSnapshot {
  available: boolean;
  reason: string;
  target?: { owner: string; repo: string; repositoryNumber: number; projectNumber: number; projectNodeId?: unknown };
  items?: RemoteItem[];
  /** Plan 05-07: optional so pre-05-07 fixtures (which never set it) still type-check; treated as empty when absent. */
  subIssues?: RemoteSubIssueNode[];
  issueNodeIds?: Record<string, string> | Record<number, string>;
}
interface StrictMapCompletion { nodeId: string; issueNumber?: number; contentHash?: string; fieldState?: string; issueState?: PlanIssueStateValue; }
interface StrictMap { kind: 'absent' | 'valid' | 'blocking'; reason?: string; map?: { completions?: Record<string, StrictMapCompletion> }; }

/**
 * Plan 07-04 Task 2 (D-06): the shape `classifyExistence`
 * (`github-sync-existence.cts`) already returns — accepted here as a plain
 * structural type rather than an imported one, since that module's own
 * `ExistenceVerdictEntry` interface is a local, unexported type. Optional on
 * `planReconciliation` so every pre-existing call site (which passes none)
 * behaves identically to before this task.
 */
interface ExistenceVerdictLike { logicalKey: string; verdict: string; }

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
  /** Plan 05-06: ordered dependency plan ids for the region's sentinel slots. Omitted (or empty) for a phase, which has no dependencies at all. */
  dependsOn?: string[];
}

/** Plan 04-04 Task 1 (D-11): a phase whose completions still exist but is absent from the desired state. */
interface OrphanEntry {
  logicalKey: string;
  issueNumber?: number;
}

/**
 * Plan 07-05 Task 2 (D-13): an issue-identity completion (`issue:phase:<id>`
 * / `issue:plan:<id>`) whose `(owner, repo, number)` re-resolution succeeded
 * with a node ID different from the one cached — the transfer/undelete case.
 * `previousNodeId`/`resolvedNodeId` name both sides so a developer reading
 * the report (or the router's own map-maintenance write) never has to
 * re-derive which value is which.
 */
interface AdoptionEntry {
  logicalKey: string;
  previousNodeId: string;
  resolvedNodeId: string;
}

/**
 * Plan 05-07 (D-14): a phase whose parent issue's sub-issue count has
 * reached or passed `PLAN_SUB_ISSUE_WARN_THRESHOLD` — reported, never acted
 * on. `count` and `limit` ride the warning itself so a renderer never has to
 * re-import the threshold constants to show them.
 */
interface SubIssueCeilingWarning {
  phaseId: string;
  issueNumber: number;
  count: number;
  limit: number;
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
      | typeof OPERATION_REASON.FIELD_UNRESOLVED
      | typeof OPERATION_REASON.PARENT_UNRESOLVED
      | typeof OPERATION_REASON.DEPENDENCY_SLOT_MISMATCH
      | typeof OPERATION_REASON.EXISTENCE_UNKNOWN;
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
  /**
   * Plan 05-07 (D-14): always present, empty when nothing applies — matches
   * `noops`/`blocked`/`orphans`. Never gates: a run that warns dispatches
   * exactly the same operations it would have dispatched without the
   * warning (pinned by test, not merely by convention).
   */
  subIssueCeilingWarnings: SubIssueCeilingWarning[];
  /**
   * Plan 07-05 Task 2 (D-13): always present, empty when nothing applies —
   * matches every neighbouring array above. Never gates: an issue whose
   * node ID is adopted here still dispatches whatever operation it would
   * have dispatched anyway, using the freshly resolved node ID rather than
   * the stale cached one.
   */
  adoptions: AdoptionEntry[];
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

/** Either a plain string argv entry or a typed refusal — never a body carrying an unsubstituted or wrongly-bound slot. */
type BodyArgvResult =
  | { kind: 'ok'; entry: ArgvEntry }
  | { kind: 'mismatch'; detail: string };

/**
 * Plan 05-06 Task 2: the shared read-splice(-write) body composer — exported
 * because `github-sync-issue-update.cts`'s PATCH path needs the identical
 * composition for a spliced body, not merely this module's create path.
 *
 * Takes a body string carrying zero or more `DEPENDENCY_REF_SENTINEL` slots
 * (plan 05-03) plus the ordered dependency plan ids those slots stand for,
 * in document order, and returns either a plain string argv entry — the
 * common, zero-dependency case, so the shape of every existing body write is
 * unchanged — or an `ArgvConcat` whose parts alternate literal segments and
 * `issue:plan:<depId>` NUMBER references prefixed with `#`, so GitHub
 * renders each as a linked issue reference resolved at dispatch time
 * (`resolveArgv`, plan 05-06 Task 1).
 *
 * Splits strictly positionally on the sentinel, deriving the observed slot
 * count from the body itself rather than trusting the caller's declared
 * dependency count (T-5-06's anti-forgery discipline, the same one
 * `substituteDependencyRefs` established at the region layer): a
 * disagreement against `dependsOn.length` returns a typed `mismatch` rather
 * than a body, so a forged sentinel in developer text (a task name, a title)
 * can never bind a reference to the wrong issue. No developer text is ever
 * scanned for a token — `dependsOn` is GSD's own parsed data, never derived
 * from the body string.
 */
function bodyArgvEntry(body: string, dependsOn: string[]): BodyArgvResult {
  const slotCount = countDependencyRefSlots(body);
  if (slotCount !== dependsOn.length) {
    return {
      kind: 'mismatch',
      detail: `expected ${slotCount} dependency reference slot(s) in the body, received ${dependsOn.length} dependency id(s)`,
    };
  }
  if (slotCount === 0) return { kind: 'ok', entry: `body=${body}` };

  const segments: string[] = body.split(DEPENDENCY_REF_SENTINEL);
  const parts: (string | ArgvRef)[] = [`body=${segments[0]}`];
  dependsOn.forEach((depId: string, index: number) => {
    parts.push({ from: planIssueKeyFor(depId), part: ARGV_REF_PART.NUMBER, prefix: '#' });
    parts.push(segments[index + 1]);
  });
  return { kind: 'ok', entry: { parts } };
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

/** Phase 5 (D-11 extended to plan sub-issues): mirrors `PHASE_KEY_PREFIX`/`ISSUE_PHASE_KEY_PREFIX`. */
const PLAN_KEY_PREFIX = 'plan:';
const ISSUE_PLAN_KEY_PREFIX = 'issue:plan:';

/**
 * Plan 05-05 Task 3: the plan id a `plan:<id>` or `issue:plan:<id>`
 * completion key names, or `null` for any other key — including every
 * reserved bootstrap-namespace key (`project`, `project-link`, `field:*`,
 * `option:status:*`, `option:autonomous:*`, `label:*`, `milestone:*`) and
 * every phase-namespace key, none of which start with either prefix.
 * `issue:plan:` is checked first, for the identical reason
 * `orphanPhaseIdFromKey` checks `issue:phase:` first: it is the longer, more
 * specific prefix, and checking the shorter one first would slice off too
 * little.
 */
function orphanPlanIdFromKey(key: string): string | null {
  if (key.startsWith(ISSUE_PLAN_KEY_PREFIX)) return key.slice(ISSUE_PLAN_KEY_PREFIX.length);
  if (key.startsWith(PLAN_KEY_PREFIX)) return key.slice(PLAN_KEY_PREFIX.length);
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
 * Plan 05-05 Task 1: the six item field values for a plan, derived from disk
 * truth alone — the plan-level mirror of `desiredFieldValuesFor`. `gsdId` is
 * the plan's own logical key, never re-derived from the issue or the board.
 * `wave`/`autonomous`/`requirements` default to `null`/`false`/`[]` for a
 * `DesiredPlan` fixture that omits them, matching `github-sync-desired.cts`'s
 * own total-by-construction defaults.
 */
function desiredPlanFieldValuesFor(plan: DesiredPlan, logicalKey: string): FieldValues {
  return {
    gsdId: logicalKey,
    phaseId: plan.phaseId,
    requirements: plan.requirements ?? [],
    status: plan.status ?? '',
    wave: plan.wave ?? null,
    autonomous: plan.autonomous ?? false,
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
const FIELD_VALUE_DATA_TYPE = Object.freeze({ TEXT: 'TEXT', SINGLE_SELECT: 'SINGLE_SELECT', NUMBER: 'NUMBER' } as const);
type FieldValueDataType = typeof FIELD_VALUE_DATA_TYPE[keyof typeof FIELD_VALUE_DATA_TYPE];
const FIELD_VALUE_SPEC: ReadonlyArray<{ fieldName: FieldName; declaredName: string; dataType: FieldValueDataType }> = Object.freeze([
  Object.freeze({ fieldName: 'gsdId' as const, declaredName: 'GSD ID', dataType: FIELD_VALUE_DATA_TYPE.TEXT }),
  Object.freeze({ fieldName: 'phaseId' as const, declaredName: 'Phase', dataType: FIELD_VALUE_DATA_TYPE.TEXT }),
  Object.freeze({ fieldName: 'requirements' as const, declaredName: 'Requirements', dataType: FIELD_VALUE_DATA_TYPE.TEXT }),
  Object.freeze({ fieldName: 'status' as const, declaredName: STATUS_FIELD_NAME, dataType: FIELD_VALUE_DATA_TYPE.SINGLE_SELECT }),
]);

/**
 * Plan 05-05 Task 1: the plan item's six fields, in the fixed declared write
 * order — `GSD ID`, `Phase`, `Requirements`, `Status`, `Wave`, `Autonomous`.
 * Mirrors `PLAN_FIELD_NAMES`'s order exactly (`github-sync-issue-body.cts`).
 * `Wave` and `Autonomous` never appear on `FIELD_VALUE_SPEC` above — that
 * spec stays the phase-only four, unchanged by this plan.
 */
const PLAN_FIELD_VALUE_SPEC: ReadonlyArray<{ fieldName: FieldName; declaredName: string; dataType: FieldValueDataType }> = Object.freeze([
  Object.freeze({ fieldName: 'gsdId' as const, declaredName: 'GSD ID', dataType: FIELD_VALUE_DATA_TYPE.TEXT }),
  Object.freeze({ fieldName: 'phaseId' as const, declaredName: 'Phase', dataType: FIELD_VALUE_DATA_TYPE.TEXT }),
  Object.freeze({ fieldName: 'requirements' as const, declaredName: 'Requirements', dataType: FIELD_VALUE_DATA_TYPE.TEXT }),
  Object.freeze({ fieldName: 'status' as const, declaredName: STATUS_FIELD_NAME, dataType: FIELD_VALUE_DATA_TYPE.SINGLE_SELECT }),
  Object.freeze({ fieldName: 'wave' as const, declaredName: 'Wave', dataType: FIELD_VALUE_DATA_TYPE.NUMBER }),
  Object.freeze({ fieldName: 'autonomous' as const, declaredName: 'Autonomous', dataType: FIELD_VALUE_DATA_TYPE.SINGLE_SELECT }),
]);

/**
 * RESEARCH.md Pitfall 4: `gh api graphql`'s `-f`/`-F` flags cannot encode
 * `updateProjectV2ItemFieldValue`'s `value` argument (a oneof-style input
 * object) as a single flag value — every published example inlines the whole
 * object with the value interpolated, which would concatenate a
 * developer-influenced string into a query document
 * (`github-sync-operation.cts`'s SECURITY rule forbids this outright). The
 * resolution mirrors `CREATE_FIELD_TEXT_DOCUMENT`/
 * `CREATE_FIELD_SINGLE_SELECT_DOCUMENT`/`CREATE_FIELD_NUMBER_DOCUMENT`
 * (github-sync-bootstrap-plan.cts) in shape: one document per data type, the
 * wrapper key (`text`/`singleSelectOptionId`/`number`) a literal in the
 * query text, only the scalar leaf riding a variable. All three documents
 * select `projectV2Item { id content { ... on Issue { number } } }`, not
 * merely `id` — so re-recording the phase's (or plan's) project-item
 * completion after a field write preserves the issue number the
 * add-to-project capture stored; selecting only `id` would silently drop it.
 * No `rateLimit` selection and no points-budget selection, for the same
 * live-verified reason every other document in this capability declares
 * `hasPointsBudget: false`.
 */
const UPDATE_FIELD_VALUE_TEXT_DOCUMENT =
  'mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$value:String!) { # github-sync:updateFieldValueText\n' +
  'updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{text:$value}}) { ' +
  'projectV2Item { id content { ... on Issue { number } } } } }';
const UPDATE_FIELD_VALUE_SINGLE_SELECT_DOCUMENT =
  'mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$value:String!) { # github-sync:updateFieldValueSingleSelect\n' +
  'updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{singleSelectOptionId:$value}}) { ' +
  'projectV2Item { id content { ... on Issue { number } } } } }';
/**
 * Plan 05-05 Task 1: the NUMBER variant `Wave` needs, absent until now
 * (05-RESEARCH.md Pitfall 4 / Open Question 3). Mirrors the two documents
 * above exactly, except the value wrapper key is `number` and `$value` is
 * declared `Float!` per GitHub's `ProjectV2FieldValue` input — a
 * community-sourced fact (05-RESEARCH.md assumption A3), not yet live-tested
 * in this codebase for the NUMBER case specifically; 05-08's live run is
 * where it is proven, the same "flagged in place" comment discipline this
 * module already applies to its two siblings.
 */
const UPDATE_FIELD_VALUE_NUMBER_DOCUMENT =
  'mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$value:Float!) { # github-sync:updateFieldValueNumber\n' +
  'updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{number:$value}}) { ' +
  'projectV2Item { id content { ... on Issue { number } } } } }';

/** Mirrors `fieldCreateDocument`'s shape (github-sync-bootstrap-plan.cts). */
function documentForFieldType(dataType: FieldValueDataType): string {
  if (dataType === FIELD_VALUE_DATA_TYPE.SINGLE_SELECT) return UPDATE_FIELD_VALUE_SINGLE_SELECT_DOCUMENT;
  if (dataType === FIELD_VALUE_DATA_TYPE.NUMBER) return UPDATE_FIELD_VALUE_NUMBER_DOCUMENT;
  return UPDATE_FIELD_VALUE_TEXT_DOCUMENT;
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
 * Plan 05-05 Task 1: the plan-level mirror of `buildFieldValueOperations`,
 * built against `PLAN_FIELD_VALUE_SPEC`'s six-member fixed order instead of
 * `FIELD_VALUE_SPEC`'s four. Every invariant `buildFieldValueOperations`
 * states applies here unchanged: field/option ids resolve synchronously
 * against `completions` (never a live read), the first unresolved id stops
 * this one plan's whole field-write sequence with a single typed
 * `FIELD_UNRESOLVED` blocked entry, project id and item id ride `ArgvRef`s,
 * and only the LAST emitted operation's capture carries
 * `plannerFields.fieldState` (serialized via
 * `renderFieldState(desiredValues, PLAN_FIELD_NAMES)` — the six-name variant,
 * never the phase default).
 *
 * Two plan-only differences:
 *
 * - `status` resolves `option:status:<slug>` exactly as the phase builder
 *   does; `autonomous` resolves `option:autonomous:yes` or
 *   `option:autonomous:no` (never a literal name, never a literal id) —
 *   `desiredValues.autonomous ? 'Yes' : 'No'` is the only place this mapping
 *   is written.
 * - `wave` is skipped entirely — no field-id resolution attempted, no
 *   operation emitted — when the plan's own `wave` is `null` (the
 *   `<accepted_limitation>` this plan documents: clearing an already-set
 *   Wave cell needs a `clearProjectV2ItemFieldValue` mutation this capability
 *   has never called). When non-null, `wave`'s value is the one argv entry
 *   in this builder that is a validated positive integer rather than a
 *   developer string. LIVE FINDING (05-08): it rides the typed `-F` flag, not
 *   `-f` — `UPDATE_FIELD_VALUE_NUMBER_DOCUMENT` declares `$value: Float!`,
 *   and GitHub's GraphQL endpoint refuses to coerce the raw-string encoding
 *   `-f` produces ("Could not coerce value \"1\" to Float", reproduced live
 *   against board #10). `-F` lets `gh` send a JSON number instead, which the
 *   live schema accepts. This corrects this comment's own prior claim that
 *   there was no typing benefit; `github-sync-operation.cts`'s SECURITY rule
 *   permits `-F` for exactly this case (a validated positive integer, never
 *   developer text).
 */
function buildPlanFieldValueOperations(
  plan: DesiredPlan,
  changed: FieldName[],
  completions: Record<string, StrictMapCompletion>,
  projectItemKey: string,
  context: CompletionContext,
): { operations: MutationOperation[]; blocked: Array<{ reason: typeof OPERATION_REASON.FIELD_UNRESOLVED; detail: string }> } {
  if (changed.length === 0) return { operations: [], blocked: [] };

  const changedSet = new Set(changed);
  const desiredValues = desiredPlanFieldValuesFor(plan, projectItemKey);

  const resolved: Array<{ dataType: FieldValueDataType; fieldId: string; valueEntry: ArgvEntry }> = [];

  for (const spec of PLAN_FIELD_VALUE_SPEC) {
    if (!changedSet.has(spec.fieldName)) continue;
    // The accepted limitation: a null Wave contributes no operation at all,
    // and no field/option id is resolved for it — a run with only Wave
    // cleared still converges to zero operations rather than refusing on an
    // id it will never use.
    if (spec.fieldName === 'wave' && desiredValues.wave === null) continue;

    const fieldKey = BOOTSTRAP_LOGICAL_KEY.field(spec.declaredName);
    const fieldCompletion = completions[fieldKey];
    if (!fieldCompletion || !isNonEmptyString(fieldCompletion.nodeId)) {
      return { operations: [], blocked: [{ reason: OPERATION_REASON.FIELD_UNRESOLVED, detail: `${fieldKey} has no resolved completion` }] };
    }

    let valueEntry: ArgvEntry;
    if (spec.fieldName === 'status') {
      const statusOptionKey = BOOTSTRAP_LOGICAL_KEY.statusOption(desiredValues.status);
      const optionCompletion = completions[statusOptionKey];
      if (!optionCompletion || !isNonEmptyString(optionCompletion.nodeId)) {
        return { operations: [], blocked: [{ reason: OPERATION_REASON.FIELD_UNRESOLVED, detail: `${statusOptionKey} has no resolved completion` }] };
      }
      valueEntry = { from: statusOptionKey, part: ARGV_REF_PART.NODE_ID, prefix: 'value=' };
    } else if (spec.fieldName === 'autonomous') {
      const autonomousOptionKey = BOOTSTRAP_LOGICAL_KEY.autonomousOption(desiredValues.autonomous ? 'Yes' : 'No');
      const optionCompletion = completions[autonomousOptionKey];
      if (!optionCompletion || !isNonEmptyString(optionCompletion.nodeId)) {
        return { operations: [], blocked: [{ reason: OPERATION_REASON.FIELD_UNRESOLVED, detail: `${autonomousOptionKey} has no resolved completion` }] };
      }
      valueEntry = { from: autonomousOptionKey, part: ARGV_REF_PART.NODE_ID, prefix: 'value=' };
    } else if (spec.fieldName === 'wave') {
      // SECURITY: a validated positive integer, not a developer string.
      // Dispatched on -F below (see the LIVE FINDING comment on the
      // operations map a few lines down) — never -f, per the live Float!
      // coercion fix.
      valueEntry = `value=${desiredValues.wave}`;
    } else {
      valueEntry = `value=${textValueFor(spec.fieldName, desiredValues)}`;
    }

    resolved.push({ dataType: spec.dataType, fieldId: fieldCompletion.nodeId, valueEntry });
  }

  const operations: MutationOperation[] = resolved.map((entry, index) => {
    const isLast = index === resolved.length - 1;
    // LIVE FINDING (05-08): $value is declared Float! in
    // UPDATE_FIELD_VALUE_NUMBER_DOCUMENT. `gh api graphql -f value=<n>` sends
    // the value as a raw JSON string, which GraphQL refuses to coerce to
    // Float! ("Could not coerce value \"1\" to Float", reproduced live
    // against board #10, 2026-08-03). The typed -F flag lets gh's own
    // type-guessing send a JSON number instead, which the live schema
    // accepts. This is squarely inside the SECURITY rule's documented
    // exception (github-sync-operation.cts): Wave is a validated positive
    // integer (parsed via /^wave:\s*(\d+)\s*$/), never a developer string, so
    // -F carries no forgery risk here — only the NUMBER-typed value entry
    // uses it; every other value on this operation stays on -f.
    const valueFlag = entry.dataType === FIELD_VALUE_DATA_TYPE.NUMBER ? '-F' : '-f';
    const args: ArgvEntry[] = [
      'api', 'graphql',
      '-f', `query=${documentForFieldType(entry.dataType)}`,
      // SECURITY: projectId/itemId/fieldId are all opaque GitHub node ids and
      // ride the raw -f flag, never the typed -F flag.
      '-f', { from: BOOTSTRAP_LOGICAL_KEY.project(), part: ARGV_REF_PART.NODE_ID, prefix: 'projectId=' },
      '-f', { from: projectItemKey, part: ARGV_REF_PART.NODE_ID, prefix: 'itemId=' },
      '-f', `fieldId=${entry.fieldId}`,
      valueFlag, entry.valueEntry,
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
      // content-creation pacing budget the three create operations share.
      contentCreation: false,
      captures: [{
        kind: 'node',
        logicalKey: projectItemKey,
        nodeIdPath: 'updateProjectV2ItemFieldValue.projectV2Item.id',
        numberPath: 'updateProjectV2ItemFieldValue.projectV2Item.content.number',
        ...(isLast ? { plannerFields: { fieldState: renderFieldState(desiredValues, PLAN_FIELD_NAMES) } } : {}),
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
 * milestone completion (D-15).
 *
 * Plan 05-05 (Rule 1 fix): unlike `buildCreateIssueOperation`, this create's
 * own capture is NOT where `plannerFields.contentHash` is recorded.
 * `buildAddSubIssueOperation` below captures under this SAME `issueKey` —
 * GitHub's `addSubIssue` response echoes the same sub-issue identity back —
 * and `recordCompletion` (`github-sync-map.cts`) replaces a logical key's
 * completion wholesale rather than merging it. Recording the hash here would
 * have it silently wiped by the addSubIssue capture that always follows in
 * the same run, leaving `issue:plan:<id>` permanently hash-less and every
 * future run generating a pending update it can never converge out of. The
 * hash therefore rides the LAST operation to write this logical key, exactly
 * the same "only the last write wins" discipline `buildFieldValueOperations`
 * already applies to `plannerFields.fieldState`.
 *
 * Plan 05-06 Task 2: `bodyEntry` is the caller's already-composed argv entry
 * for `-f body=` — a plain string (no dependencies) or an `ArgvConcat`
 * (`bodyArgvEntry`'s two shapes) — never rebuilt here, so the caller's own
 * dependency-resolvability and slot-count checks (`planReconciliation`)
 * cannot disagree with what this operation actually dispatches.
 */
function buildCreatePlanIssueOperation(
  plan: DesiredPlan,
  issueKey: string,
  milestoneKey: string,
  restApiPath: string,
  context: CompletionContext,
  bodyEntry: ArgvEntry,
): MutationOperation {
  const planLabel = GSD_LABELS.find((label) => label.name === PLAN_LABEL_NAME);
  const labelName = planLabel ? planLabel.name : PLAN_LABEL_NAME;
  const args: ArgvEntry[] = [
    'api', restApiPath, '-X', 'POST',
    // SECURITY: every plan-sourced string (title, rendered body) rides the
    // raw -f flag — never the typed -F flag, which performs @-file and
    // {owner}/{repo} substitution on the value.
    '-f', `title=${plan.title}`,
    '-f', bodyEntry,
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
 *
 * Plan 05-05: `plannerFields` (the freshly computed content hash) rides
 * THIS operation's capture, not the preceding create's — see
 * `buildCreatePlanIssueOperation`'s doc comment for why.
 */
function buildAddSubIssueOperation(planId: string, phaseId: string, context: CompletionContext, plannerFields?: Record<string, string>): MutationOperation {
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
      ...(plannerFields === undefined ? {} : { plannerFields }),
    }],
  };
}

/**
 * Plan 05-06 Task 3 (D-08): the plan issue's own open/closed state PATCH —
 * mirrors `github-sync-issue-update.cts`'s content PATCH shape (explicit
 * method, the raw value flag, no labels entry of any kind, one node capture
 * carrying the just-written state as a planner field), but never touches the
 * body: this is a distinct convergence unit from the issue-content
 * projection above (D-12's coupling constraint, generalized a second time).
 *
 * The REST path is built through the SAME guarded `phaseIssueRestPath`
 * builder every other REST operation in this module uses, re-asserting the
 * owner/repo charset check at this call site (T-04-02) rather than trusting
 * the whole-run gate `planReconciliation` already ran. Returns `null` on a
 * charset failure — a typed blocked entry for the caller to report, never a
 * `gh` invocation.
 *
 * `contentCreation: false`: a state PATCH creates no new content, so a
 * reopen never consumes the content-creation pacing budget BOOT-level
 * creates need — it can dispatch immediately, exactly like a field-value
 * write.
 *
 * `existingContentHash` (Rule 1 fix, found by testing the four-step D-08
 * cycle live): this capture shares `issueKey`'s logical key with the
 * create/update path's own `contentHash` capture, and `recordCompletion`
 * replaces a logical key's completion wholesale, not by merge. Dispatching
 * a state PATCH on a run where content is otherwise converged (the common
 * case: only the state differs) would silently wipe the already-recorded
 * `contentHash`, making every subsequent run believe content diverged and
 * generating an unbounded stream of pending body-updates — the exact same
 * failure class plan 05-05 fixed for the create/addSubIssue pair. Threading
 * the caller's already-known `contentHash` through this capture is what
 * keeps it durable across a state-only run.
 */
function buildPlanIssueStateOperation(
  owner: string,
  repo: string,
  issueNumber: number,
  issueKey: string,
  state: PlanIssueStateValue,
  context: CompletionContext,
  existingContentHash?: string,
): MutationOperation | null {
  const restApiPath = phaseIssueRestPath(owner, repo, `/issues/${issueNumber}`);
  if (!restApiPath) return null;
  return {
    kind: 'update-plan-issue-state',
    logicalKey: issueKey,
    args: [
      'api', restApiPath, '-X', 'PATCH',
      // SECURITY: the state literal is GSD's own ('open'/'closed'), but it
      // still rides the raw -f flag, matching every other value entry in
      // this module — never the typed -F flag.
      '-f', `state=${state}`,
      // Deliberately no labels[]= entry of any kind — GitHub's issue-update
      // endpoint replaces the whole label set, and this PATCH exists only to
      // flip open/closed (T-5-14).
    ],
    completionContext: context,
    transport: OPERATION_TRANSPORT.REST,
    action: OPERATION_ACTION.UPDATE,
    hasPointsBudget: false,
    contentCreation: false,
    captures: [{
      kind: 'node',
      logicalKey: issueKey,
      nodeIdPath: 'node_id',
      numberPath: 'number',
      plannerFields: {
        issueState: state,
        ...(existingContentHash === undefined ? {} : { contentHash: existingContentHash }),
      },
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
 * Plan 07-05 Task 2 (D-13): the two logical-key prefixes whose cached
 * `nodeId` is the ISSUE's own node id (not a project item's) — the only two
 * shapes a stale-vs-resolved node ID comparison is meaningful for. The
 * legacy `phase:<id>`/`plan:<id>` project-item keys are deliberately
 * excluded: their `nodeId` is the project ITEM's node id
 * (`addProjectV2ItemById.item.id`), a different object than the issue
 * `resolvedIssueNodeId` resolves, so comparing the two would misfire an
 * adoption on every run.
 */
const ADOPTABLE_KEY_PREFIXES: readonly string[] = [ISSUE_PHASE_KEY_PREFIX, ISSUE_PLAN_KEY_PREFIX];

/**
 * D-13: one adoption entry per issue-identity completion whose
 * `(owner, repo, number)` re-resolution succeeds with a node ID different
 * from the one cached — computed once, over every completion in the map,
 * independent of which decision-order branch (if any) a phase/plan reaches
 * this run. Sorted by logical key (matching `collectOrphans`' own sort) so
 * the result is deterministic and stable across runs with identical input.
 */
function detectAdoptions(
  completions: Record<string, StrictMapCompletion>,
  issueNodeIds: RemoteSnapshot['issueNodeIds'],
): AdoptionEntry[] {
  const adoptions: AdoptionEntry[] = [];
  for (const [logicalKey, entry] of Object.entries(completions)) {
    if (!entry || !isNonEmptyString(entry.nodeId)) continue;
    if (!ADOPTABLE_KEY_PREFIXES.some((prefix) => logicalKey.startsWith(prefix))) continue;
    const resolved = resolvedIssueNodeId(issueNodeIds, entry.issueNumber);
    if (resolved !== null && resolved !== entry.nodeId) {
      adoptions.push({ logicalKey, previousNodeId: entry.nodeId, resolvedNodeId: resolved });
    }
  }
  return adoptions.sort((left, right) => left.logicalKey.localeCompare(right.logicalKey, undefined, { numeric: true }));
}

/**
 * Plan 05-06 Task 2: whether `depId`'s plan-issue completion will be
 * resolvable by the time an `ArgvRef` naming it dispatches — either from a
 * prior run's own `issue:plan:<depId>` completion (a non-empty node id), or
 * from a plan-create/link operation THIS run already pushed earlier in the
 * ascending-id plan pass (`operationsSoFar` is a live reference to the same
 * array `planReconciliation` keeps appending to, so this check sees every
 * operation pushed for a lower-sorting dependency). Mirrors the D-13
 * parent-phase check's `parentResolvedFromMap || parentCreatedThisRun`
 * shape, generalized from one fixed key to an arbitrary dependency id.
 */
function planDependencyResolvable(
  depId: string,
  completions: Record<string, StrictMapCompletion>,
  operationsSoFar: MutationOperation[],
): boolean {
  const depIssueKey = planIssueKeyFor(depId);
  const fromMap = Boolean(completions[depIssueKey]) && isNonEmptyString(completions[depIssueKey].nodeId);
  const fromThisRun = operationsSoFar.some((op) => op.logicalKey === depIssueKey);
  return fromMap || fromThisRun;
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
function planReconciliation(
  desired: DesiredState,
  remote: RemoteSnapshot,
  strictMap: StrictMap,
  existenceVerdicts?: ExistenceVerdictLike[],
): ReconciliationPlan {
  const empty = { operations: [], noops: [], pendingIssueUpdates: [], orphans: [], pendingFieldChanges: [], subIssueCeilingWarnings: [], adoptions: [] };
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

  // D-13: computed once, before either loop, so an adoption is detected
  // regardless of which decision-order branch (if any) the phase/plan
  // reaches this run. `adoptedNodeIdFor` is the resolved-node-id lookup the
  // two "issue exists but not yet bound" branches below consult instead of
  // the completion's own (possibly stale) `nodeId`.
  const adoptions = detectAdoptions(completions, remote.issueNodeIds);
  const adoptedNodeIdFor = new Map(adoptions.map((entry) => [entry.logicalKey, entry.resolvedNodeId]));

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
      // D-13: bind using the freshly re-resolved node ID when this issue was
      // adopted this run — the stale cached one would fail the mutation live
      // (a transferred/undeleted issue's old node id no longer resolves).
      const bindContentId = adoptedNodeIdFor.get(issueKey) ?? issueCompletion.nodeId;
      operations.push(operationFor(logicalKey, remote.target.projectNodeId, bindContentId, remote.target));
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

  // Plan 05-05 Task 2: a second pass over `desired.plans`, appended after the
  // phase loop above rather than interleaved with it — this is what makes
  // D-13's ordering constraint (phase creates before any plan create) hold
  // structurally, not by convention. Mirrors the phase loop's own six-branch
  // decision order (per-plan, ascending id), plus D-13's sixth branch a phase
  // does not need: an unresolvable parent.
  const milestoneCompletionForPlans = milestoneKey ? completions[milestoneKey] : undefined;
  for (const plan of [...(desired.plans ?? [])].sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))) {
    const planLogicalKey = planKeyFor(plan.id);
    const planIssueKey = planIssueKeyFor(plan.id);
    const planCompletion = completions[planLogicalKey];
    const planIssueCompletion = completions[planIssueKey];
    const phaseIssueKeyForPlan = issueKeyFor(plan.phaseId);

    if (bindingOnBoard(planCompletion, remote)) {
      if (!planIssueCompletion) {
        // A plan bound on the board with no issue:plan:<id> completion has
        // never migrated onto the content-hash/field-state system — left a
        // plain no-op, mirroring the phase loop's identical pre-Phase-4 case.
        noops.push({ logicalKey: planLogicalKey });
        continue;
      }
      if (!milestoneCompletionForPlans || milestoneCompletionForPlans.issueNumber === undefined) {
        blocked.push({ reason: OPERATION_REASON.MILESTONE_UNRESOLVED, detail: planLogicalKey });
        continue;
      }

      const dependsOnForBound = plan.dependsOn ?? [];
      // CR-01 (05-REVIEW re-review): the create branch below already refuses
      // to dispatch a create whose dependsOn contains an unresolvable id
      // (`planDependencyResolvable`, reported as a scoped
      // DEPENDENCY_SLOT_MISMATCH). The already-bound branch had no equivalent
      // guard — an unresolved dependency id used to survive as an
      // unsubstituted ArgvRef into `pendingIssueUpdates`, only to be caught
      // later, all-or-nothing, by `resolveArgv` at dispatch time — aborting
      // every other operation in the run, not just this plan's. Mirroring the
      // create branch's check here means an unresolvable dependency on an
      // update is reported and skipped per-plan, exactly like a create.
      const unresolvedDependencyForBound = dependsOnForBound.find(
        (depId) => !planDependencyResolvable(depId, completions, operations),
      );
      if (unresolvedDependencyForBound !== undefined) {
        blocked.push({
          reason: OPERATION_REASON.DEPENDENCY_SLOT_MISMATCH,
          detail: planIssueKeyFor(unresolvedDependencyForBound),
        });
        continue;
      }
      const planRegion = renderPlanRegion({ id: plan.id, title: plan.title, status: plan.status, tasks: plan.tasks, dependsOn: dependsOnForBound });
      const milestoneNumberForPlan = milestoneCompletionForPlans.issueNumber;
      // D-03 (plan 05-03): the hash is computed over the plan-id form — the
      // dependency slots substituted with the depended-on plans' OWN ids, never
      // the real issue numbers a dispatch later resolves — so a board rebuild
      // that reassigns issue numbers can never move this plan's hash.
      const planIdSubstitutionForBound = substituteDependencyRefs(planRegion, dependsOnForBound);
      if (planIdSubstitutionForBound.kind === 'mismatch') {
        blocked.push({ reason: OPERATION_REASON.DEPENDENCY_SLOT_MISMATCH, detail: planIdSubstitutionForBound.detail });
        continue;
      }
      const desiredPlanHash = contentHash({ title: plan.title, region: planIdSubstitutionForBound.text, milestoneNumber: milestoneNumberForPlan });
      const planContentConverged = planIssueCompletion.contentHash !== undefined && planIssueCompletion.contentHash === desiredPlanHash;

      const desiredPlanFieldValues = desiredPlanFieldValuesFor(plan, planLogicalKey);
      const previousPlanFieldState: ParsedFieldState = planCompletion.fieldState !== undefined
        ? parseFieldState(planCompletion.fieldState, PLAN_FIELD_NAMES)
        : { kind: 'unknown' };
      const planChanged = changedFields(previousPlanFieldState, desiredPlanFieldValues, PLAN_FIELD_NAMES);

      // D-08 (plan 05-06 Task 3): the plan issue's own open/closed state — a
      // THIRD convergence unit, independent of the content and field units
      // above (D-12's coupling discipline, generalized a second time). The
      // desired state is closed when readPlans()'s own `complete` boolean is
      // true, open otherwise — the same signal, not a second derivation. A
      // completion recorded before this change (no `issueState` member) is
      // `undefined`, which never strictly-equals either literal, so it
      // converges with exactly one write here rather than being skipped.
      const desiredIssueState: PlanIssueStateValue = plan.complete === true ? PLAN_ISSUE_STATE.CLOSED : PLAN_ISSUE_STATE.OPEN;
      const stateConverged = planIssueCompletion.issueState === desiredIssueState;
      if (!stateConverged && typeof planIssueCompletion.issueNumber === 'number') {
        const stateOp = buildPlanIssueStateOperation(
          remote.target.owner, remote.target.repo, planIssueCompletion.issueNumber, planIssueKey, desiredIssueState, context,
          // Rule 1 fix: carry the freshly computed content hash forward on
          // this capture too, so a state-only run (the common case) never
          // wipes it under recordCompletion's wholesale-replace semantics —
          // see buildPlanIssueStateOperation's own doc comment for why.
          desiredPlanHash,
        );
        if (stateOp) {
          operations.push(stateOp);
        } else {
          // Unreachable in practice — the whole-run unsafe-target gate above
          // already rejected this owner/repo before any plan reached this
          // point. Kept as a typed fallback rather than a non-null assertion.
          blocked.push({ reason: OPERATION_REASON.UNSAFE_TARGET, detail: planLogicalKey });
        }
      }

      if (!planContentConverged) {
        pendingIssueUpdates.push({
          logicalKey: planLogicalKey,
          issueKey: planIssueKey,
          issueNumber: planIssueCompletion.issueNumber,
          issueNodeId: planIssueCompletion.nodeId,
          title: plan.title,
          region: planRegion,
          milestoneNumber: milestoneNumberForPlan,
          milestoneKey: milestoneKey as string,
          contentHash: desiredPlanHash,
          completionContext: context,
          dependsOn: dependsOnForBound,
        });
      }
      if (planChanged.length > 0) {
        pendingFieldChanges.push({ logicalKey: planLogicalKey, changed: planChanged });
        const planFieldResult = buildPlanFieldValueOperations(plan, planChanged, completions, planLogicalKey, context);
        operations.push(...planFieldResult.operations);
        blocked.push(...planFieldResult.blocked);
      }
      if (planContentConverged && planChanged.length === 0 && stateConverged) noops.push({ logicalKey: planLogicalKey });
      continue;
    }

    if (planIssueCompletion) {
      // GSD created this plan issue on an earlier run but it is not yet
      // bound to the project — bind it via a literal content id, no create.
      // D-13: use the freshly re-resolved node ID when this plan issue was
      // adopted this run, mirroring the phase loop's identical guard above.
      const planBindContentId = adoptedNodeIdFor.get(planIssueKey) ?? planIssueCompletion.nodeId;
      operations.push(operationFor(planLogicalKey, remote.target.projectNodeId, planBindContentId, remote.target));
      continue;
    }

    // No completion of any kind: this plan has never been created or bound.
    // D-13: the parent phase issue must be resolvable either from a prior
    // run's own completion, or from a phase-create operation this very run
    // already pushed (checked structurally against `operations`, since the
    // phase loop above always finishes before this loop starts).
    const phaseIssueCompletion = completions[phaseIssueKeyForPlan];
    const parentResolvedFromMap = Boolean(phaseIssueCompletion) && isNonEmptyString(phaseIssueCompletion.nodeId);
    const parentCreatedThisRun = operations.some((op) => op.kind === 'create-issue' && op.logicalKey === phaseIssueKeyForPlan);
    if (!parentResolvedFromMap && !parentCreatedThisRun) {
      blocked.push({ reason: OPERATION_REASON.PARENT_UNRESOLVED, detail: planLogicalKey });
      continue;
    }

    if (!milestoneCompletionForPlans || milestoneCompletionForPlans.issueNumber === undefined) {
      blocked.push({ reason: OPERATION_REASON.MILESTONE_UNRESOLVED, detail: planLogicalKey });
      continue;
    }

    const restApiPath = phaseIssueRestPath(remote.target.owner, remote.target.repo, '/issues');
    if (!restApiPath) {
      // Unreachable in practice — the whole-run unsafe-target gate above
      // already rejected this owner/repo before any plan reached this point.
      blocked.push({ reason: OPERATION_REASON.UNSAFE_TARGET, detail: planLogicalKey });
      continue;
    }

    // Phase 5 Task 2 (D-03/T-5-06): every dependency this plan declares must
    // be resolvable by the time this create would dispatch — from a prior
    // run's own issue:plan:<depId> completion, or from a plan-issue create
    // this very run already pushed earlier in this same ascending-id pass.
    // Mirrors the parent-phase check above, generalized to a plan's own
    // dependency list: an unresolvable dependency refuses the WHOLE create
    // (never a body carrying an unsubstituted slot), naming the missing key,
    // and never suppresses a sibling plan.
    const dependsOn = plan.dependsOn ?? [];
    const unresolvedDependency = dependsOn.find((depId) => !planDependencyResolvable(depId, completions, operations));
    if (unresolvedDependency !== undefined) {
      blocked.push({ reason: OPERATION_REASON.DEPENDENCY_SLOT_MISMATCH, detail: planIssueKeyFor(unresolvedDependency) });
      continue;
    }

    const planRegion = renderPlanRegion({ id: plan.id, title: plan.title, status: plan.status, tasks: plan.tasks, dependsOn });
    const milestoneNumberForPlan = milestoneCompletionForPlans.issueNumber;
    // D-03: contentHash rides the plan-id substitution — see the identical
    // comment on the already-bound branch above.
    const planIdSubstitution = substituteDependencyRefs(planRegion, dependsOn);
    if (planIdSubstitution.kind === 'mismatch') {
      blocked.push({ reason: OPERATION_REASON.DEPENDENCY_SLOT_MISMATCH, detail: planIdSubstitution.detail });
      continue;
    }
    const desiredPlanHash = contentHash({ title: plan.title, region: planIdSubstitution.text, milestoneNumber: milestoneNumberForPlan });

    // The dispatched body, by contrast, carries the real (late-bound) issue
    // numbers — bodyArgvEntry composes it from the SAME region, wrapped in
    // the marker/fence pair, as an ArgvConcat resolved at apply time.
    const fullPlanBody = renderNewPlanIssueBody({ id: plan.id, title: plan.title, status: plan.status, tasks: plan.tasks, dependsOn });
    const bodyResult = bodyArgvEntry(fullPlanBody, dependsOn);
    if (bodyResult.kind === 'mismatch') {
      blocked.push({ reason: OPERATION_REASON.DEPENDENCY_SLOT_MISMATCH, detail: bodyResult.detail });
      continue;
    }

    operations.push(buildCreatePlanIssueOperation(plan, planIssueKey, milestoneKey as string, restApiPath, context, bodyResult.entry));
    // D-08 (plan 05-06 Task 3): GitHub's REST create endpoint has no `state`
    // parameter — every freshly created issue is open, unconditionally, no
    // matter what `plan.complete` says at create time. Capturing that known
    // state here (the LAST write to `issue:plan:<id>`, same "only the last
    // write carries plannerFields" discipline `contentHash` already follows)
    // means the very next run reads a real, non-`unknown` state and — for
    // the common case (still incomplete) — converges with zero further
    // operations, rather than manufacturing a needless immediate PATCH the
    // "unknown state converges by rewriting" rule would otherwise trigger.
    operations.push(buildAddSubIssueOperation(plan.id, plan.phaseId, context, { contentHash: desiredPlanHash, issueState: PLAN_ISSUE_STATE.OPEN }));
    operations.push(operationFor(planLogicalKey, remote.target.projectNodeId, { from: planIssueKey }, remote.target));

    // A brand-new plan carries no previous field state at all — every field
    // is "changed" by construction, mirroring the phase create branch's own
    // treatment of a brand-new phase.
    const allPlanFieldNames = changedFields({ kind: 'unknown' }, desiredPlanFieldValuesFor(plan, planLogicalKey), PLAN_FIELD_NAMES);
    const planFieldResult = buildPlanFieldValueOperations(plan, allPlanFieldNames, completions, planLogicalKey, context);
    operations.push(...planFieldResult.operations);
    blocked.push(...planFieldResult.blocked);
  }

  // Plan 04-04 Task 1 (D-11), extended by plan 05-05 Task 3 to the two plan
  // namespaces: one orphan rule across both issue kinds, not a second pass.
  // A bootstrap-namespace key (`project`, `field:*`, `option:status:*`,
  // `option:autonomous:*`, `label:*`, `milestone:*`) never starts with any of
  // the four prefixes and is never reported. Both completions for the same
  // id collapse into one orphan entry; whichever holds a number wins.
  function collectOrphans(
    desiredIds: Set<string>,
    idFromKey: (key: string) => string | null,
    keyPrefix: string,
  ): ReconciliationPlan['orphans'] {
    const orphanNumbers = new Map<string, number | undefined>();
    for (const [key, entry] of Object.entries(completions)) {
      const id = idFromKey(key);
      if (id === null || desiredIds.has(id)) continue;
      const existing = orphanNumbers.get(id);
      if (!orphanNumbers.has(id) || (existing === undefined && entry.issueNumber !== undefined)) {
        orphanNumbers.set(id, entry.issueNumber);
      }
    }
    return [...orphanNumbers.entries()]
      .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
      .map(([id, issueNumber]) => (issueNumber === undefined ? { logicalKey: `${keyPrefix}${id}` } : { logicalKey: `${keyPrefix}${id}`, issueNumber }));
  }

  const desiredPhaseIds = new Set(desired.phases.map((phase) => phase.id));
  const desiredPlanIds = new Set((desired.plans ?? []).map((plan) => plan.id));
  const orphans: ReconciliationPlan['orphans'] = [
    ...collectOrphans(desiredPhaseIds, orphanPhaseIdFromKey, PHASE_KEY_PREFIX),
    ...collectOrphans(desiredPlanIds, orphanPlanIdFromKey, PLAN_KEY_PREFIX),
  ];

  // Plan 05-07 (D-14): a per-parent sub-issue count, computed entirely from
  // `remote.subIssues` — the paginated read this run already performed
  // (`github-sync-remote.cts`'s `readRemoteSnapshot`), never a new remote
  // call. Every returned node counts, archived or not: whether GitHub's
  // `subIssues` connection even returns archived sub-issues, and whether an
  // archived sub-issue counts toward GitHub's own 100-per-parent cap, is
  // undocumented and unverified here (05-RESEARCH.md Open Question 1) —
  // counting everything makes the warning fire no later than it should
  // under either interpretation, never later, so the defensiveness is
  // harmless even if it turns out to be moot.
  const subIssueCountsByParent = new Map<number, number>();
  for (const node of remote.subIssues ?? []) {
    if (typeof node.parentIssueNumber !== 'number') continue;
    subIssueCountsByParent.set(node.parentIssueNumber, (subIssueCountsByParent.get(node.parentIssueNumber) ?? 0) + 1);
  }
  const subIssueCeilingWarnings: ReconciliationPlan['subIssueCeilingWarnings'] = [];
  for (const phase of [...desired.phases].sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))) {
    const issueCompletion = completions[issueKeyFor(phase.id)];
    if (!issueCompletion || issueCompletion.issueNumber === undefined) continue;
    const count = subIssueCountsByParent.get(issueCompletion.issueNumber);
    if (count === undefined || count < PLAN_SUB_ISSUE_WARN_THRESHOLD) continue;
    subIssueCeilingWarnings.push({ phaseId: phase.id, issueNumber: issueCompletion.issueNumber, count, limit: PLAN_SUB_ISSUE_LIMIT });
  }

  // Plan 07-04 Task 2 (D-06): one blocked entry per object whose existence
  // this run could not determine — reported by logical key. This function is
  // pure and never writes the map, so the object's completion is left
  // untouched by construction (SC2); the next run re-classifies cleanly.
  // `EXISTENCE_UNKNOWN` sits in `PER_ITEM_BLOCKED_REASONS`, so one unreadable
  // object costs only itself — every operation already computed above for a
  // cleanly classified object is unaffected by this loop.
  for (const verdict of existenceVerdicts ?? []) {
    if (verdict.verdict !== EXISTENCE_VERDICT.UNKNOWN) continue;
    blocked.push({ reason: OPERATION_REASON.EXISTENCE_UNKNOWN, detail: verdict.logicalKey });
  }

  return { operations, noops, blocked, uncertain: [], pendingIssueUpdates, orphans, pendingFieldChanges, subIssueCeilingWarnings, adoptions };
}

export = {
  planReconciliation,
  OPERATION_KIND,
  OPERATION_REASON,
  PER_ITEM_BLOCKED_REASONS,
  isRunFatalBlockedReason,
  issueKeyFor,
  planKeyFor,
  planIssueKeyFor,
  phaseIssueRestPath,
  PATH_SAFE_TARGET,
  buildCreateIssueOperation,
  buildCreatePlanIssueOperation,
  buildAddSubIssueOperation,
  buildPlanIssueStateOperation,
  PLAN_ISSUE_STATE,
  bodyArgvEntry,
  ADD_SUB_ISSUE_DOCUMENT,
  buildFieldValueOperations,
  buildPlanFieldValueOperations,
  documentForFieldType,
  UPDATE_FIELD_VALUE_TEXT_DOCUMENT,
  UPDATE_FIELD_VALUE_SINGLE_SELECT_DOCUMENT,
  UPDATE_FIELD_VALUE_NUMBER_DOCUMENT,
  PLAN_FIELD_VALUE_SPEC,
  PLAN_SUB_ISSUE_LIMIT,
  PLAN_SUB_ISSUE_WARN_THRESHOLD,
};
