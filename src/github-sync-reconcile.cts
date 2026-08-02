'use strict';
/** Pure, deterministic reconciliation plan for desired state and typed inputs. */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import operationMod = require('./github-sync-operation.cjs');
import type { MutationOperation, ArgvEntry, CompletionContext } from './github-sync-operation.cts';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import bootstrapPlanMod = require('./github-sync-bootstrap-plan.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import issueBodyMod = require('./github-sync-issue-body.cjs');
import type { FieldValues, FieldName, ParsedFieldState } from './github-sync-issue-body.cts';

const { OPERATION_TRANSPORT, OPERATION_ACTION, ARGV_REF_PART } = operationMod;
const { BOOTSTRAP_LOGICAL_KEY, GSD_LABELS } = bootstrapPlanMod;
const { renderNewIssueBody, renderPhaseRegion, contentHash, renderFieldState, parseFieldState, changedFields } = issueBodyMod;

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
} as const);

/** The `gsd:phase` label's own name, as declared in `GSD_LABELS` (github-sync-bootstrap-plan.cts) — never re-spelled. */
const PHASE_LABEL_NAME = 'gsd:phase';

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
  /** Plan 04-04: optional so pre-04-02-shaped fixtures still type-check; `readDesiredState` always supplies it now. */
  requirements?: string[];
  /** Plan 04-04: optional for the same reason as `requirements`. */
  status?: string;
}
/** Mirrors `github-sync-desired.cts`'s `DesiredMilestone` shape — only the two fields this module needs. */
interface DesiredMilestone { version: string; archived: boolean; }
interface DesiredState { available: boolean; reason: string; phases: DesiredPhase[]; milestones?: DesiredMilestone[]; }
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
      | typeof OPERATION_REASON.REGION_DAMAGED;
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
      if (changed.length > 0) pendingFieldChanges.push({ logicalKey, changed });
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
    const desiredFieldValues = desiredFieldValuesFor(phase, logicalKey);

    operations.push(buildCreateIssueOperation(phase, issueKey, milestoneKey as string, restApiPath, context, { contentHash: desiredHash }));
    operations.push(operationFor(logicalKey, remote.target.projectNodeId, { from: issueKey }, remote.target, { fieldState: renderFieldState(desiredFieldValues) }));
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

export = { planReconciliation, OPERATION_KIND, OPERATION_REASON, issueKeyFor, phaseIssueRestPath, PATH_SAFE_TARGET, buildCreateIssueOperation };
