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

/**
 * D-13/D-14: default (non-raw) human summary. Lists every planned create,
 * update, and no-op by its logical key, and every blocked/uncertain entry by
 * its typed reason (blocked entries append a safe `detail` in parentheses
 * when present) — the summary a developer can act on without reading source
 * or JSON. All five groups always render their count line, even at zero.
 *
 * Kept pure and total: reads only `status` fields, never the filesystem,
 * config, or a caught error (SAFE-04) — the raw branch stays the first
 * statement so the machine surface (D-15) cannot be affected by the human
 * surface growing.
 */
function renderStatusV1(status: StatusV1, raw: boolean): string {
  if (raw) return JSON.stringify(status);
  if (!status.available) return `${status.message}\n`;
  const lines: string[] = ['github-sync status'];
  const appendGroup = (label: string, members: string[]): void => {
    lines.push(`${label}: ${members.length}`);
    for (const member of members) lines.push(`  - ${member}`);
  };
  appendGroup('creates', status.creates);
  appendGroup('updates', status.updates);
  appendGroup('no-ops', status.noops);
  appendGroup('blocked', status.blocked.map(({ reason, detail }) => (detail === undefined ? reason : `${reason} (${detail})`)));
  appendGroup('uncertain', status.uncertain.map(({ reason }) => reason));
  if (status.limitations.length > 0) {
    lines.push('limitations:');
    for (const limitation of status.limitations) lines.push(`  - ${limitation}`);
  }
  return lines.join('\n') + '\n';
}

export = { buildStatusV1, renderStatusV1, STATUS_SCHEMA_VERSION };
