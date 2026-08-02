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
    nodeIdPath: 'addProjectV2ItemById.item.id',
    numberPath: 'addProjectV2ItemById.item.content.number',
  });
  assert.equal(operation.transport, 'graphql');
  assert.equal(operation.action, 'create');
  assert.equal(operation.hasPointsBudget, false);
  assert.equal(operation.contentCreation, true);
  assert.ok(operation.args.includes('api'));
  assert.ok(operation.args.includes('graphql'));
  const query = operation.args.find((arg) => arg.startsWith('query='));
  assert.ok(query?.startsWith('query=mutation'));
  // LIVE FINDING (plan 04-01, gh 2.96.0, 2026-08-02): rateLimit does not exist
  // on GitHub's Mutation root type — the document must select no such field,
  // and the operation must declare no points budget for it.
  assert.doesNotMatch(query, /rateLimit/);
  assert.match(query, /addProjectV2ItemById\(input:/);
  // The live probe found only `addProjectV2ItemById` on Mutation (no bare
  // `addProjectV2Item`) — assert its absence specifically, not merely that
  // the `...ById` form is present, so a future partial revert is caught.
  // (A literal "addProjectV2Item(" with no "ById" in between never matches
  // the confirmed mutation name, which always has "ById" before its paren.)
  assert.doesNotMatch(query, /addProjectV2Item\(/);
  assert.match(query, /item \{ id content \{ \.\.\. on Issue \{ number \} \} \}/);
  assert.deepEqual(operation.args.filter((arg) => arg === '-F').length, 0);
  assert.ok(operation.args.includes('projectId=PVT_proj_node_1'));
  assert.ok(operation.args.includes('contentId=ISSUE_NODE_101'));
  assert.equal(operation.args.some((arg) => /^projectId=7$/.test(arg) || /^contentId=0?2$/.test(arg)), false);

  // The mutation name and both capture paths must all agree on the same
  // root payload key, so a future rename of one cannot silently desync from
  // the others.
  const mutationNameMatch = /(addProjectV2ItemById)\(input:/.exec(query);
  assert.ok(mutationNameMatch);
  const mutationName = mutationNameMatch[1];
  assert.ok(operation.captures[0].nodeIdPath.startsWith(`${mutationName}.`));
  assert.ok(operation.captures[0].numberPath.startsWith(`${mutationName}.`));

  // Every GraphQL variable carrying an opaque node id rides the raw value
  // flag (`-f`), never the typed flag (`-F`) — walk the argv array and check
  // the flag immediately preceding each projectId=/contentId= value.
  for (let index = 0; index < operation.args.length - 1; index += 1) {
    const value = operation.args[index + 1];
    if (typeof value === 'string' && (value.startsWith('projectId=') || value.startsWith('contentId='))) {
      assert.equal(operation.args[index], '-f', `expected raw flag before ${value}`);
    }
  }
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
