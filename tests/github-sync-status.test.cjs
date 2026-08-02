'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildStatusV1, renderStatusV1, STATUS_SCHEMA_VERSION } = require('../gsd-core/bin/lib/github-sync-status.cjs');
const { SYNC_TARGET_FIELD } = require('../gsd-core/bin/lib/github-sync-target.cjs');

test('buildStatusV1 groups a complete reconciliation plan into the documented compact DTO', () => {
  const result = buildStatusV1({ available: true, reason: 'ok' }, {
    operations: [{ kind: 'create', logicalKey: 'phase:02' }, { kind: 'update', logicalKey: 'phase:01' }],
    noops: [{ logicalKey: 'phase:00' }],
    blocked: [{ reason: 'map_blocking', detail: 'repository_mismatch' }],
    uncertain: [{ reason: 'remote_unavailable' }],
    orphans: [{ logicalKey: 'phase:09', issueNumber: 77 }],
    pendingIssueUpdates: [{ logicalKey: 'phase:03' }],
  });

  assert.deepEqual(result, {
    version: STATUS_SCHEMA_VERSION,
    available: true,
    creates: ['phase:02'], updates: ['phase:01'], noops: ['phase:00'],
    blocked: [{ reason: 'map_blocking', detail: 'repository_mismatch' }],
    uncertain: [{ reason: 'remote_unavailable' }],
    orphans: [{ logicalKey: 'phase:09', issueNumber: 77 }],
    pendingIssueUpdates: ['phase:03'],
    limitations: [],
  });
  assert.equal(JSON.parse(renderStatusV1(result, true)).version, 1);
});

test('buildStatusV1 derives orphans/pendingIssueUpdates from the plan with an empty default when the plan omits them (pre-04-04-shaped fixture)', () => {
  const result = buildStatusV1({ available: true, reason: 'ok' }, {
    operations: [], noops: [], blocked: [], uncertain: [],
  });
  assert.deepEqual(result.orphans, []);
  assert.deepEqual(result.pendingIssueUpdates, []);
});

test('buildStatusV1 produces an actionable fixed unavailable state without raw transport detail', () => {
  const result = buildStatusV1({ available: false, reason: 'remote_unavailable', stderr: 'secret transport output' }, null);
  assert.deepEqual(result, {
    version: 1,
    available: false,
    message: 'github-sync status is unavailable because GitHub could not be read. Retry shortly.',
    creates: [], updates: [], noops: [], blocked: [], uncertain: [{ reason: 'remote_unavailable' }],
    orphans: [], pendingIssueUpdates: [],
    limitations: ['Remote data is currently unavailable; no changes were made.'],
  });
  assert.doesNotMatch(JSON.stringify(result), /secret transport output/);
});

test('status schema documentation pins every exported DTO field', () => {
  const documentation = fs.readFileSync(path.join(__dirname, '..', 'docs', 'github-sync-status-schema-v1.md'), 'utf8');
  for (const field of ['version', 'available', 'creates', 'updates', 'noops', 'blocked', 'uncertain', 'orphans', 'pendingIssueUpdates', 'limitations', 'message']) {
    assert.match(documentation, new RegExp('`' + field + '`'));
  }
});

// ─── G-02-2 (Task 2): D-13/D-14 grouped, actionable human summary ───────────
//
// The renderer previously emitted counts only ('creates: N'); D-13 requires
// the default output to list what would actually change, and D-14 requires
// all five groups to always appear (even at zero) plus any limitations.

test('renderStatusV1 lists creates, updates, no-ops, blocked (with detail), uncertain, orphans, and updates-pending by name, plus limitations (D-13/D-14)', () => {
  const dto = {
    version: 1, available: true,
    creates: ['phase:02'], updates: ['phase:01'], noops: ['phase:00'],
    blocked: [{ reason: 'map_blocking', detail: 'repository_mismatch' }],
    uncertain: [{ reason: 'remote_unavailable' }],
    orphans: [{ logicalKey: 'phase:09', issueNumber: 77 }],
    pendingIssueUpdates: ['phase:03'],
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
    limitations: [],
  };
  const out = renderStatusV1(dto, false);
  assert.match(out, /blocked: 1\n {2}- sync_map_blocking\n/);
  assert.match(out, /orphans: 1\n {2}- phase:11\n/);
  assert.doesNotMatch(out, /\(/);
});

test('renderStatusV1 still shows all seven count lines at zero when every group is empty, with no limitations line (D-14)', () => {
  const dto = {
    version: 1, available: true,
    creates: [], updates: [], noops: [], blocked: [], uncertain: [],
    orphans: [], pendingIssueUpdates: [], limitations: [],
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
