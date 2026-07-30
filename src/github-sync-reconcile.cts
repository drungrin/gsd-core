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
interface RemoteSnapshot { available: boolean; reason: string; }
interface StrictMap { kind: 'absent' | 'valid' | 'blocking'; reason?: string; map?: { completions?: Record<string, { nodeId: string }> }; }

interface ReconciliationPlan {
  operations: Array<{ kind: typeof OPERATION_KIND[keyof typeof OPERATION_KIND]; logicalKey: string }>;
  noops: Array<{ logicalKey: string }>;
  blocked: Array<{ reason: typeof OPERATION_REASON.MAP_BLOCKING | typeof OPERATION_REASON.DESIRED_UNAVAILABLE; detail?: string }>;
  uncertain: Array<{ reason: typeof OPERATION_REASON.REMOTE_UNAVAILABLE }>;
}

function planReconciliation(desired: DesiredState, remote: RemoteSnapshot, strictMap: StrictMap): ReconciliationPlan {
  if (!desired.available) return { operations: [], noops: [], blocked: [{ reason: OPERATION_REASON.DESIRED_UNAVAILABLE, detail: desired.reason }], uncertain: [] };
  if (!remote.available) return { operations: [], noops: [], blocked: [], uncertain: [{ reason: OPERATION_REASON.REMOTE_UNAVAILABLE }] };
  if (strictMap.kind === 'blocking') return { operations: [], noops: [], blocked: [{ reason: OPERATION_REASON.MAP_BLOCKING, detail: strictMap.reason ?? 'invalid' }], uncertain: [] };

  const completions = strictMap.kind === 'valid' ? strictMap.map?.completions ?? {} : {};
  const operations: ReconciliationPlan['operations'] = [];
  const noops: ReconciliationPlan['noops'] = [];
  for (const phase of [...desired.phases].sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))) {
    const logicalKey = `phase:${phase.id}`;
    if (completions[logicalKey]) noops.push({ logicalKey });
    else operations.push({ kind: OPERATION_KIND.CREATE, logicalKey });
  }
  return { operations, noops, blocked: [], uncertain: [] };
}

export = { planReconciliation, OPERATION_KIND, OPERATION_REASON };
