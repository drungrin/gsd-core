/* Pure reconciliation tests: supplied JSON-safe inputs only, no disk or transport. */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planReconciliation, OPERATION_KIND, OPERATION_REASON, issueKeyFor } = require('../gsd-core/bin/lib/github-sync-reconcile.cjs');
const { GSD_LABELS, BOOTSTRAP_LOGICAL_KEY } = require('../gsd-core/bin/lib/github-sync-bootstrap-plan.cjs');

const MILESTONE_VERSION = 'v1.0';
const MILESTONE_KEY = BOOTSTRAP_LOGICAL_KEY.milestone(MILESTONE_VERSION);

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
  // phase:02 has no completion of any kind (no phase:02, no issue:phase:02)
  // and this fixture's `desired` declares no milestone, so it is a genuinely
  // new phase that cannot be created without a checkpointed milestone.
  assert.deepEqual(first.blocked, [{ reason: OPERATION_REASON.MILESTONE_UNRESOLVED, detail: 'phase:02' }]);
});

test('planReconciliation emits a create operation with opaque project and issue node IDs only (legacy phase:<id>-only completion, resolved via remote issueNodeIds)', () => {
  const plan = planReconciliation(
    desired,
    { ...remote, items: [], issueNodeIds: { 101: 'ISSUE_NODE_101' } },
    { kind: 'valid', map: { completions: { 'phase:01': { nodeId: 'item-01', issueNumber: 101 } } } },
  );
  assert.deepEqual(plan.operations.map((entry) => [entry.kind, entry.logicalKey]), [[OPERATION_KIND.CREATE, 'phase:01']]);
  assert.deepEqual(plan.blocked, [{ reason: OPERATION_REASON.MILESTONE_UNRESOLVED, detail: 'phase:02' }]);

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

test('planReconciliation ignores coincidental remote issue numbers and blocks identity when a legacy phase:<id> completion cannot be resolved', () => {
  // phase:01 carries a legacy phase:<id>-only completion (no issue:phase:01
  // completion) whose issue number cannot be resolved against remote
  // issueNodeIds; a differently-numbered, differently-identified remote item
  // happens to be present and must never be mistaken for it.
  const coincidental = planReconciliation(
    desired,
    {
      ...remote,
      items: [{ id: 'item-02', content: { id: 'ISSUE_NODE_2', number: 2 } }],
      issueNodeIds: {},
    },
    { kind: 'valid', map: { completions: { 'phase:01': { nodeId: 'item-01-stale', issueNumber: 999 } } } },
  );
  assert.deepEqual(coincidental.noops, []);
  assert.deepEqual(coincidental.operations, []);
  assert.deepEqual(coincidental.blocked, [
    { reason: OPERATION_REASON.IDENTITY_UNRESOLVABLE, detail: 'phase:01' },
    // phase:02 carries no completion of any kind and this fixture declares
    // no milestone, so it is blocked for the unrelated, new-phase reason.
    { reason: OPERATION_REASON.MILESTONE_UNRESOLVED, detail: 'phase:02' },
  ]);
});

test('planReconciliation preserves typed blocked and uncertain outcomes', () => {
  const blocked = planReconciliation(desired, remote, { kind: 'blocking', reason: 'repository_mismatch' });
  assert.deepEqual(blocked.blocked, [{ reason: OPERATION_REASON.MAP_BLOCKING, detail: 'repository_mismatch' }]);

  const uncertain = planReconciliation(desired, { ...remote, available: false, reason: 'remote_unavailable' }, { kind: 'absent' });
  assert.deepEqual(uncertain.uncertain, [{ reason: OPERATION_REASON.REMOTE_UNAVAILABLE }]);
});

// ─── Plan 04-01 Task 2: the create-issue path ──────────────────────────────

function desiredWithMilestone(phases) {
  return {
    available: true, reason: 'ok', currentPhase: '01',
    phases,
    plans: [],
    milestones: [{ version: MILESTONE_VERSION, name: 'One', title: `${MILESTONE_VERSION} — One`, description: 'd', archived: false }],
  };
}

function remoteWith(overrides) {
  return {
    available: true,
    reason: 'ok',
    target: { owner: 'octo', repo: 'repo', repositoryNumber: 42, projectNumber: 7, projectNodeId: 'PVT_proj_node_1' },
    items: [],
    fields: [],
    subIssues: [],
    issueNodeIds: {},
    ...overrides,
  };
}

test('a phase absent from the map, with a checkpointed milestone, produces exactly the two create operations in order', () => {
  const single = desiredWithMilestone([{ id: '04', title: 'Phase Four', goal: 'ship it' }]);
  const map = { kind: 'valid', map: { completions: { [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 } } } };

  const plan = planReconciliation(single, remoteWith(), map);
  assert.deepEqual(plan.blocked, []);
  assert.deepEqual(plan.operations.map((entry) => entry.logicalKey), [issueKeyFor('04'), 'phase:04']);
  assert.equal(plan.operations[0].action, OPERATION_KIND.CREATE);
  assert.equal(plan.operations[0].transport, 'rest');
  assert.equal(plan.operations[1].transport, 'graphql');
});

test("the REST create's argv carries the gsd:phase label and no other label", () => {
  const single = desiredWithMilestone([{ id: '04', title: 'Phase Four', goal: 'ship it' }]);
  const map = { kind: 'valid', map: { completions: { [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 } } } };

  const plan = planReconciliation(single, remoteWith(), map);
  const createOp = plan.operations[0];
  const labelValues = [];
  for (let index = 0; index < createOp.args.length - 1; index += 1) {
    const value = createOp.args[index + 1];
    if (typeof value === 'string' && value.startsWith('labels[]=')) labelValues.push(value.slice('labels[]='.length));
  }
  const phaseLabel = GSD_LABELS.find((label) => label.name === 'gsd:phase');
  assert.deepEqual(labelValues, [phaseLabel.name]);
});

test("every developer-sourced string in the REST create argv (title, body) rides the raw value flag", () => {
  const single = desiredWithMilestone([{ id: '04', title: 'Phase Four: <script>', goal: 'ship it' }]);
  const map = { kind: 'valid', map: { completions: { [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 } } } };

  const plan = planReconciliation(single, remoteWith(), map);
  const createOp = plan.operations[0];
  assert.equal(createOp.transport, 'rest');
  assert.equal(createOp.args[0], 'api');
  assert.ok(typeof createOp.args[1] === 'string');
  assert.deepEqual(createOp.args.slice(2, 4), ['-X', 'POST']);

  for (let index = 0; index < createOp.args.length - 1; index += 1) {
    const value = createOp.args[index + 1];
    if (typeof value === 'string' && (value.startsWith('title=') || value.startsWith('body='))) {
      assert.equal(createOp.args[index], '-f', `expected raw flag before ${value.slice(0, 20)}...`);
    }
  }
  const bodyEntry = createOp.args.find((arg) => typeof arg === 'string' && arg.startsWith('body='));
  assert.ok(bodyEntry.includes('gsd:phase id="04"'));
});

test('a phase whose milestone:<version> completion is missing from the map produces zero operations for that phase and one blocked entry, without stopping other phases in the same run', () => {
  const two = desiredWithMilestone([
    { id: '01', title: 'One', goal: 'already bound' },
    { id: '02', title: 'Two', goal: 'brand new' },
  ]);
  // phase:01 is already bound on the board (no-op); phase:02 needs creating
  // but no milestone completion is recorded.
  const remoteTwo = remoteWith({ items: [{ id: 'item-01-bound', content: { id: 'ISSUE_NODE_1', number: 1 } }] });
  const map = { kind: 'valid', map: { completions: { 'phase:01': { nodeId: 'item-01-bound', issueNumber: 1 } } } };

  const plan = planReconciliation(two, remoteTwo, map);
  assert.deepEqual(plan.noops, [{ logicalKey: 'phase:01' }]);
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.blocked, [{ reason: OPERATION_REASON.MILESTONE_UNRESOLVED, detail: 'phase:02' }]);
});

test('a target whose owner or repo carries a brace, a slash, an at-sign, or a space produces zero operations for every phase and one blocked entry with a typed unsafe-target reason', () => {
  const two = desiredWithMilestone([
    { id: '01', title: 'One', goal: 'g1' },
    { id: '02', title: 'Two', goal: 'g2' },
  ]);
  const map = { kind: 'valid', map: { completions: { [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 } } } };
  const hostileValues = ['{owner}', 'owner/evil', 'owner@evil', 'ow ner'];

  for (const hostile of hostileValues) {
    const plan = planReconciliation(two, remoteWith({ target: { owner: hostile, repo: 'repo', repositoryNumber: 42, projectNumber: 7, projectNodeId: 'PVT_proj_node_1' } }), map);
    assert.deepEqual(plan.operations, [], `expected zero operations for hostile owner ${hostile}`);
    assert.deepEqual(plan.noops, []);
    assert.deepEqual(plan.blocked, [{ reason: OPERATION_REASON.UNSAFE_TARGET }], `expected unsafe-target block for hostile owner ${hostile}`);
  }
});

test('a desired state with zero phases produces zero operations, zero blocked entries, and zero no-ops', () => {
  const empty = desiredWithMilestone([]);
  const map = { kind: 'valid', map: { completions: { [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 } } } };

  const plan = planReconciliation(empty, remoteWith(), map);
  assert.deepEqual(plan, { operations: [], noops: [], blocked: [], uncertain: [] });
});
