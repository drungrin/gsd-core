'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildStatusV1, renderStatusV1, STATUS_SCHEMA_VERSION } = require('../gsd-core/bin/lib/github-sync-status.cjs');

test('buildStatusV1 groups a complete reconciliation plan into the documented compact DTO', () => {
  const result = buildStatusV1({ available: true, reason: 'ok' }, {
    operations: [{ kind: 'create', logicalKey: 'phase:02' }, { kind: 'update', logicalKey: 'phase:01' }],
    noops: [{ logicalKey: 'phase:00' }],
    blocked: [{ reason: 'map_blocking', detail: 'repository_mismatch' }],
    uncertain: [{ reason: 'remote_unavailable' }],
  });

  assert.deepEqual(result, {
    version: STATUS_SCHEMA_VERSION,
    available: true,
    creates: ['phase:02'], updates: ['phase:01'], noops: ['phase:00'],
    blocked: [{ reason: 'map_blocking', detail: 'repository_mismatch' }],
    uncertain: [{ reason: 'remote_unavailable' }], limitations: [],
  });
  assert.equal(JSON.parse(renderStatusV1(result, true)).version, 1);
});

test('buildStatusV1 produces an actionable fixed unavailable state without raw transport detail', () => {
  const result = buildStatusV1({ available: false, reason: 'remote_unavailable', stderr: 'secret transport output' }, null);
  assert.deepEqual(result, {
    version: 1,
    available: false,
    message: 'github-sync status is unavailable because GitHub could not be read. Retry shortly.',
    creates: [], updates: [], noops: [], blocked: [], uncertain: [{ reason: 'remote_unavailable' }],
    limitations: ['Remote data is currently unavailable; no changes were made.'],
  });
  assert.doesNotMatch(JSON.stringify(result), /secret transport output/);
});

test('status schema documentation pins every exported DTO field', () => {
  const documentation = fs.readFileSync(path.join(__dirname, '..', 'docs', 'github-sync-status-schema-v1.md'), 'utf8');
  for (const field of ['version', 'available', 'creates', 'updates', 'noops', 'blocked', 'uncertain', 'limitations', 'message']) {
    assert.match(documentation, new RegExp('`' + field + '`'));
  }
});

// ─── G-02-2 (Task 2): D-13/D-14 grouped, actionable human summary ───────────
//
// The renderer previously emitted counts only ('creates: N'); D-13 requires
// the default output to list what would actually change, and D-14 requires
// all five groups to always appear (even at zero) plus any limitations.

test('renderStatusV1 lists creates, updates, no-ops, blocked (with detail), and uncertain by name, plus limitations (D-13/D-14)', () => {
  const dto = {
    version: 1, available: true,
    creates: ['phase:02'], updates: ['phase:01'], noops: ['phase:00'],
    blocked: [{ reason: 'map_blocking', detail: 'repository_mismatch' }],
    uncertain: [{ reason: 'remote_unavailable' }],
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
    'limitations:',
    '  - Remote data is currently unavailable; no changes were made.',
    '',
  ].join('\n'));
});

test('renderStatusV1 renders a blocked entry without a detail as the bare reason (no empty parentheses)', () => {
  const dto = {
    version: 1, available: true,
    creates: [], updates: [], noops: [],
    blocked: [{ reason: 'sync_map_blocking' }],
    uncertain: [], limitations: [],
  };
  const out = renderStatusV1(dto, false);
  assert.match(out, /blocked: 1\n {2}- sync_map_blocking\n/);
  assert.doesNotMatch(out, /\(/);
});

test('renderStatusV1 still shows all five count lines at zero when every group is empty, with no limitations line (D-14)', () => {
  const dto = {
    version: 1, available: true,
    creates: [], updates: [], noops: [], blocked: [], uncertain: [], limitations: [],
  };
  const out = renderStatusV1(dto, false);
  assert.equal(out, [
    'github-sync status',
    'creates: 0',
    'updates: 0',
    'no-ops: 0',
    'blocked: 0',
    'uncertain: 0',
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
