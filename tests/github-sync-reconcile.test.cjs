/* Pure reconciliation tests: supplied JSON-safe inputs only, no disk or transport. */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planReconciliation, OPERATION_KIND, OPERATION_REASON } = require('../gsd-core/bin/lib/github-sync-reconcile.cjs');

const desired = {
  available: true, reason: 'ok', currentPhase: '02',
  phases: [{ id: '01', title: 'First', goal: 'one' }, { id: '02', title: 'Second', goal: 'two' }],
  plans: [],
};
const remote = { available: true, reason: 'ok', items: [{ id: 'item-01', content: { number: 1 } }], fields: [], subIssues: [] };

test('planReconciliation is deterministic and makes no mutations for an identical mapped snapshot', () => {
  const map = { kind: 'valid', map: { completions: { 'phase:01': { nodeId: 'item-01' }, 'phase:02': { nodeId: 'item-02' } } } };
  const first = planReconciliation(desired, remote, map);
  const second = planReconciliation(desired, remote, map);

  assert.deepEqual(first, second);
  assert.deepEqual(first.operations, []);
  assert.deepEqual(first.noops.map((entry) => entry.logicalKey), ['phase:01', 'phase:02']);
});

test('planReconciliation uses stable create, blocked, and uncertain classifications', () => {
  const absent = planReconciliation(desired, remote, { kind: 'absent' });
  assert.deepEqual(absent.operations.map((entry) => [entry.kind, entry.logicalKey]), [
    [OPERATION_KIND.CREATE, 'phase:01'], [OPERATION_KIND.CREATE, 'phase:02'],
  ]);

  const blocked = planReconciliation(desired, remote, { kind: 'blocking', reason: 'repository_mismatch' });
  assert.deepEqual(blocked.blocked, [{ reason: OPERATION_REASON.MAP_BLOCKING, detail: 'repository_mismatch' }]);

  const uncertain = planReconciliation(desired, { ...remote, available: false, reason: 'remote_unavailable' }, { kind: 'absent' });
  assert.deepEqual(uncertain.uncertain, [{ reason: OPERATION_REASON.REMOTE_UNAVAILABLE }]);
});
