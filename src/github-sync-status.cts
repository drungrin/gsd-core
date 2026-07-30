'use strict';
/** JSON-safe versioned DTO and concise renderer for read-only github-sync status. */

const STATUS_SCHEMA_VERSION = 1;
const UNAVAILABLE_MESSAGE = 'github-sync status is unavailable because GitHub could not be read. Retry shortly.';

interface StatusInput { available: boolean; reason: string; }
interface ReconciliationPlan {
  operations: Array<{ kind: string; logicalKey: string }>;
  noops: Array<{ logicalKey: string }>;
  blocked: Array<{ reason: string; detail?: string }>;
  uncertain: Array<{ reason: string }>;
}

interface StatusV1 {
  version: number;
  available: boolean;
  message?: string;
  creates: string[];
  updates: string[];
  noops: string[];
  blocked: Array<{ reason: string; detail?: string }>;
  uncertain: Array<{ reason: string }>;
  limitations: string[];
}

function buildStatusV1(remote: StatusInput, plan: ReconciliationPlan | null): StatusV1 {
  if (!remote.available) {
    return {
      version: STATUS_SCHEMA_VERSION, available: false, message: UNAVAILABLE_MESSAGE,
      creates: [], updates: [], noops: [], blocked: [], uncertain: [{ reason: 'remote_unavailable' }],
      limitations: ['Remote data is currently unavailable; no changes were made.'],
    };
  }
  const safePlan = plan ?? { operations: [], noops: [], blocked: [], uncertain: [] };
  return {
    version: STATUS_SCHEMA_VERSION, available: true,
    creates: safePlan.operations.filter((operation) => operation.kind === 'create').map((operation) => operation.logicalKey),
    updates: safePlan.operations.filter((operation) => operation.kind === 'update').map((operation) => operation.logicalKey),
    noops: safePlan.noops.map((operation) => operation.logicalKey),
    blocked: safePlan.blocked.map(({ reason, detail }) => detail === undefined ? { reason } : { reason, detail }),
    uncertain: safePlan.uncertain.map(({ reason }) => ({ reason })),
    limitations: [],
  };
}

function renderStatusV1(status: StatusV1, raw: boolean): string {
  if (raw) return JSON.stringify(status);
  if (!status.available) return `${status.message}\n`;
  return [
    'github-sync status',
    `creates: ${status.creates.length}`, `updates: ${status.updates.length}`, `no-ops: ${status.noops.length}`,
    `blocked: ${status.blocked.length}`, `uncertain: ${status.uncertain.length}`,
  ].join('\n') + '\n';
}

export = { buildStatusV1, renderStatusV1, STATUS_SCHEMA_VERSION };
