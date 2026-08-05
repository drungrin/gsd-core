'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildStatusV1, renderStatusV1, STATUS_SCHEMA_VERSION } = require('../gsd-core/bin/lib/github-sync-status.cjs');
const { SYNC_TARGET_FIELD } = require('../gsd-core/bin/lib/github-sync-target.cjs');
const operationMod = require('../gsd-core/bin/lib/github-sync-operation.cjs');
const { planReconciliation, issueKeyFor, planKeyFor, planIssueKeyFor } = require('../gsd-core/bin/lib/github-sync-reconcile.cjs');
const { BOOTSTRAP_LOGICAL_KEY } = require('../gsd-core/bin/lib/github-sync-bootstrap-plan.cjs');
const { renderPlanRegion, contentHash, renderFieldState, PLAN_FIELD_NAMES, FENCE_BEGIN, FENCE_END } = require('../gsd-core/bin/lib/github-sync-issue-body.cjs');
const { prepareIssueUpdates } = require('../gsd-core/bin/lib/github-sync-issue-update.cjs');

test('buildStatusV1 groups a complete reconciliation plan into the documented compact DTO', () => {
  const result = buildStatusV1({ available: true, reason: 'ok' }, {
    // WINDOWS #8: 'create' and 'update-field-value' are real
    // MutationOperation.kind values (the bind-to-project kind, and a real
    // field-value write) — not the old fixture's synthetic 'create'/'update'
    // literals, which no producer has ever emitted for the latter.
    operations: [{ kind: 'create', logicalKey: 'phase:02' }, { kind: 'update-field-value', logicalKey: 'phase:01' }],
    noops: [{ logicalKey: 'phase:00' }],
    blocked: [{ reason: 'map_blocking', detail: 'repository_mismatch' }],
    uncertain: [{ reason: 'remote_unavailable' }],
    orphans: [{ logicalKey: 'phase:09', issueNumber: 77 }],
    pendingIssueUpdates: [{ logicalKey: 'phase:03' }],
    pendingFieldChanges: [{ logicalKey: 'plan:04-01' }],
    subIssueCeilingWarnings: [{ phaseId: '05', issueNumber: 900, count: 91, limit: 100 }],
  });

  assert.deepEqual(result, {
    version: STATUS_SCHEMA_VERSION,
    available: true,
    creates: ['phase:02'], updates: ['phase:01'], noops: ['phase:00'],
    blocked: [{ reason: 'map_blocking', detail: 'repository_mismatch' }],
    uncertain: [{ reason: 'remote_unavailable' }],
    orphans: [{ logicalKey: 'phase:09', issueNumber: 77 }],
    pendingIssueUpdates: ['phase:03'],
    pendingFieldChanges: ['plan:04-01'],
    subIssueCeilingWarnings: [{ phaseId: '05', issueNumber: 900, count: 91, limit: 100 }],
    // Plan 07-05/07-06/07-12: always present, empty on a pre-07-05/07-06/07-12-shaped plan fixture.
    adoptions: [], prune: [], contentDrift: [],
    existence: { present: 0, confirmedAbsent: 0, unknown: 0, unknownKeys: [] },
    absences: [],
    rebuildScope: { triggered: false, triggeredKeys: [], structureOperations: [], optionsOperations: [] },
    limitations: [],
  });
  assert.equal(JSON.parse(renderStatusV1(result, true)).version, 1);
});

test('buildStatusV1 derives orphans/pendingIssueUpdates/pendingFieldChanges/subIssueCeilingWarnings from the plan with an empty default when the plan omits them (pre-04-04/pre-05-07/pre-CR-02-shaped fixture)', () => {
  const result = buildStatusV1({ available: true, reason: 'ok' }, {
    operations: [], noops: [], blocked: [], uncertain: [],
  });
  assert.deepEqual(result.orphans, []);
  assert.deepEqual(result.pendingIssueUpdates, []);
  assert.deepEqual(result.pendingFieldChanges, []);
  assert.deepEqual(result.subIssueCeilingWarnings, []);
});

test('buildStatusV1 on a plan carrying two sub-issue-ceiling warnings returns a DTO whose warnings array has two structured entries', () => {
  const result = buildStatusV1({ available: true, reason: 'ok' }, {
    operations: [], noops: [], blocked: [], uncertain: [],
    subIssueCeilingWarnings: [
      { phaseId: '05', issueNumber: 900, count: 91, limit: 100 },
      { phaseId: '06', issueNumber: 901, count: 137, limit: 100 },
    ],
  });
  assert.deepEqual(result.subIssueCeilingWarnings, [
    { phaseId: '05', issueNumber: 900, count: 91, limit: 100 },
    { phaseId: '06', issueNumber: 901, count: 137, limit: 100 },
  ]);
});

test('buildStatusV1 produces an actionable fixed unavailable state without raw transport detail', () => {
  const result = buildStatusV1({ available: false, reason: 'remote_unavailable', stderr: 'secret transport output' }, null);
  assert.deepEqual(result, {
    version: 1,
    available: false,
    message: 'github-sync status is unavailable because GitHub could not be read. Retry shortly.',
    creates: [], updates: [], noops: [], blocked: [], uncertain: [{ reason: 'remote_unavailable' }],
    orphans: [], pendingIssueUpdates: [], pendingFieldChanges: [], subIssueCeilingWarnings: [],
    adoptions: [], prune: [], contentDrift: [],
    existence: { present: 0, confirmedAbsent: 0, unknown: 0, unknownKeys: [] },
    absences: [],
    rebuildScope: { triggered: false, triggeredKeys: [], structureOperations: [], optionsOperations: [] },
    limitations: ['Remote data is currently unavailable; no changes were made.'],
  });
  assert.doesNotMatch(JSON.stringify(result), /secret transport output/);
});

test('buildStatusV1 returns an empty subIssueCeilingWarnings array on both unavailable branches (target fault and remote outage)', () => {
  const targetFault = buildStatusV1({ available: false, reason: 'target_unavailable', field: 'owner' }, null);
  const remoteOutage = buildStatusV1({ available: false, reason: 'remote_unavailable' }, null);
  assert.deepEqual(targetFault.subIssueCeilingWarnings, []);
  assert.deepEqual(remoteOutage.subIssueCeilingWarnings, []);
});

test('status schema documentation pins every exported DTO field', () => {
  const documentation = fs.readFileSync(path.join(__dirname, '..', 'docs', 'github-sync-status-schema-v1.md'), 'utf8');
  for (const field of ['version', 'available', 'creates', 'updates', 'noops', 'blocked', 'uncertain', 'orphans', 'pendingIssueUpdates', 'pendingFieldChanges', 'subIssueCeilingWarnings', 'limitations', 'message']) {
    assert.match(documentation, new RegExp('`' + field + '`'));
  }
});

// ─── G-02-2 (Task 2): D-13/D-14 grouped, actionable human summary ───────────
//
// The renderer previously emitted counts only ('creates: N'); D-13 requires
// the default output to list what would actually change, and D-14 requires
// all five groups to always appear (even at zero) plus any limitations.

test('renderStatusV1 lists creates, updates, no-ops, blocked (with detail), uncertain, orphans, updates-pending, field-changes-pending, and sub-issue-ceiling-warnings by name, plus limitations (D-13/D-14)', () => {
  const dto = {
    version: 1, available: true,
    creates: ['phase:02'], updates: ['phase:01'], noops: ['phase:00'],
    blocked: [{ reason: 'map_blocking', detail: 'repository_mismatch' }],
    uncertain: [{ reason: 'remote_unavailable' }],
    orphans: [{ logicalKey: 'phase:09', issueNumber: 77 }],
    pendingIssueUpdates: ['phase:03'],
    pendingFieldChanges: ['plan:04-01'],
    subIssueCeilingWarnings: [{ phaseId: '05', issueNumber: 900, count: 91, limit: 100 }],
    adoptions: [{ logicalKey: 'issue:phase:11', previousNodeId: 'ISSUE_OLD', resolvedNodeId: 'ISSUE_NEW' }],
    prune: ['plan:09-09'],
    contentDrift: [{ logicalKey: 'issue:phase:12', previousOwner: 'octo', previousRepo: 'example', previousIssueNumber: 5, currentOwner: 'octo', currentRepo: 'moved-example', currentIssueNumber: 5 }],
    existence: { present: 3, confirmedAbsent: 1, unknown: 1, unknownKeys: ['field:gsd-id'] },
    absences: [{ logicalKey: 'plan:09-09', count: 2, firstSeenAt: '2026-08-01T00:00:00.000Z' }],
    rebuildScope: { triggered: true, triggeredKeys: ['project'], structureOperations: ['project'], optionsOperations: ['option:status:todo'] },
    limitations: ['Remote data is currently unavailable; no changes were made.'],
  };
  const out = renderStatusV1(dto, false);
  assert.equal(out, [
    'github-sync status',
    'creates: 1',
    '  - phase:02',
    'updates: 1',
    '  - phase:01',
    'no-ops: 1',
    '  - phase:00',
    'blocked: 1',
    '  - map_blocking (repository_mismatch)',
    'uncertain: 1',
    '  - remote_unavailable',
    'orphans: 1',
    '  - phase:09 (77)',
    'updates-pending: 1',
    '  - phase:03',
    'field-changes-pending: 1',
    '  - plan:04-01',
    'sub-issue-ceiling-warnings: 1',
    '  - 05 (91/100)',
    'adoptions: 1',
    '  - issue:phase:11: ISSUE_OLD -> ISSUE_NEW',
    'prune: 1',
    '  - plan:09-09',
    'content-drift: 1',
    '  - issue:phase:12: octo/example#5 -> octo/moved-example#5 (cross-repository, map unchanged)',
    'existence: present=3 confirmed-absent=1 unknown=1',
    '  - field:gsd-id',
    'absences: 1',
    '  - plan:09-09 (count=2, since=2026-08-01T00:00:00.000Z)',
    'rebuild-scope: triggered=true',
    '  - trigger: project',
    '  - structure: project',
    '  - options: option:status:todo',
    'limitations:',
    '  - Remote data is currently unavailable; no changes were made.',
    '',
  ].join('\n'));
});

test('renderStatusV1 renders a blocked entry without a detail as the bare reason (no empty parentheses), and an orphan with no known issue number as the bare logical key', () => {
  const dto = {
    version: 1, available: true,
    creates: [], updates: [], noops: [],
    blocked: [{ reason: 'sync_map_blocking' }],
    uncertain: [],
    orphans: [{ logicalKey: 'phase:11' }],
    pendingIssueUpdates: [],
    pendingFieldChanges: [],
    subIssueCeilingWarnings: [],
    adoptions: [], prune: [], contentDrift: [],
    existence: { present: 0, confirmedAbsent: 0, unknown: 0, unknownKeys: [] },
    absences: [],
    rebuildScope: { triggered: false, triggeredKeys: [], structureOperations: [], optionsOperations: [] },
    limitations: [],
  };
  const out = renderStatusV1(dto, false);
  assert.match(out, /blocked: 1\n {2}- sync_map_blocking\n/);
  assert.match(out, /orphans: 1\n {2}- phase:11\n/);
  assert.doesNotMatch(out, /\(/);
});

test('renderStatusV1 still shows all group lines at zero when every group is empty, with no limitations line (D-14) — including field-changes-pending, sub-issue-ceiling-warnings, adoptions, prune, existence, absences, and rebuild-scope (07-06)', () => {
  const dto = {
    version: 1, available: true,
    creates: [], updates: [], noops: [], blocked: [], uncertain: [],
    orphans: [], pendingIssueUpdates: [], pendingFieldChanges: [], subIssueCeilingWarnings: [],
    adoptions: [], prune: [], contentDrift: [],
    existence: { present: 0, confirmedAbsent: 0, unknown: 0, unknownKeys: [] },
    absences: [],
    rebuildScope: { triggered: false, triggeredKeys: [], structureOperations: [], optionsOperations: [] },
    limitations: [],
  };
  const out = renderStatusV1(dto, false);
  assert.equal(out, [
    'github-sync status',
    'creates: 0',
    'updates: 0',
    'no-ops: 0',
    'blocked: 0',
    'uncertain: 0',
    'orphans: 0',
    'updates-pending: 0',
    'field-changes-pending: 0',
    'sub-issue-ceiling-warnings: 0',
    'adoptions: 0',
    'prune: 0',
    'content-drift: 0',
    'existence: present=0 confirmed-absent=0 unknown=0',
    'absences: 0',
    'rebuild-scope: triggered=false',
    '',
  ].join('\n'));
  assert.doesNotMatch(out, /limitations:/);
});

test('renderStatusV1 for an unavailable DTO stays the fixed message followed by a newline, unaffected by the human-summary growth', () => {
  const dto = buildStatusV1({ available: false, reason: 'remote_unavailable' }, null);
  assert.equal(renderStatusV1(dto, false), `${dto.message}\n`);
});

test('renderStatusV1(dto, true) stays exactly JSON.stringify(dto) regardless of the human renderer growing (D-15)', () => {
  const dto = buildStatusV1({ available: true, reason: 'ok' }, {
    operations: [{ kind: 'create', logicalKey: 'phase:09' }],
    noops: [], blocked: [{ reason: 'map_blocking' }], uncertain: [],
  });
  assert.equal(renderStatusV1(dto, true), JSON.stringify(dto));
});

test('renderStatusV1(dto, true) stays exactly JSON.stringify(dto) with sub-issue-ceiling warnings present, and the raw branch stays the function\'s first statement', () => {
  const dto = buildStatusV1({ available: true, reason: 'ok' }, {
    operations: [], noops: [], blocked: [], uncertain: [],
    subIssueCeilingWarnings: [{ phaseId: '05', issueNumber: 900, count: 91, limit: 100 }],
  });
  assert.equal(renderStatusV1(dto, true), JSON.stringify(dto));
  const source = renderStatusV1.toString();
  const body = source.slice(source.indexOf('{') + 1);
  const firstStatement = body.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
  assert.match(firstStatement, /^if\s*\(raw\)/, 'the raw branch must stay the function\'s first statement');
});

// ─── G-02-4 (Task 2): the frozen message catalog for every target field ─────
//
// A local github_sync.target fault must never read as a GitHub outage. Every
// entry below is a whole fixed literal (D-07/SAFE-04) naming the field with
// the full dotted path `github_sync.target.<field>` (except `config`, which
// names the file itself, and `target`, which names the missing/malformed
// declaration as a whole) plus a re-run instruction.

const EXPECTED_TARGET_MESSAGES = {
  config: 'github-sync status is unavailable because .planning/config.json could not be read or parsed. Fix that file, then re-run.',
  target: 'github-sync status is unavailable because github_sync.target in .planning/config.json is missing or does not declare exactly owner, repo, repository_number, and project_number. Declare all four, then re-run.',
  owner: 'github-sync status is unavailable because github_sync.target.owner in .planning/config.json is invalid. Set it to a non-empty string (the GitHub owner login), then re-run.',
  repo: 'github-sync status is unavailable because github_sync.target.repo in .planning/config.json is invalid. Set it to a non-empty string (the GitHub repository name), then re-run.',
  repository_number: 'github-sync status is unavailable because github_sync.target.repository_number in .planning/config.json is invalid. Set it to a positive whole number, then re-run.',
  project_number: 'github-sync status is unavailable because github_sync.target.project_number in .planning/config.json is invalid. Set it to a positive whole number, then re-run.',
};

test('buildStatusV1 reports a typed target_unavailable blocker with a field-specific fixed message for every catalog entry', () => {
  const remoteUnavailableKeys = Object.keys(buildStatusV1({ available: false, reason: 'remote_unavailable' }, null)).sort();
  for (const field of Object.values(SYNC_TARGET_FIELD)) {
    const dto = buildStatusV1({ available: false, reason: 'target_unavailable', field }, null);
    assert.equal(dto.message, EXPECTED_TARGET_MESSAGES[field], `unexpected message for field "${field}"`);
    assert.deepEqual(dto.blocked, [{ reason: 'target_unavailable', detail: field }]);
    assert.deepEqual(dto.uncertain, []);
    assert.deepEqual(Object.keys(dto).sort(), remoteUnavailableKeys, 'DTO field set must stay unchanged (SYNC-07 prohibition)');
  }
});

test('buildStatusV1 falls back to the `target` message for an unrecognized or absent field, rather than an empty message', () => {
  const unrecognized = buildStatusV1({ available: false, reason: 'target_unavailable', field: 'nonsense' }, null);
  assert.equal(unrecognized.message, EXPECTED_TARGET_MESSAGES.target);
  assert.equal(unrecognized.blocked.length, 1);
  assert.deepEqual(unrecognized.blocked, [{ reason: 'target_unavailable', detail: 'nonsense' }]);

  const absent = buildStatusV1({ available: false, reason: 'target_unavailable' }, null);
  assert.equal(absent.message, EXPECTED_TARGET_MESSAGES.target);
  assert.deepEqual(absent.blocked, [{ reason: 'target_unavailable' }]);
});

test('every target_unavailable message is distinct from every other and from the remote-outage message', () => {
  const targetMessages = Object.values(SYNC_TARGET_FIELD).map((field) => buildStatusV1({ available: false, reason: 'target_unavailable', field }, null).message);
  assert.equal(new Set(targetMessages).size, 6, 'all six field messages must be distinct');
  assert.ok(targetMessages.every((message) => typeof message === 'string' && message.length > 0));
  const remoteOutageMessage = buildStatusV1({ available: false, reason: 'remote_unavailable' }, null).message;
  for (const message of targetMessages) assert.notEqual(message, remoteOutageMessage);
});

test('a target_unavailable blocked entry renders through the human path with its field as detail (D-13)', () => {
  const dto = buildStatusV1({ available: false, reason: 'target_unavailable', field: 'repository_number' }, null);
  assert.equal(renderStatusV1(dto, false), `${dto.message}\n`);
});

// ─── Plan 07-11 Task 1 (D-03 gap closure, GAP 3 of 07-VERIFICATION.md):
// `buildStatusV1`'s `project_absent` branch — the board is unreadable, but
// the existence/absences/rebuild-scope preview the router's widened D-03
// gate already computed is real and must not be discarded. ─────────────────

test('buildStatusV1 on a project_absent reason returns available:false with the real existence/absences/rebuildScope preview, never the EMPTY_* constants', () => {
  const result = buildStatusV1({ available: false, reason: 'project_absent' }, null, {
    verdicts: [{ logicalKey: 'project', verdict: 'confirmed-absent' }],
    absences: [{ logicalKey: 'project', count: 2, firstSeenAt: '2026-08-01T00:00:00.000Z' }],
    rebuildScope: { triggered: true, triggeredKeys: ['project'], structureOperations: ['project'], optionsOperations: [] },
  });
  assert.equal(result.available, false);
  assert.equal(result.message, 'github-sync status is unavailable because the configured GitHub Project does not resolve; it may have been deleted.');
  assert.deepEqual(result.creates, []);
  assert.deepEqual(result.updates, []);
  assert.deepEqual(result.blocked, [{ reason: 'project_absent' }]);
  assert.deepEqual(result.uncertain, []);
  assert.deepEqual(result.existence, { present: 0, confirmedAbsent: 1, unknown: 0, unknownKeys: [] });
  assert.deepEqual(result.absences, [{ logicalKey: 'project', count: 2, firstSeenAt: '2026-08-01T00:00:00.000Z' }]);
  assert.deepEqual(result.rebuildScope, { triggered: true, triggeredKeys: ['project'], structureOperations: ['project'], optionsOperations: [] });
  assert.deepEqual(result.limitations, ['The existence and rebuild-scope details below describe what a rebuild would create, not what is currently on the board.']);
});

test('buildStatusV1 on a project_absent reason with no existence summary at all still defaults to the EMPTY_* constants, never throwing', () => {
  const result = buildStatusV1({ available: false, reason: 'project_absent' }, null);
  assert.equal(result.available, false);
  assert.deepEqual(result.existence, { present: 0, confirmedAbsent: 0, unknown: 0, unknownKeys: [] });
  assert.deepEqual(result.absences, []);
  assert.deepEqual(result.rebuildScope, { triggered: false, triggeredKeys: [], structureOperations: [], optionsOperations: [] });
});

test('buildStatusV1 keeps the target_unavailable and generic remote_unavailable branches byte-identical alongside the new project_absent branch', () => {
  const targetFault = buildStatusV1({ available: false, reason: 'target_unavailable', field: 'owner' }, null);
  assert.deepEqual(targetFault, {
    version: 1,
    available: false,
    message: 'github-sync status is unavailable because github_sync.target.owner in .planning/config.json is invalid. Set it to a non-empty string (the GitHub owner login), then re-run.',
    creates: [], updates: [], noops: [],
    blocked: [{ reason: 'target_unavailable', detail: 'owner' }],
    uncertain: [],
    orphans: [], pendingIssueUpdates: [], pendingFieldChanges: [], subIssueCeilingWarnings: [],
    adoptions: [], prune: [], contentDrift: [],
    existence: { present: 0, confirmedAbsent: 0, unknown: 0, unknownKeys: [] },
    absences: [],
    rebuildScope: { triggered: false, triggeredKeys: [], structureOperations: [], optionsOperations: [] },
    limitations: ['The local github_sync.target configuration is invalid; no remote read was attempted.'],
  });
  const remoteOutage = buildStatusV1({ available: false, reason: 'remote_unavailable' }, null);
  assert.deepEqual(remoteOutage, {
    version: 1,
    available: false,
    message: 'github-sync status is unavailable because GitHub could not be read. Retry shortly.',
    creates: [], updates: [], noops: [], blocked: [], uncertain: [{ reason: 'remote_unavailable' }],
    orphans: [], pendingIssueUpdates: [], pendingFieldChanges: [], subIssueCeilingWarnings: [],
    adoptions: [], prune: [], contentDrift: [],
    existence: { present: 0, confirmedAbsent: 0, unknown: 0, unknownKeys: [] },
    absences: [],
    rebuildScope: { triggered: false, triggeredKeys: [], structureOperations: [], optionsOperations: [] },
    limitations: ['Remote data is currently unavailable; no changes were made.'],
  });
});

test('renderStatusV1 for a project_absent DTO renders the message followed by the existence/absences/rebuild-scope group lines (a developer sees the same facts the JSON carries), and never a limitations line', () => {
  const dto = buildStatusV1({ available: false, reason: 'project_absent' }, null, {
    verdicts: [{ logicalKey: 'project', verdict: 'confirmed-absent' }],
    absences: [{ logicalKey: 'project', count: 2, firstSeenAt: '2026-08-01T00:00:00.000Z' }],
    rebuildScope: { triggered: true, triggeredKeys: ['project'], structureOperations: ['project'], optionsOperations: [] },
  });
  const out = renderStatusV1(dto, false);
  assert.equal(out, [
    dto.message,
    'existence: present=0 confirmed-absent=1 unknown=0',
    'absences: 1',
    '  - project (count=2, since=2026-08-01T00:00:00.000Z)',
    'rebuild-scope: triggered=true',
    '  - trigger: project',
    '  - structure: project',
    '',
  ].join('\n'));
  assert.doesNotMatch(out, /limitations:/);
});

test('renderStatusV1 for a project_absent DTO with an empty preview (existence summary omitted) stays exactly the message line, matching every other unavailable branch', () => {
  const dto = buildStatusV1({ available: false, reason: 'project_absent' }, null);
  assert.equal(renderStatusV1(dto, false), `${dto.message}\n`);
});

test('renderStatusV1(dto, true) for a project_absent DTO stays exactly JSON.stringify(dto), regardless of the new human-branch group lines (D-15)', () => {
  const dto = buildStatusV1({ available: false, reason: 'project_absent' }, null, {
    verdicts: [{ logicalKey: 'project', verdict: 'confirmed-absent' }],
    rebuildScope: { triggered: true, triggeredKeys: ['project'], structureOperations: ['project'], optionsOperations: [] },
  });
  assert.equal(renderStatusV1(dto, true), JSON.stringify(dto));
});

// ─── WINDOWS #8 (plan 07-03): the shared, exhaustively-tested mutation-kind catalog ─

const MILESTONE_VERSION = 'v1.0';
const MILESTONE_KEY = BOOTSTRAP_LOGICAL_KEY.milestone(MILESTONE_VERSION);

/** Plan 05-05's plan-item field bootstrap completions — mirrors tests/github-sync-reconcile.test.cjs's own fixture so a brand-new plan's field writes resolve instead of blocking. */
function planFieldBootstrapCompletions() {
  return {
    [BOOTSTRAP_LOGICAL_KEY.field('GSD ID')]: { nodeId: 'FIELD_GSD_ID' },
    [BOOTSTRAP_LOGICAL_KEY.field('Phase')]: { nodeId: 'FIELD_PHASE' },
    [BOOTSTRAP_LOGICAL_KEY.field('Requirements')]: { nodeId: 'FIELD_REQUIREMENTS' },
    [BOOTSTRAP_LOGICAL_KEY.field('Status')]: { nodeId: 'FIELD_STATUS' },
    [BOOTSTRAP_LOGICAL_KEY.field('Wave')]: { nodeId: 'FIELD_WAVE' },
    [BOOTSTRAP_LOGICAL_KEY.field('Autonomous')]: { nodeId: 'FIELD_AUTONOMOUS' },
    [BOOTSTRAP_LOGICAL_KEY.statusOption('Todo')]: { nodeId: 'OPTION_TODO' },
    [BOOTSTRAP_LOGICAL_KEY.statusOption('In Progress')]: { nodeId: 'OPTION_IN_PROGRESS' },
    [BOOTSTRAP_LOGICAL_KEY.statusOption('Done')]: { nodeId: 'OPTION_DONE' },
    [BOOTSTRAP_LOGICAL_KEY.autonomousOption('Yes')]: { nodeId: 'OPTION_AUTONOMOUS_YES' },
    [BOOTSTRAP_LOGICAL_KEY.autonomousOption('No')]: { nodeId: 'OPTION_AUTONOMOUS_NO' },
  };
}

test('exhaustiveness: every distinct MutationOperation.kind reachable from planReconciliation and prepareIssueUpdates across a fixture exercising create, bind, update, field-change, sub-issue, and state-change paths is a member of the shared catalog', () => {
  const kinds = new Set();
  const TARGET = { owner: 'octo', repo: 'repo', repositoryNumber: 42, projectNumber: 7, projectNodeId: 'PVT_proj_node_1' };
  const MILESTONES = [{ version: MILESTONE_VERSION, name: 'One', title: `${MILESTONE_VERSION} — One`, description: 'd', archived: false }];

  // create-issue + create (bind-to-project): a brand-new phase with a resolvable milestone.
  const phasePlan = planReconciliation(
    { available: true, reason: 'ok', currentPhase: '04', phases: [{ id: '04', title: 'Phase Four', goal: 'ship it' }], plans: [], milestones: MILESTONES },
    { available: true, reason: 'ok', target: TARGET, items: [], fields: [], subIssues: [], issueNodeIds: {} },
    { kind: 'valid', map: { completions: { [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 } } } },
  );
  for (const op of phasePlan.operations) kinds.add(op.kind);

  // create-plan-issue + add-sub-issue + create (bind) + update-field-value: a brand-new plan with a resolvable parent and full field completions.
  const planId = '04-03';
  const planFixture = { id: planId, phaseId: '04', title: '04-03 — Splice a region', tasks: ['Task 1: First'], status: 'Todo' };
  const createPlanResult = planReconciliation(
    { available: true, reason: 'ok', currentPhase: null, phases: [], plans: [planFixture], milestones: MILESTONES },
    { available: true, reason: 'ok', target: TARGET, items: [], fields: [], subIssues: [], issueNodeIds: {} },
    {
      kind: 'valid',
      map: {
        completions: {
          [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 },
          [issueKeyFor('04')]: { nodeId: 'I_node_phase_parent', issueNumber: 40 },
          ...planFieldBootstrapCompletions(),
        },
      },
    },
  );
  assert.deepEqual(createPlanResult.blocked, [], 'the create-plan fixture must resolve every field, not block, so update-field-value actually appears');
  for (const op of createPlanResult.operations) kinds.add(op.kind);

  // update-plan-issue-state: a plan already bound and content/field-converged, but whose recorded state disagrees with plan.complete.
  const stateePlan = {
    id: planId, phaseId: '04', title: '04-03 — Splice a region', tasks: ['Task 1: First'],
    status: 'In Progress', wave: 2, autonomous: true, requirements: ['PLAN-01'], complete: true,
  };
  const stateRegion = renderPlanRegion({ id: stateePlan.id, title: stateePlan.title, status: stateePlan.status, tasks: stateePlan.tasks });
  const stateHash = contentHash({ title: stateePlan.title, region: stateRegion, milestoneNumber: 3 });
  const stateFieldState = renderFieldState(
    { gsdId: planKeyFor(planId), phaseId: stateePlan.phaseId, requirements: stateePlan.requirements, status: stateePlan.status, wave: stateePlan.wave, autonomous: stateePlan.autonomous },
    PLAN_FIELD_NAMES,
  );
  const stateResult = planReconciliation(
    { available: true, reason: 'ok', currentPhase: null, phases: [], plans: [stateePlan], milestones: MILESTONES },
    { available: true, reason: 'ok', target: TARGET, items: [{ id: 'item-plan-0403', content: { id: 'ISSUE_NODE_PLAN_0403', number: 88 } }], fields: [], subIssues: [], issueNodeIds: {} },
    {
      kind: 'valid',
      map: {
        completions: {
          [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 },
          [planKeyFor(planId)]: { nodeId: 'item-plan-0403', issueNumber: 88, fieldState: stateFieldState },
          [planIssueKeyFor(planId)]: { nodeId: 'ISSUE_NODE_PLAN_0403', issueNumber: 88, contentHash: stateHash, issueState: 'open' },
        },
      },
    },
  );
  assert.equal(stateResult.operations.filter((op) => op.kind === 'update-plan-issue-state').length, 1, 'the state fixture must actually emit exactly one state PATCH');
  for (const op of stateResult.operations) kinds.add(op.kind);

  // update-issue: a content PATCH through prepareIssueUpdates's own read-splice-write path.
  const body = `${FENCE_BEGIN}\nold\n${FENCE_END}`;
  const issueUpdateResult = prepareIssueUpdates([{
    logicalKey: 'phase:04', issueKey: 'issue:phase:04', issueNumber: 55, issueNodeId: 'ISSUE_NODE_04',
    title: 'Phase Four', region: 'fresh interior', milestoneNumber: 3, milestoneKey: MILESTONE_KEY,
    contentHash: 'freshhash123', completionContext: { owner: 'octo', repo: 'repo', repositoryNumber: 42 },
  }], { cwd: '/fixture', execGh: () => ({ exitCode: 0, stdout: JSON.stringify({ node_id: 'ISSUE_NODE_04', number: 55, body }), stderr: '' }) });
  assert.deepEqual(issueUpdateResult.reports, [], 'the update-issue fixture must actually produce an operation, not a damaged/unreadable report');
  for (const op of issueUpdateResult.operations) kinds.add(op.kind);

  assert.deepEqual(
    [...kinds].sort(),
    Object.keys(operationMod.MUTATION_KIND_BUCKET).sort(),
    'every kind a real fixture reaches must be a member of the catalog, and the catalog must carry no dead entry the fixture never reaches',
  );
});

test('the exhaustiveness catalog fails closed: removing a member from the fixture-reached kind set would no longer set-equal the catalog (sanity control for the assertion above, not a catalog mutation)', () => {
  const reachedKinds = new Set(['create', 'create-issue', 'create-plan-issue', 'update-field-value', 'add-sub-issue', 'update-plan-issue-state', 'update-issue']);
  const withOneRemoved = new Set(reachedKinds);
  withOneRemoved.delete('add-sub-issue');
  assert.notDeepEqual([...withOneRemoved].sort(), Object.keys(operationMod.MUTATION_KIND_BUCKET).sort());
  assert.deepEqual([...reachedKinds].sort(), Object.keys(operationMod.MUTATION_KIND_BUCKET).sort());
});

test('statusBucketForKind classifies every real kind into creates or updates, and returns null for an unrecognised kind', () => {
  assert.equal(operationMod.statusBucketForKind('create'), operationMod.STATUS_BUCKET.CREATES);
  assert.equal(operationMod.statusBucketForKind('create-issue'), operationMod.STATUS_BUCKET.CREATES);
  assert.equal(operationMod.statusBucketForKind('create-plan-issue'), operationMod.STATUS_BUCKET.CREATES);
  assert.equal(operationMod.statusBucketForKind('update-field-value'), operationMod.STATUS_BUCKET.UPDATES);
  assert.equal(operationMod.statusBucketForKind('add-sub-issue'), operationMod.STATUS_BUCKET.UPDATES);
  assert.equal(operationMod.statusBucketForKind('update-plan-issue-state'), operationMod.STATUS_BUCKET.UPDATES);
  assert.equal(operationMod.statusBucketForKind('update-issue'), operationMod.STATUS_BUCKET.UPDATES);
  assert.equal(operationMod.statusBucketForKind('delete-everything'), null);
});

test('buildStatusV1 on a plan carrying a field-value operation emits that operation\'s logical key in the updates array (WINDOWS #8: field-value writes used to vanish from status entirely)', () => {
  const result = buildStatusV1({ available: true, reason: 'ok' }, {
    operations: [{ kind: 'update-field-value', logicalKey: 'plan:04-03' }],
    noops: [], blocked: [], uncertain: [],
  });
  assert.deepEqual(result.creates, []);
  assert.deepEqual(result.updates, ['plan:04-03']);
  assert.ok(JSON.parse(renderStatusV1(result, true)).updates.includes('plan:04-03'));
});

test('buildStatusV1 on a plan carrying a sub-issue-link, a plan-issue-state, and an issue-content-PATCH operation puts all three in the updates array (WINDOWS #8)', () => {
  const result = buildStatusV1({ available: true, reason: 'ok' }, {
    operations: [
      { kind: 'add-sub-issue', logicalKey: 'issue:plan:04-03' },
      { kind: 'update-plan-issue-state', logicalKey: 'issue:plan:04-04' },
      { kind: 'update-issue', logicalKey: 'issue:phase:04' },
    ],
    noops: [], blocked: [], uncertain: [],
  });
  assert.deepEqual(result.creates, []);
  assert.deepEqual(result.updates.sort(), ['issue:phase:04', 'issue:plan:04-03', 'issue:plan:04-04'].sort());
});

test('buildStatusV1 on a plan carrying zero operations still produces empty creates and updates arrays without throwing', () => {
  const result = buildStatusV1({ available: true, reason: 'ok' }, { operations: [], noops: [], blocked: [], uncertain: [] });
  assert.deepEqual(result.creates, []);
  assert.deepEqual(result.updates, []);
});

// ─── Plan 07-06 Task 2/3 (D-01/D-02/D-03/D-06/D-08/D-09): the existence,
// absence, and rebuild-scope groups the router now hands buildStatusV1 as
// its third argument. ────────────────────────────────────────────────────

test('buildStatusV1 with no third argument (every pre-07-06 call site) defaults every new group to empty', () => {
  const result = buildStatusV1({ available: true, reason: 'ok' }, { operations: [], noops: [], blocked: [], uncertain: [] });
  assert.deepEqual(result.adoptions, []);
  assert.deepEqual(result.prune, []);
  assert.deepEqual(result.existence, { present: 0, confirmedAbsent: 0, unknown: 0, unknownKeys: [] });
  assert.deepEqual(result.absences, []);
  assert.deepEqual(result.rebuildScope, { triggered: false, triggeredKeys: [], structureOperations: [], optionsOperations: [] });
});

test('buildStatusV1 counts verdicts by kind and names an unreadable object by its own logical key, not only by its reason', () => {
  const result = buildStatusV1({ available: true, reason: 'ok' }, { operations: [], noops: [], blocked: [{ reason: 'existence_unknown', detail: 'field:gsd-id' }], uncertain: [] }, {
    verdicts: [
      { logicalKey: 'project', verdict: 'present' },
      { logicalKey: 'label:gsd-phase', verdict: 'present' },
      { logicalKey: 'plan:09-09', verdict: 'confirmed-absent' },
      { logicalKey: 'field:gsd-id', verdict: 'unknown' },
    ],
  });
  assert.deepEqual(result.existence, { present: 2, confirmedAbsent: 1, unknown: 1, unknownKeys: ['field:gsd-id'] });
  // The same object is also named individually in `blocked` — this group is
  // an additional, not a replacing, surface.
  assert.deepEqual(result.blocked, [{ reason: 'existence_unknown', detail: 'field:gsd-id' }]);
});

test('buildStatusV1 reports the per-object absence count and first-seen instant verbatim', () => {
  const result = buildStatusV1({ available: true, reason: 'ok' }, { operations: [], noops: [], blocked: [], uncertain: [] }, {
    absences: [{ logicalKey: 'plan:09-09', count: 2, firstSeenAt: '2026-08-01T00:00:00.000Z' }],
  });
  assert.deepEqual(result.absences, [{ logicalKey: 'plan:09-09', count: 2, firstSeenAt: '2026-08-01T00:00:00.000Z' }]);
});

test('buildStatusV1 carries the rebuild-scope preview verbatim, including when the run has no trigger at all', () => {
  const triggered = buildStatusV1({ available: true, reason: 'ok' }, { operations: [], noops: [], blocked: [], uncertain: [] }, {
    rebuildScope: { triggered: true, triggeredKeys: ['project'], structureOperations: ['project'], optionsOperations: ['option:status:todo'] },
  });
  assert.deepEqual(triggered.rebuildScope, { triggered: true, triggeredKeys: ['project'], structureOperations: ['project'], optionsOperations: ['option:status:todo'] });

  const healthy = buildStatusV1({ available: true, reason: 'ok' }, { operations: [], noops: [], blocked: [], uncertain: [] }, {
    rebuildScope: { triggered: false, triggeredKeys: [], structureOperations: [], optionsOperations: [] },
  });
  assert.deepEqual(healthy.rebuildScope, { triggered: false, triggeredKeys: [], structureOperations: [], optionsOperations: [] });
});

test('buildStatusV1 carries plan.adoptions and plan.prune through verbatim, defaulting to empty on a pre-07-05/07-06-shaped plan', () => {
  const withBoth = buildStatusV1({ available: true, reason: 'ok' }, {
    operations: [], noops: [], blocked: [], uncertain: [],
    adoptions: [{ logicalKey: 'issue:phase:05', previousNodeId: 'ISSUE_OLD', resolvedNodeId: 'ISSUE_NEW' }],
    prune: [{ logicalKey: 'plan:09-09' }],
  });
  assert.deepEqual(withBoth.adoptions, [{ logicalKey: 'issue:phase:05', previousNodeId: 'ISSUE_OLD', resolvedNodeId: 'ISSUE_NEW' }]);
  assert.deepEqual(withBoth.prune, ['plan:09-09']);

  const withNeither = buildStatusV1({ available: true, reason: 'ok' }, { operations: [], noops: [], blocked: [], uncertain: [] });
  assert.deepEqual(withNeither.adoptions, []);
  assert.deepEqual(withNeither.prune, []);
});

// ─── Plan 07-12 (WINDOWS #10 gap closure, Task 1 option-b): a bound item's
// content drift — a cross-repository drift is named, never acted on. ───────

test('buildStatusV1 carries plan.contentDrift through verbatim, defaulting to empty on a pre-07-12-shaped plan', () => {
  const entry = {
    logicalKey: 'issue:phase:12', previousOwner: 'octo', previousRepo: 'repo', previousIssueNumber: 501,
    currentOwner: 'other-owner', currentRepo: 'other-repo', currentIssueNumber: 501,
  };
  const withDrift = buildStatusV1({ available: true, reason: 'ok' }, {
    operations: [], noops: [], blocked: [], uncertain: [],
    // `github-sync-reconcile.cts`'s real ContentDriftEntry also carries
    // previousNodeId/currentNodeId/crossRepository — the DTO narrows to the
    // seven fields a developer reading `status` needs, dropping node ids
    // (already available via adoptions for the in-repository half).
    contentDrift: [{ ...entry, previousNodeId: 'ISSUE_NODE_12', currentNodeId: 'ISSUE_NODE_12_MOVED', crossRepository: true }],
  });
  assert.deepEqual(withDrift.contentDrift, [entry]);

  const withNeither = buildStatusV1({ available: true, reason: 'ok' }, { operations: [], noops: [], blocked: [], uncertain: [] });
  assert.deepEqual(withNeither.contentDrift, []);
});

test('renderStatusV1 renders a content-drift entry as its logical key and both full identities, naming the map as unchanged', () => {
  const dto = buildStatusV1({ available: true, reason: 'ok' }, {
    operations: [], noops: [], blocked: [], uncertain: [],
    contentDrift: [{
      logicalKey: 'issue:phase:12', previousNodeId: 'N1', previousOwner: 'octo', previousRepo: 'repo', previousIssueNumber: 501,
      currentNodeId: 'N2', currentOwner: 'other-owner', currentRepo: 'other-repo', currentIssueNumber: 501, crossRepository: true,
    }],
  });
  const out = renderStatusV1(dto, false);
  assert.match(out, /content-drift: 1\n {2}- issue:phase:12: octo\/repo#501 -> other-owner\/other-repo#501 \(cross-repository, map unchanged\)\n/);
});
