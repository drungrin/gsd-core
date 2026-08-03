'use strict';
/** JSON-safe versioned DTO and concise renderer for read-only github-sync status. */

const STATUS_SCHEMA_VERSION = 1;
const UNAVAILABLE_MESSAGE = 'github-sync status is unavailable because GitHub could not be read. Retry shortly.';

// G-02-4: a local github_sync.target fault is a local configuration fault,
// not a GitHub outage — "Retry shortly" is actively wrong advice for it, and
// no field was ever named. Every entry below is a reviewed, whole fixed
// literal (D-07/SAFE-04): nothing from config or a caught error may ever be
// interpolated into one. An unrecognized or absent field falls back to
// `target` so the lookup stays total.
const TARGET_UNAVAILABLE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  config: 'github-sync status is unavailable because .planning/config.json could not be read or parsed. Fix that file, then re-run.',
  target: 'github-sync status is unavailable because github_sync.target in .planning/config.json is missing or does not declare exactly owner, repo, repository_number, and project_number. Declare all four, then re-run.',
  owner: 'github-sync status is unavailable because github_sync.target.owner in .planning/config.json is invalid. Set it to a non-empty string (the GitHub owner login), then re-run.',
  repo: 'github-sync status is unavailable because github_sync.target.repo in .planning/config.json is invalid. Set it to a non-empty string (the GitHub repository name), then re-run.',
  repository_number: 'github-sync status is unavailable because github_sync.target.repository_number in .planning/config.json is invalid. Set it to a positive whole number, then re-run.',
  project_number: 'github-sync status is unavailable because github_sync.target.project_number in .planning/config.json is invalid. Set it to a positive whole number, then re-run.',
});

interface StatusInput { available: boolean; reason: string; field?: string; }
/** Plan 05-07 (D-14): one phase's parent-issue sub-issue count at or over the warn threshold — never a mutation authority, only a reported fact. */
interface SubIssueCeilingWarning { phaseId: string; issueNumber: number; count: number; limit: number; }
interface ReconciliationPlan {
  operations: Array<{ kind: string; logicalKey: string }>;
  noops: Array<{ logicalKey: string }>;
  blocked: Array<{ reason: string; detail?: string }>;
  uncertain: Array<{ reason: string }>;
  /** Plan 04-04 Task 3: optional so a pre-04-04-shaped plan fixture still type-checks and renders as empty. */
  pendingIssueUpdates?: Array<{ logicalKey: string }>;
  orphans?: Array<{ logicalKey: string; issueNumber?: number }>;
  /** Plan 05-07: optional so a pre-05-07-shaped plan fixture still type-checks and renders as empty. */
  subIssueCeilingWarnings?: SubIssueCeilingWarning[];
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
  /** Plan 04-04 Task 3 (D-11): always present, empty when nothing applies — matches every other group. */
  orphans: Array<{ logicalKey: string; issueNumber?: number }>;
  /** Plan 04-04 Task 3: pending issue-content updates, by logical key only — `status` never reads the issue to learn more than the plan already named. */
  pendingIssueUpdates: string[];
  /** Plan 05-07 (D-14): always present, empty when nothing applies — matches every other group; never gates. */
  subIssueCeilingWarnings: SubIssueCeilingWarning[];
  limitations: string[];
}

function buildStatusV1(remote: StatusInput, plan: ReconciliationPlan | null): StatusV1 {
  if (!remote.available) {
    // G-02-4: a local github_sync.target fault is diagnosed distinctly from a
    // remote outage — typed blocker, no `uncertain` entry, no remote read
    // attempted. Every other reason (including one this module has never
    // seen) keeps the pre-existing remote-outage branch verbatim: it is the
    // catch-all for desired/map/remote/reconcile faults and cannot honestly
    // claim a target diagnosis (this task's prohibitions).
    if (remote.reason === 'target_unavailable') {
      const message = (remote.field !== undefined && TARGET_UNAVAILABLE_MESSAGES[remote.field]) || TARGET_UNAVAILABLE_MESSAGES.target;
      return {
        version: STATUS_SCHEMA_VERSION, available: false, message,
        creates: [], updates: [], noops: [],
        blocked: [remote.field === undefined ? { reason: remote.reason } : { reason: remote.reason, detail: remote.field }],
        uncertain: [],
        orphans: [], pendingIssueUpdates: [], subIssueCeilingWarnings: [],
        limitations: ['The local github_sync.target configuration is invalid; no remote read was attempted.'],
      };
    }
    return {
      version: STATUS_SCHEMA_VERSION, available: false, message: UNAVAILABLE_MESSAGE,
      creates: [], updates: [], noops: [], blocked: [], uncertain: [{ reason: 'remote_unavailable' }],
      orphans: [], pendingIssueUpdates: [], subIssueCeilingWarnings: [],
      limitations: ['Remote data is currently unavailable; no changes were made.'],
    };
  }
  const safePlan = plan ?? { operations: [], noops: [], blocked: [], uncertain: [], pendingIssueUpdates: [], orphans: [], subIssueCeilingWarnings: [] };
  return {
    version: STATUS_SCHEMA_VERSION, available: true,
    creates: safePlan.operations.filter((operation) => operation.kind === 'create').map((operation) => operation.logicalKey),
    updates: safePlan.operations.filter((operation) => operation.kind === 'update').map((operation) => operation.logicalKey),
    noops: safePlan.noops.map((operation) => operation.logicalKey),
    blocked: safePlan.blocked.map(({ reason, detail }) => detail === undefined ? { reason } : { reason, detail }),
    uncertain: safePlan.uncertain.map(({ reason }) => ({ reason })),
    orphans: (safePlan.orphans ?? []).map(({ logicalKey, issueNumber }) => (issueNumber === undefined ? { logicalKey } : { logicalKey, issueNumber })),
    pendingIssueUpdates: (safePlan.pendingIssueUpdates ?? []).map(({ logicalKey }) => logicalKey),
    subIssueCeilingWarnings: (safePlan.subIssueCeilingWarnings ?? []).map(({ phaseId, issueNumber, count, limit }) => ({ phaseId, issueNumber, count, limit })),
    limitations: [],
  };
}

/**
 * D-13/D-14: default (non-raw) human summary. Lists every planned create,
 * update, and no-op by its logical key, and every blocked/uncertain entry by
 * its typed reason (blocked entries append a safe `detail` in parentheses
 * when present) — the summary a developer can act on without reading source
 * or JSON. Plan 04-04 Task 3 (D-11) adds two more groups after the original
 * five: `orphans` (a phase's logical key, with its issue number in
 * parentheses when known) and `updates-pending` (a pending issue-content
 * update's logical key). Plan 05-07 (D-14) adds an eighth,
 * `sub-issue-ceiling-warnings` (a phase's id, with its count against the
 * limit in parentheses). All eight groups always render their count line,
 * even at zero.
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
  // Plan 04-04 Task 3 (D-11): an orphan renders as its logical key followed
  // by its issue number in parentheses when present — the same shape the
  // blocked group already uses for its detail.
  appendGroup('orphans', status.orphans.map(({ logicalKey, issueNumber }) => (issueNumber === undefined ? logicalKey : `${logicalKey} (${issueNumber})`)));
  appendGroup('updates-pending', status.pendingIssueUpdates);
  // Plan 05-07 (D-14): a warning renders as the phase's own identifier
  // followed by its count against the limit, in the same parenthesized-
  // detail shape the `orphans` group already uses.
  appendGroup('sub-issue-ceiling-warnings', status.subIssueCeilingWarnings.map(({ phaseId, count, limit }) => `${phaseId} (${count}/${limit})`));
  if (status.limitations.length > 0) {
    lines.push('limitations:');
    for (const limitation of status.limitations) lines.push(`  - ${limitation}`);
  }
  return lines.join('\n') + '\n';
}

export = { buildStatusV1, renderStatusV1, STATUS_SCHEMA_VERSION };
