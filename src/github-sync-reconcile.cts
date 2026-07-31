'use strict';
/** Pure, deterministic reconciliation plan for desired state and typed inputs. */

const OPERATION_KIND = Object.freeze({ CREATE: 'create', UPDATE: 'update' } as const);
const OPERATION_REASON = Object.freeze({
  MAP_BLOCKING: 'map_blocking',
  REMOTE_UNAVAILABLE: 'remote_unavailable',
  DESIRED_UNAVAILABLE: 'desired_unavailable',
} as const);

interface DesiredPhase { id: string; title: string; goal: string; }
interface DesiredState { available: boolean; reason: string; phases: DesiredPhase[]; }
interface RemoteItem { id?: unknown; content?: { number?: unknown } | null; }
interface RemoteSnapshot {
  available: boolean;
  reason: string;
  target?: { owner: string; repo: string; repositoryNumber: number; projectNumber: number };
  items?: RemoteItem[];
}
interface StrictMap { kind: 'absent' | 'valid' | 'blocking'; reason?: string; map?: { completions?: Record<string, { nodeId: string }> }; }

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
  blocked: Array<{ reason: typeof OPERATION_REASON.MAP_BLOCKING | typeof OPERATION_REASON.DESIRED_UNAVAILABLE; detail?: string }>;
  uncertain: Array<{ reason: typeof OPERATION_REASON.REMOTE_UNAVAILABLE }>;
}

function matchingRemotePhaseIds(remote: RemoteSnapshot): Set<string> {
  const ids = new Set<string>();
  for (const item of remote.items ?? []) {
    const number = item?.content?.number;
    if (typeof number === 'number' && Number.isSafeInteger(number) && number > 0) ids.add(String(number));
  }
  return ids;
}

function operationFor(phase: DesiredPhase, target: NonNullable<RemoteSnapshot['target']>): MutationOperation {
  const responsePayloadKey = 'addProjectV2Item' as const;
  const query = `mutation($projectId:ID!,$contentId:ID!){ rateLimit { cost remaining resetAt } ${responsePayloadKey}(input:{projectId:$projectId,contentId:$contentId}) { projectV2Item { id content { ... on Issue { number } } } } }`;
  return {
    kind: OPERATION_KIND.CREATE,
    logicalKey: `phase:${phase.id}`,
    args: ['api', 'graphql', '-f', `query=${query}`, '-F', `projectId=${target.projectNumber}`, '-F', `contentId=${phase.id}`],
    completionContext: { owner: target.owner, repo: target.repo, repositoryNumber: target.repositoryNumber },
    responsePayloadKey,
    contentCreation: true,
  };
}

function planReconciliation(desired: DesiredState, remote: RemoteSnapshot, strictMap: StrictMap): ReconciliationPlan {
  if (!desired.available) return { operations: [], noops: [], blocked: [{ reason: OPERATION_REASON.DESIRED_UNAVAILABLE, detail: desired.reason }], uncertain: [] };
  if (!remote.available) return { operations: [], noops: [], blocked: [], uncertain: [{ reason: OPERATION_REASON.REMOTE_UNAVAILABLE }] };
  if (strictMap.kind === 'blocking') return { operations: [], noops: [], blocked: [{ reason: OPERATION_REASON.MAP_BLOCKING, detail: strictMap.reason ?? 'invalid' }], uncertain: [] };
  if (!remote.target || !Number.isSafeInteger(remote.target.repositoryNumber) || remote.target.repositoryNumber <= 0) {
    return { operations: [], noops: [], blocked: [], uncertain: [{ reason: OPERATION_REASON.REMOTE_UNAVAILABLE }] };
  }

  const completions = strictMap.kind === 'valid' ? strictMap.map?.completions ?? {} : {};
  const remotePhaseIds = matchingRemotePhaseIds(remote);
  const operations: ReconciliationPlan['operations'] = [];
  const noops: ReconciliationPlan['noops'] = [];
  for (const phase of [...desired.phases].sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))) {
    const logicalKey = `phase:${phase.id}`;
    if (completions[logicalKey] || remotePhaseIds.has(String(Number(phase.id)))) noops.push({ logicalKey });
    else operations.push(operationFor(phase, remote.target));
  }
  return { operations, noops, blocked: [], uncertain: [] };
}

export = { planReconciliation, OPERATION_KIND, OPERATION_REASON };
