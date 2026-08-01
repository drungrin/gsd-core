'use strict';
/** Pure, deterministic reconciliation plan for desired state and typed inputs. */

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

interface MutationOperation {
  kind: typeof OPERATION_KIND[keyof typeof OPERATION_KIND];
  logicalKey: string;
  args: string[];
  completionContext: { owner: string; repo: string; repositoryNumber: number };
  responsePayloadKey: 'addProjectV2Item';
  contentCreation: boolean;
}

interface ReconciliationPlan {
  operations: MutationOperation[];
  noops: Array<{ logicalKey: string }>;
  blocked: Array<{ reason: typeof OPERATION_REASON.MAP_BLOCKING | typeof OPERATION_REASON.DESIRED_UNAVAILABLE | typeof OPERATION_REASON.IDENTITY_UNRESOLVABLE; detail?: string }>;
  uncertain: Array<{ reason: typeof OPERATION_REASON.REMOTE_UNAVAILABLE }>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function operationFor(logicalKey: string, projectNodeId: string, contentNodeId: string, target: NonNullable<RemoteSnapshot['target']>): MutationOperation {
  const responsePayloadKey = 'addProjectV2Item' as const;
  const query = `mutation($projectId:ID!,$contentId:ID!){ rateLimit { cost remaining resetAt } ${responsePayloadKey}(input:{projectId:$projectId,contentId:$contentId}) { projectV2Item { id content { ... on Issue { number } } } } }`;
  return {
    kind: OPERATION_KIND.CREATE,
    logicalKey,
    args: ['api', 'graphql', '-f', `query=${query}`, '-F', `projectId=${projectNodeId}`, '-F', `contentId=${contentNodeId}`],
    completionContext: { owner: target.owner, repo: target.repo, repositoryNumber: target.repositoryNumber },
    responsePayloadKey,
    contentCreation: true,
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
