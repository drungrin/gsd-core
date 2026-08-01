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
  target: { owner: 'octo', repo: 'repo', repositoryNumber: 42, projectNumber: 7, projectNodeId: 'PVT_proj_node_1' },
  items: [{ id: 'item-01', content: { id: 'ISSUE_NODE_1', number: 1 } }],
  fields: [],
  subIssues: [],
  issueNodeIds: {},
};

test('planReconciliation is deterministic and treats a board item matched through strict-map identity as a no-op', () => {
  const map = { kind: 'valid', map: { completions: { 'phase:01': { nodeId: 'item-01', issueNumber: 101 } } } };
  const first = planReconciliation(desired, remote, map);
  const second = planReconciliation(desired, remote, map);

  assert.deepEqual(first, second);
  assert.deepEqual(first.operations, []);
  assert.deepEqual(first.noops.map((entry) => entry.logicalKey), ['phase:01']);
  assert.deepEqual(first.blocked, [{ reason: OPERATION_REASON.IDENTITY_UNRESOLVABLE, detail: 'phase:02' }]);
});

test('planReconciliation emits a create operation with opaque project and issue node IDs only', () => {
  const plan = planReconciliation(
    desired,
    { ...remote, items: [], issueNodeIds: { 101: 'ISSUE_NODE_101' } },
    { kind: 'valid', map: { completions: { 'phase:01': { nodeId: 'item-01', issueNumber: 101 } } } },
  );
  assert.deepEqual(plan.operations.map((entry) => [entry.kind, entry.logicalKey]), [[OPERATION_KIND.CREATE, 'phase:01']]);
  assert.deepEqual(plan.blocked, [{ reason: OPERATION_REASON.IDENTITY_UNRESOLVABLE, detail: 'phase:02' }]);

  const operation = plan.operations[0];
  assert.ok(Array.isArray(operation.args) && operation.args.length > 0);
  assert.ok(operation.args.every((arg) => typeof arg === 'string'));
  assert.deepEqual(operation.completionContext, { owner: 'octo', repo: 'repo', repositoryNumber: 42 });
  assert.equal(operation.captures.length, 1);
  assert.deepEqual(operation.captures[0], {
    kind: 'node',
    logicalKey: 'phase:01',
    nodeIdPath: 'addProjectV2Item.projectV2Item.id',
    numberPath: 'addProjectV2Item.projectV2Item.content.number',
  });
  assert.equal(operation.transport, 'graphql');
  assert.equal(operation.action, 'create');
  assert.equal(operation.hasPointsBudget, true);
  assert.equal(operation.contentCreation, true);
  assert.ok(operation.args.includes('api'));
  assert.ok(operation.args.includes('graphql'));
  assert.equal(operation.args.filter((arg) => arg === '-f').length, 1);
  const query = operation.args.find((arg) => arg.startsWith('query='));
  assert.ok(query?.startsWith('query=mutation'));
  assert.match(query, /rateLimit \{ cost remaining resetAt \}/);
  assert.match(query, /addProjectV2Item\(input:/);
  assert.match(query, /projectV2Item \{ id content \{ \.\.\. on Issue \{ number \} \} \}/);
  assert.deepEqual(operation.args.filter((arg) => arg === '-F').length, 2);
  assert.ok(operation.args.includes('projectId=PVT_proj_node_1'));
  assert.ok(operation.args.includes('contentId=ISSUE_NODE_101'));
  assert.equal(operation.args.some((arg) => /^projectId=7$/.test(arg) || /^contentId=0?2$/.test(arg)), false);
});

test('planReconciliation ignores coincidental remote issue numbers and blocks identity when no stable binding exists', () => {
  const coincidental = planReconciliation(
    desired,
    {
      ...remote,
      items: [{ id: 'item-02', content: { id: 'ISSUE_NODE_2', number: 2 } }],
      issueNodeIds: {},
    },
    { kind: 'absent' },
  );
  assert.deepEqual(coincidental.noops, []);
  assert.deepEqual(coincidental.operations, []);
  assert.deepEqual(coincidental.blocked, [
    { reason: OPERATION_REASON.IDENTITY_UNRESOLVABLE, detail: 'phase:01' },
    { reason: OPERATION_REASON.IDENTITY_UNRESOLVABLE, detail: 'phase:02' },
  ]);
});

test('planReconciliation preserves typed blocked and uncertain outcomes', () => {
  const blocked = planReconciliation(desired, remote, { kind: 'blocking', reason: 'repository_mismatch' });
  assert.deepEqual(blocked.blocked, [{ reason: OPERATION_REASON.MAP_BLOCKING, detail: 'repository_mismatch' }]);

  const uncertain = planReconciliation(desired, { ...remote, available: false, reason: 'remote_unavailable' }, { kind: 'absent' });
  assert.deepEqual(uncertain.uncertain, [{ reason: OPERATION_REASON.REMOTE_UNAVAILABLE }]);
});
