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
