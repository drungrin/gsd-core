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
const remote = {
  available: true,
  reason: 'ok',
  target: { owner: 'octo', repo: 'repo', repositoryNumber: 42, projectNumber: 7 },
  items: [{ id: 'item-01', content: { number: 1 } }],
  fields: [],
  subIssues: [],
};

test('planReconciliation is deterministic and treats matching remote items and map completions as no-ops', () => {
  const map = { kind: 'valid', map: { completions: { 'phase:02': { nodeId: 'item-02' } } } };
  const first = planReconciliation(desired, remote, map);
  const second = planReconciliation(desired, remote, map);

  assert.deepEqual(first, second);
  assert.deepEqual(first.operations, []);
  assert.deepEqual(first.noops.map((entry) => entry.logicalKey), ['phase:01', 'phase:02']);
});

test('planReconciliation emits a complete, array-only mutation operation from desired, remote, and map inputs', () => {
  const plan = planReconciliation(desired, { ...remote, items: [] }, { kind: 'absent' });
  assert.deepEqual(plan.operations.map((entry) => [entry.kind, entry.logicalKey]), [
    [OPERATION_KIND.CREATE, 'phase:01'], [OPERATION_KIND.CREATE, 'phase:02'],
  ]);

  const operation = plan.operations[0];
  assert.ok(Array.isArray(operation.args) && operation.args.length > 0);
  assert.ok(operation.args.every((arg) => typeof arg === 'string'));
  assert.deepEqual(operation.completionContext, { owner: 'octo', repo: 'repo', repositoryNumber: 42 });
  assert.equal(operation.responsePayloadKey, 'addProjectV2Item');
  assert.equal(operation.contentCreation, true);
  assert.ok(operation.args.includes('api'));
  assert.ok(operation.args.includes('graphql'));
  assert.equal(operation.args.filter((arg) => arg === '-f').length, 1);
  const query = operation.args.find((arg) => arg.startsWith('query='));
  assert.ok(query?.startsWith('query=mutation'));
  assert.match(query, /rateLimit \{ cost remaining resetAt \}/);
  assert.match(query, /addProjectV2Item\(input:/);
  assert.match(query, /projectV2Item \{ id content \{ \.\.\. on Issue \{ number \} \} \}/);
  assert.ok(operation.args.some((arg) => arg === '-F'));
  assert.ok(operation.args.includes('projectId=7'));
});

test('planReconciliation preserves typed blocked and uncertain outcomes', () => {
  const blocked = planReconciliation(desired, remote, { kind: 'blocking', reason: 'repository_mismatch' });
  assert.deepEqual(blocked.blocked, [{ reason: OPERATION_REASON.MAP_BLOCKING, detail: 'repository_mismatch' }]);

  const uncertain = planReconciliation(desired, { ...remote, available: false, reason: 'remote_unavailable' }, { kind: 'absent' });
  assert.deepEqual(uncertain.uncertain, [{ reason: OPERATION_REASON.REMOTE_UNAVAILABLE }]);
});
