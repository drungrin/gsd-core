'use strict';
/** Pure, deterministic reconciliation plan for desired state and typed inputs. */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import operationMod = require('./github-sync-operation.cjs');
import type { MutationOperation, ArgvEntry, CompletionContext } from './github-sync-operation.cts';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import bootstrapPlanMod = require('./github-sync-bootstrap-plan.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import issueBodyMod = require('./github-sync-issue-body.cjs');

const { OPERATION_TRANSPORT, OPERATION_ACTION, ARGV_REF_PART } = operationMod;
const { BOOTSTRAP_LOGICAL_KEY, GSD_LABELS } = bootstrapPlanMod;
const { renderNewIssueBody } = issueBodyMod;

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

interface DesiredPhase { id: string; title: string; goal: string; }
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
interface StrictMap { kind: 'absent' | 'valid' | 'blocking'; reason?: string; map?: { completions?: Record<string, { nodeId: string; issueNumber?: number }> }; }

interface ReconciliationPlan {
  operations: MutationOperation[];
  noops: Array<{ logicalKey: string }>;
  blocked: Array<{
    reason: typeof OPERATION_REASON.MAP_BLOCKING
      | typeof OPERATION_REASON.DESIRED_UNAVAILABLE
      | typeof OPERATION_REASON.IDENTITY_UNRESOLVABLE
      | typeof OPERATION_REASON.MILESTONE_UNRESOLVED
      | typeof OPERATION_REASON.UNSAFE_TARGET;
    detail?: string;
  }>;
  uncertain: Array<{ reason: typeof OPERATION_REASON.REMOTE_UNAVAILABLE }>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** `issue:phase:<id>` — the phase issue's own identity, distinct from `phase:<id>` (its project item, per the assumption-delta decision promoting the issue to a first-class mapped object). */
function issueKeyFor(id: string): string {
  return `issue:phase:${id}`;
}

/** The single current (non-archived) milestone's version, or `null` when none is declared. */
function currentMilestoneVersion(milestones: DesiredMilestone[] | undefined): string | null {
  const found = (milestones ?? []).find((milestone) => !milestone.archived);
  return found ? found.version : null;
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
 */
function operationFor(
  logicalKey: string,
  projectNodeId: string,
  contentId: string | { from: string },
  target: NonNullable<RemoteSnapshot['target']>,
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
 */
function buildCreateIssueOperation(
  phase: DesiredPhase,
  issueKey: string,
  milestoneKey: string,
  restApiPath: string,
  context: CompletionContext,
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
    captures: [{ kind: 'node', logicalKey: issueKey, nodeIdPath: 'node_id', numberPath: 'number' }],
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
 * Per-phase decision order (plan 04-01):
 *
 * 1. Already bound on the project board (`phase:<id>` completion resolves
 *    against a live item) → no-op, unchanged from Phase 2.
 * 2. An `issue:phase:<id>` completion exists — GSD created this issue on an
 *    earlier run — → bind it to the project via a literal content id, no
 *    create.
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
 *    own capture within this same plan.
 */
function planReconciliation(desired: DesiredState, remote: RemoteSnapshot, strictMap: StrictMap): ReconciliationPlan {
  if (!desired.available) return { operations: [], noops: [], blocked: [{ reason: OPERATION_REASON.DESIRED_UNAVAILABLE, detail: desired.reason }], uncertain: [] };
  if (!remote.available) return { operations: [], noops: [], blocked: [], uncertain: [{ reason: OPERATION_REASON.REMOTE_UNAVAILABLE }] };
  if (strictMap.kind === 'blocking') return { operations: [], noops: [], blocked: [{ reason: OPERATION_REASON.MAP_BLOCKING, detail: strictMap.reason ?? 'invalid' }], uncertain: [] };
  if (
    !remote.target
    || !Number.isSafeInteger(remote.target.repositoryNumber)
    || remote.target.repositoryNumber <= 0
    || !isNonEmptyString(remote.target.projectNodeId)
  ) {
    return { operations: [], noops: [], blocked: [], uncertain: [{ reason: OPERATION_REASON.REMOTE_UNAVAILABLE }] };
  }
  if (!PATH_SAFE_TARGET.test(remote.target.owner) || !PATH_SAFE_TARGET.test(remote.target.repo)) {
    return { operations: [], noops: [], blocked: [{ reason: OPERATION_REASON.UNSAFE_TARGET }], uncertain: [] };
  }

  const completions = strictMap.kind === 'valid' ? strictMap.map?.completions ?? {} : {};
  const context: CompletionContext = { owner: remote.target.owner, repo: remote.target.repo, repositoryNumber: remote.target.repositoryNumber };
  const milestoneVersion = currentMilestoneVersion(desired.milestones);
  const milestoneKey = milestoneVersion !== null ? BOOTSTRAP_LOGICAL_KEY.milestone(milestoneVersion) : null;

  const operations: ReconciliationPlan['operations'] = [];
  const noops: ReconciliationPlan['noops'] = [];
  const blocked: ReconciliationPlan['blocked'] = [];
  for (const phase of [...desired.phases].sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))) {
    const logicalKey = `phase:${phase.id}`;
    const completion = completions[logicalKey];
    if (bindingOnBoard(completion, remote)) {
      noops.push({ logicalKey });
      continue;
    }

    const issueKey = issueKeyFor(phase.id);
    const issueCompletion = completions[issueKey];
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

    const milestoneCompletion = milestoneKey ? completions[milestoneKey] : undefined;
    if (!milestoneCompletion) {
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

    operations.push(buildCreateIssueOperation(phase, issueKey, milestoneKey as string, restApiPath, context));
    operations.push(operationFor(logicalKey, remote.target.projectNodeId, { from: issueKey }, remote.target));
  }
  return { operations, noops, blocked, uncertain: [] };
}

export = { planReconciliation, OPERATION_KIND, OPERATION_REASON, issueKeyFor, phaseIssueRestPath, PATH_SAFE_TARGET, buildCreateIssueOperation };
