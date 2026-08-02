'use strict';
/** Pure, deterministic reconciliation plan for desired state and typed inputs. */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import operationMod = require('./github-sync-operation.cjs');
import type { MutationOperation } from './github-sync-operation.cts';

const { OPERATION_TRANSPORT, OPERATION_ACTION } = operationMod;

const OPERATION_KIND = Object.freeze({ CREATE: 'create', UPDATE: 'update' } as const);
const OPERATION_REASON = Object.freeze({
  MAP_BLOCKING: 'map_blocking',
  REMOTE_UNAVAILABLE: 'remote_unavailable',
  DESIRED_UNAVAILABLE: 'desired_unavailable',
  IDENTITY_UNRESOLVABLE: 'identity_unresolvable',
} as const);

interface DesiredPhase { id: string; title: string; goal: string; }
interface DesiredState { available: boolean; reason: string; phases: DesiredPhase[]; }
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
  blocked: Array<{ reason: typeof OPERATION_REASON.MAP_BLOCKING | typeof OPERATION_REASON.DESIRED_UNAVAILABLE | typeof OPERATION_REASON.IDENTITY_UNRESOLVABLE; detail?: string }>;
  uncertain: Array<{ reason: typeof OPERATION_REASON.REMOTE_UNAVAILABLE }>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
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
 */
function operationFor(logicalKey: string, projectNodeId: string, contentNodeId: string, target: NonNullable<RemoteSnapshot['target']>): MutationOperation {
  const query = 'mutation($projectId:ID!,$contentId:ID!) { # github-sync:addProjectV2ItemById\n' +
    'addProjectV2ItemById(input:{projectId:$projectId,contentId:$contentId}) { item { id content { ... on Issue { number } } } } }';
  return {
    kind: OPERATION_KIND.CREATE,
    logicalKey,
    args: ['api', 'graphql', '-f', `query=${query}`, '-f', `projectId=${projectNodeId}`, '-f', `contentId=${contentNodeId}`],
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

  const completions = strictMap.kind === 'valid' ? strictMap.map?.completions ?? {} : {};
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

    const issueNodeId = resolvedIssueNodeId(remote.issueNodeIds, completion?.issueNumber);
    if (issueNodeId) {
      operations.push(operationFor(logicalKey, remote.target.projectNodeId, issueNodeId, remote.target));
      continue;
    }

    blocked.push({ reason: OPERATION_REASON.IDENTITY_UNRESOLVABLE, detail: logicalKey });
  }
  return { operations, noops, blocked, uncertain: [] };
}

export = { planReconciliation, OPERATION_KIND, OPERATION_REASON };
