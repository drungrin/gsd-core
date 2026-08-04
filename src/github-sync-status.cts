'use strict';
/** JSON-safe versioned DTO and concise renderer for read-only github-sync status. */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import operationMod = require('./github-sync-operation.cjs');
// Plan 07-06 Task 3 (D-03): both `github-sync-existence.cts` and this module
// are zero-I/O — importing the verdict catalog here keeps the three literal
// strings ('present'/'confirmed-absent'/'unknown') defined in exactly one
// place, never re-spelled.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import existenceMod = require('./github-sync-existence.cjs');

const { statusBucketForKind, STATUS_BUCKET } = operationMod;
const { EXISTENCE_VERDICT } = existenceMod;

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
  /**
   * CR-02 (05-REVIEW re-review): a plan whose only changed field is one
   * `buildPlanFieldValueOperations` deliberately skips (today, only a
   * cleared `wave:`, since GSD has no `clearProjectV2ItemFieldValue` call)
   * produces zero operations for that field and is not a content/state
   * no-op either, so it used to be invisible to every StatusV1 bucket —
   * contradicting SYNC-07's "every planned create, update, no-op, orphan,
   * and pending update is named" contract. Mirrors `pendingIssueUpdates`:
   * optional so a pre-CR-02-shaped plan fixture still type-checks and
   * renders as empty.
   */
  pendingFieldChanges?: Array<{ logicalKey: string }>;
  orphans?: Array<{ logicalKey: string; issueNumber?: number }>;
  /** Plan 05-07: optional so a pre-05-07-shaped plan fixture still type-checks and renders as empty. */
  subIssueCeilingWarnings?: SubIssueCeilingWarning[];
  /** Plan 07-05 Task 2 (D-13): optional so a pre-07-05-shaped plan fixture still type-checks and renders as empty. */
  adoptions?: Array<{ logicalKey: string; previousNodeId: string; resolvedNodeId: string }>;
  /** Plan 07-06 Task 1 (D-07): optional so a pre-07-06-shaped plan fixture still type-checks and renders as empty. */
  prune?: Array<{ logicalKey: string }>;
}

/** Plan 07-06 Task 2/3 (D-03): the existence classification and D-01's rebuild-scope preview — computed once by the router (the same `classifyExistence`/`runBootstrapTwoPass` calls `sync` makes, apply/map-write withheld) and handed here as already-typed data, never re-derived from a raw completions map. */
interface ExistenceSummaryLike {
  /** `classifyExistence`'s own return shape (`github-sync-existence.cjs`) — one entry per classified logical key. */
  verdicts?: Array<{ logicalKey: string; verdict: string }>;
  /** D-08/D-09: every completion currently carrying an absence marker, by logical key. */
  absences?: Array<{ logicalKey: string; count: number; firstSeenAt: string }>;
  /** D-01/D-02/D-03: the rebuild this run's classification would trigger — `triggered: false` (with every array empty) when nothing crossed the two-absence-plus-elapsed gate. */
  rebuildScope?: {
    triggered: boolean;
    triggeredKeys: string[];
    structureOperations: string[];
    optionsOperations: string[];
  };
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
  /** CR-02: pending field changes with zero operations (today, only a cleared `wave:`), by logical key only — always present, empty when nothing applies, matching every other group. */
  pendingFieldChanges: string[];
  /** Plan 05-07 (D-14): always present, empty when nothing applies — matches every other group; never gates. */
  subIssueCeilingWarnings: SubIssueCeilingWarning[];
  /** Plan 07-05 Task 2 (D-13): always present, empty when nothing applies — matches every other group. */
  adoptions: Array<{ logicalKey: string; previousNodeId: string; resolvedNodeId: string }>;
  /** Plan 07-06 Task 1 (D-07): always present, empty when nothing applies — matches every other group. Reports every prune this run would apply (or, from `sync`, has just applied); never gates. */
  prune: string[];
  /** Plan 07-06 Task 2 (D-06): counts by verdict, plus the logical keys of every object this run could not read — the same objects already named individually in `blocked` under `EXISTENCE_UNKNOWN`. */
  existence: { present: number; confirmedAbsent: number; unknown: number; unknownKeys: string[] };
  /** Plan 07-06 Task 2 (D-08/D-09): the per-object absence count and first-seen timestamp for every completion currently carrying one. */
  absences: Array<{ logicalKey: string; count: number; firstSeenAt: string }>;
  /** Plan 07-06 Task 2 (D-01/D-02/D-03): the rebuild this run's classification would trigger, and what both bootstrap passes would emit for it. */
  rebuildScope: { triggered: boolean; triggeredKeys: string[]; structureOperations: string[]; optionsOperations: string[] };
  limitations: string[];
}

const EMPTY_REBUILD_SCOPE: StatusV1['rebuildScope'] = { triggered: false, triggeredKeys: [], structureOperations: [], optionsOperations: [] };
const EMPTY_EXISTENCE: StatusV1['existence'] = { present: 0, confirmedAbsent: 0, unknown: 0, unknownKeys: [] };

function buildExistenceSummary(existenceSummary: ExistenceSummaryLike | null | undefined): { existence: StatusV1['existence']; absences: StatusV1['absences']; rebuildScope: StatusV1['rebuildScope'] } {
  const verdicts = existenceSummary?.verdicts ?? [];
  const existence = { present: 0, confirmedAbsent: 0, unknown: 0, unknownKeys: [] as string[] };
  for (const entry of verdicts) {
    if (entry.verdict === EXISTENCE_VERDICT.PRESENT) existence.present += 1;
    else if (entry.verdict === EXISTENCE_VERDICT.CONFIRMED_ABSENT) existence.confirmedAbsent += 1;
    else { existence.unknown += 1; existence.unknownKeys.push(entry.logicalKey); }
  }
  const absences = (existenceSummary?.absences ?? []).map(({ logicalKey, count, firstSeenAt }) => ({ logicalKey, count, firstSeenAt }));
  const scope = existenceSummary?.rebuildScope;
  const rebuildScope = scope
    ? { triggered: scope.triggered, triggeredKeys: [...scope.triggeredKeys], structureOperations: [...scope.structureOperations], optionsOperations: [...scope.optionsOperations] }
    : EMPTY_REBUILD_SCOPE;
  return { existence, absences, rebuildScope };
}

function buildStatusV1(remote: StatusInput, plan: ReconciliationPlan | null, existenceSummary?: ExistenceSummaryLike | null): StatusV1 {
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
        orphans: [], pendingIssueUpdates: [], pendingFieldChanges: [], subIssueCeilingWarnings: [],
        adoptions: [], prune: [], existence: EMPTY_EXISTENCE, absences: [], rebuildScope: EMPTY_REBUILD_SCOPE,
        limitations: ['The local github_sync.target configuration is invalid; no remote read was attempted.'],
      };
    }
    return {
      version: STATUS_SCHEMA_VERSION, available: false, message: UNAVAILABLE_MESSAGE,
      creates: [], updates: [], noops: [], blocked: [], uncertain: [{ reason: 'remote_unavailable' }],
      orphans: [], pendingIssueUpdates: [], pendingFieldChanges: [], subIssueCeilingWarnings: [],
      adoptions: [], prune: [], existence: EMPTY_EXISTENCE, absences: [], rebuildScope: EMPTY_REBUILD_SCOPE,
      limitations: ['Remote data is currently unavailable; no changes were made.'],
    };
  }
  const safePlan = plan ?? { operations: [], noops: [], blocked: [], uncertain: [], pendingIssueUpdates: [], pendingFieldChanges: [], orphans: [], subIssueCeilingWarnings: [], adoptions: [], prune: [] };
  const { existence, absences, rebuildScope } = buildExistenceSummary(existenceSummary);
  return {
    version: STATUS_SCHEMA_VERSION, available: true,
    // WINDOWS #8: the shared, exhaustively-tested catalog decides the
    // bucket — never a literal `operation.kind === 'create'` comparison,
    // which only ever matched the bind-to-project operation's kind and hid
    // every other real create/update kind from both arrays.
    creates: safePlan.operations.filter((operation) => statusBucketForKind(operation.kind) === STATUS_BUCKET.CREATES).map((operation) => operation.logicalKey),
    updates: safePlan.operations.filter((operation) => statusBucketForKind(operation.kind) === STATUS_BUCKET.UPDATES).map((operation) => operation.logicalKey),
    noops: safePlan.noops.map((operation) => operation.logicalKey),
    blocked: safePlan.blocked.map(({ reason, detail }) => detail === undefined ? { reason } : { reason, detail }),
    uncertain: safePlan.uncertain.map(({ reason }) => ({ reason })),
    orphans: (safePlan.orphans ?? []).map(({ logicalKey, issueNumber }) => (issueNumber === undefined ? { logicalKey } : { logicalKey, issueNumber })),
    pendingIssueUpdates: (safePlan.pendingIssueUpdates ?? []).map(({ logicalKey }) => logicalKey),
    pendingFieldChanges: (safePlan.pendingFieldChanges ?? []).map(({ logicalKey }) => logicalKey),
    subIssueCeilingWarnings: (safePlan.subIssueCeilingWarnings ?? []).map(({ phaseId, issueNumber, count, limit }) => ({ phaseId, issueNumber, count, limit })),
    adoptions: (safePlan.adoptions ?? []).map(({ logicalKey, previousNodeId, resolvedNodeId }) => ({ logicalKey, previousNodeId, resolvedNodeId })),
    prune: (safePlan.prune ?? []).map(({ logicalKey }) => logicalKey),
    existence, absences, rebuildScope,
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
 * limit in parentheses). CR-02 (05-REVIEW re-review) adds a ninth,
 * `field-changes-pending` (a plan's logical key whose only changed field is
 * one `buildPlanFieldValueOperations` deliberately skips — e.g. a cleared
 * `wave:` — so it would otherwise never appear in any group). All nine
 * groups always render their count line, even at zero.
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
  // CR-02 (05-REVIEW re-review): the same shape as `updates-pending`, a
  // plan's own logical key — this group exists so a field change with zero
  // dispatched operations (today, only a cleared `wave:`) is still named
  // somewhere in the report instead of vanishing from every bucket.
  appendGroup('field-changes-pending', status.pendingFieldChanges);
  // Plan 05-07 (D-14): a warning renders as the phase's own identifier
  // followed by its count against the limit, in the same parenthesized-
  // detail shape the `orphans` group already uses.
  appendGroup('sub-issue-ceiling-warnings', status.subIssueCeilingWarnings.map(({ phaseId, count, limit }) => `${phaseId} (${count}/${limit})`));
  // Plan 07-05 Task 2 (D-13): an adoption renders as its logical key and both
  // node ids, so a developer can see exactly which stale id was replaced.
  appendGroup('adoptions', status.adoptions.map(({ logicalKey, previousNodeId, resolvedNodeId }) => `${logicalKey}: ${previousNodeId} -> ${resolvedNodeId}`));
  // Plan 07-06 Task 1 (D-07): a prune renders as the removed key alone — the
  // single destructive act anywhere in this phase, named explicitly (T-07-20).
  appendGroup('prune', status.prune);
  // Plan 07-06 Task 2/3 (D-06): counts by verdict on the header line, then
  // the logical key of every object this run could not read — the human
  // branch names the object, not only the reason (matching this task's own
  // must-have).
  lines.push(`existence: present=${status.existence.present} confirmed-absent=${status.existence.confirmedAbsent} unknown=${status.existence.unknown}`);
  for (const key of status.existence.unknownKeys) lines.push(`  - ${key}`);
  // Plan 07-06 Task 2/3 (D-08/D-09): one line per object currently carrying
  // an absence marker, naming its count and its first-seen instant.
  appendGroup('absences', status.absences.map(({ logicalKey, count, firstSeenAt }) => `${logicalKey} (count=${count}, since=${firstSeenAt})`));
  // Plan 07-06 Task 2/3 (D-01/D-02/D-03): the rebuild-scope preview — the
  // keys that triggered it, then every operation both bootstrap passes would
  // emit for it, each labeled by which pass it belongs to.
  lines.push(`rebuild-scope: triggered=${status.rebuildScope.triggered}`);
  for (const key of status.rebuildScope.triggeredKeys) lines.push(`  - trigger: ${key}`);
  for (const key of status.rebuildScope.structureOperations) lines.push(`  - structure: ${key}`);
  for (const key of status.rebuildScope.optionsOperations) lines.push(`  - options: ${key}`);
  if (status.limitations.length > 0) {
    lines.push('limitations:');
    for (const limitation of status.limitations) lines.push(`  - ${limitation}`);
  }
  return lines.join('\n') + '\n';
}

export = { buildStatusV1, renderStatusV1, STATUS_SCHEMA_VERSION };
