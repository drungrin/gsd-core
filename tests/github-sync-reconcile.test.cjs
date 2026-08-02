/* Pure reconciliation tests: supplied JSON-safe inputs only, no disk or transport. */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planReconciliation, OPERATION_KIND, OPERATION_REASON, issueKeyFor } = require('../gsd-core/bin/lib/github-sync-reconcile.cjs');
const { GSD_LABELS, BOOTSTRAP_LOGICAL_KEY } = require('../gsd-core/bin/lib/github-sync-bootstrap-plan.cjs');
const { renderPhaseRegion, contentHash, renderFieldState } = require('../gsd-core/bin/lib/github-sync-issue-body.cjs');

/** Recursively asserts no object among `inputs` carries a `body` key anywhere — proves SYNC-05/D-08's "no remote body read at all" structurally, not by convention. */
function assertNoRemoteBodyInInputs(...inputs) {
  const seen = new Set();
  function walk(value) {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (!Array.isArray(value)) assert.ok(!('body' in value), 'planReconciliation inputs must never carry a remote body field');
    for (const child of Object.values(value)) walk(child);
  }
  for (const input of inputs) walk(input);
}

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
  assert.deepEqual(plan, {
    operations: [], noops: [], blocked: [], uncertain: [],
    pendingIssueUpdates: [], orphans: [], pendingFieldChanges: [],
  });
});

// ─── Plan 04-04 Task 1: hash-gated no-op, in-place update, and orphans ─────

const STEADY_ID = '04';
const STEADY_LOGICAL_KEY = `phase:${STEADY_ID}`;
const STEADY_ISSUE_KEY = issueKeyFor(STEADY_ID);
const STEADY_MILESTONE_NUMBER = 3;

function steadyPhase(overrides = {}) {
  return { id: STEADY_ID, title: 'Phase Four', goal: 'ship it', requirements: ['PHASE-01'], status: 'In Progress', ...overrides };
}

function steadyDesired(phase) {
  return {
    available: true, reason: 'ok', currentPhase: STEADY_ID,
    phases: [phase], plans: [],
    milestones: [{ version: MILESTONE_VERSION, name: 'One', title: `${MILESTONE_VERSION} — One`, description: 'd', archived: false }],
  };
}

function steadyRemote() {
  return {
    available: true, reason: 'ok',
    target: { owner: 'octo', repo: 'repo', repositoryNumber: 42, projectNumber: 7, projectNodeId: 'PVT_proj_node_1' },
    items: [{ id: 'item-04', content: { id: 'ISSUE_NODE_04', number: 55 } }],
    fields: [], subIssues: [], issueNodeIds: {},
  };
}

function steadyFieldValues(phase) {
  return { gsdId: STEADY_LOGICAL_KEY, phaseId: phase.id, requirements: phase.requirements ?? [], status: phase.status ?? '' };
}

function steadyMap({ contentHashValue, fieldStateValue, milestoneNumber = STEADY_MILESTONE_NUMBER } = {}) {
  return {
    kind: 'valid',
    map: {
      completions: {
        [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: milestoneNumber },
        [STEADY_LOGICAL_KEY]: { nodeId: 'item-04', issueNumber: 55, ...(fieldStateValue !== undefined ? { fieldState: fieldStateValue } : {}) },
        [STEADY_ISSUE_KEY]: { nodeId: 'ISSUE_NODE_04', issueNumber: 55, ...(contentHashValue !== undefined ? { contentHash: contentHashValue } : {}) },
      },
    },
  };
}

test('an unchanged roadmap (equal content hash, equal field state) produces zero mutations, zero pending updates, one no-op, and reads no remote body', () => {
  const phase = steadyPhase();
  const region = renderPhaseRegion(phase);
  const hash = contentHash({ title: phase.title, region, milestoneNumber: STEADY_MILESTONE_NUMBER });
  const fieldState = renderFieldState(steadyFieldValues(phase));
  const desired = steadyDesired(phase);
  const remote = steadyRemote();
  const map = steadyMap({ contentHashValue: hash, fieldStateValue: fieldState });

  assertNoRemoteBodyInInputs(desired, remote, map);
  const plan = planReconciliation(desired, remote, map);
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.pendingIssueUpdates, []);
  assert.deepEqual(plan.pendingFieldChanges, []);
  assert.deepEqual(plan.noops, [{ logicalKey: STEADY_LOGICAL_KEY }]);
  assert.deepEqual(plan.blocked, []);
});

test('a stored content hash that differs from the freshly computed one produces zero operations and one pending update entry carrying the full projection', () => {
  const phase = steadyPhase();
  const region = renderPhaseRegion(phase);
  const hash = contentHash({ title: phase.title, region, milestoneNumber: STEADY_MILESTONE_NUMBER });
  const fieldState = renderFieldState(steadyFieldValues(phase));
  const map = steadyMap({ contentHashValue: 'stale-hash-value', fieldStateValue: fieldState });

  const plan = planReconciliation(steadyDesired(phase), steadyRemote(), map);
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.noops, []);
  assert.equal(plan.pendingIssueUpdates.length, 1);
  assert.deepEqual(plan.pendingIssueUpdates[0], {
    logicalKey: STEADY_LOGICAL_KEY,
    issueKey: STEADY_ISSUE_KEY,
    issueNumber: 55,
    issueNodeId: 'ISSUE_NODE_04',
    title: phase.title,
    region,
    milestoneNumber: STEADY_MILESTONE_NUMBER,
    milestoneKey: MILESTONE_KEY,
    contentHash: hash,
    completionContext: { owner: 'octo', repo: 'repo', repositoryNumber: 42 },
  });
});

test('renaming a phase in the desired state produces a pending update, not a create, carrying the new title', () => {
  const oldPhase = steadyPhase();
  const newPhase = steadyPhase({ title: 'Phase Four (renamed)' });
  const oldHash = contentHash({ title: oldPhase.title, region: renderPhaseRegion(oldPhase), milestoneNumber: STEADY_MILESTONE_NUMBER });
  const map = steadyMap({ contentHashValue: oldHash, fieldStateValue: renderFieldState(steadyFieldValues(newPhase)) });

  const plan = planReconciliation(steadyDesired(newPhase), steadyRemote(), map);
  assert.deepEqual(plan.operations, []);
  assert.equal(plan.pendingIssueUpdates.length, 1);
  assert.equal(plan.pendingIssueUpdates[0].title, newPhase.title);
});

test('changing only the milestone number produces a pending update, proving the hash covers the milestone and not the body alone', () => {
  const phase = steadyPhase();
  const region = renderPhaseRegion(phase);
  const oldHash = contentHash({ title: phase.title, region, milestoneNumber: 999 });
  const map = steadyMap({ contentHashValue: oldHash, fieldStateValue: renderFieldState(steadyFieldValues(phase)), milestoneNumber: STEADY_MILESTONE_NUMBER });

  const plan = planReconciliation(steadyDesired(phase), steadyRemote(), map);
  assert.equal(plan.pendingIssueUpdates.length, 1);
  assert.equal(plan.pendingIssueUpdates[0].milestoneNumber, STEADY_MILESTONE_NUMBER);
});

test('a matching content hash but a differing field state produces a field-change entry and no pending update — the two units converge independently (D-12)', () => {
  const phase = steadyPhase();
  const region = renderPhaseRegion(phase);
  const hash = contentHash({ title: phase.title, region, milestoneNumber: STEADY_MILESTONE_NUMBER });
  const staleFieldState = renderFieldState({ gsdId: STEADY_LOGICAL_KEY, phaseId: phase.id, requirements: [], status: 'Todo' });
  const map = steadyMap({ contentHashValue: hash, fieldStateValue: staleFieldState });

  const plan = planReconciliation(steadyDesired(phase), steadyRemote(), map);
  assert.deepEqual(plan.pendingIssueUpdates, []);
  assert.deepEqual(plan.operations, []);
  assert.equal(plan.pendingFieldChanges.length, 1);
  assert.equal(plan.pendingFieldChanges[0].logicalKey, STEADY_LOGICAL_KEY);
  assert.deepEqual([...plan.pendingFieldChanges[0].changed].sort(), ['requirements', 'status']);
});

test('a field state differing in exactly one field produces exactly one changed field', () => {
  const phase = steadyPhase();
  const region = renderPhaseRegion(phase);
  const hash = contentHash({ title: phase.title, region, milestoneNumber: STEADY_MILESTONE_NUMBER });
  const staleFieldState = renderFieldState({ ...steadyFieldValues(phase), status: 'Todo' });
  const map = steadyMap({ contentHashValue: hash, fieldStateValue: staleFieldState });

  const plan = planReconciliation(steadyDesired(phase), steadyRemote(), map);
  assert.deepEqual(plan.pendingFieldChanges, [{ logicalKey: STEADY_LOGICAL_KEY, changed: ['status'] }]);
});

test('a completion carrying no content hash at all is treated as a mismatch and produces a pending update, never a no-op', () => {
  const phase = steadyPhase();
  const map = steadyMap({ fieldStateValue: renderFieldState(steadyFieldValues(phase)) });

  const plan = planReconciliation(steadyDesired(phase), steadyRemote(), map);
  assert.deepEqual(plan.noops, []);
  assert.equal(plan.pendingIssueUpdates.length, 1);
});

test('a create operation attaches the content hash to its REST capture and the field state to the add-to-project capture, so an immediate re-plan is a no-op with no extra write', () => {
  const phase = { id: '05', title: 'Phase Five', goal: 'ship' };
  const single = desiredWithMilestone([phase]);
  const map = { kind: 'valid', map: { completions: { [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 } } } };

  const plan = planReconciliation(single, remoteWith(), map);
  const [createOp, addOp] = plan.operations;
  assert.equal(typeof createOp.captures[0].plannerFields.contentHash, 'string');
  assert.ok(createOp.captures[0].plannerFields.contentHash.length > 0);
  assert.equal(typeof addOp.captures[0].plannerFields.fieldState, 'string');
  assert.deepEqual(JSON.parse(addOp.captures[0].plannerFields.fieldState), { gsdId: 'phase:05', phaseId: '05', requirements: [], status: '' });

  const resultingMap = {
    kind: 'valid',
    map: {
      completions: {
        [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 },
        'phase:05': { nodeId: 'item-05-node', issueNumber: 900, fieldState: addOp.captures[0].plannerFields.fieldState },
        'issue:phase:05': { nodeId: 'ISSUE_NODE_900', issueNumber: 900, contentHash: createOp.captures[0].plannerFields.contentHash },
      },
    },
  };
  const remoteAfter = remoteWith({ items: [{ id: 'item-05-node', content: { id: 'ISSUE_NODE_900', number: 900 } }] });
  const rePlan = planReconciliation(single, remoteAfter, resultingMap);
  assert.deepEqual(rePlan.operations, []);
  assert.deepEqual(rePlan.pendingIssueUpdates, []);
  assert.deepEqual(rePlan.pendingFieldChanges, []);
  assert.deepEqual(rePlan.noops, [{ logicalKey: 'phase:05' }]);
});

test('a sync map carrying issue:phase:09 and phase:09 completions while the desired state has no phase 09 produces one orphan entry naming the logical key and the issue number, and no blocked entry for it', () => {
  const single = desiredWithMilestone([{ id: '04', title: 'Phase Four', goal: 'g' }]);
  const map = {
    kind: 'valid',
    map: {
      completions: {
        [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 },
        'phase:09': { nodeId: 'item-09', issueNumber: 77 },
        'issue:phase:09': { nodeId: 'ISSUE_NODE_09', issueNumber: 77 },
      },
    },
  };
  const plan = planReconciliation(single, remoteWith(), map);
  assert.deepEqual(plan.orphans, [{ logicalKey: 'phase:09', issueNumber: 77 }]);
  assert.deepEqual(plan.blocked.filter((entry) => entry.detail === 'phase:09'), []);
});

test('a renumbered phase (phase:02 in the map, phase:2.1 in the desired state) produces both an orphan entry for the old id and a create for the new one', () => {
  const single = desiredWithMilestone([{ id: '2.1', title: 'Two Point One', goal: 'g' }]);
  const map = {
    kind: 'valid',
    map: {
      completions: {
        [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 },
        'phase:02': { nodeId: 'item-02', issueNumber: 22 },
        'issue:phase:02': { nodeId: 'ISSUE_NODE_02', issueNumber: 22 },
      },
    },
  };
  const plan = planReconciliation(single, remoteWith(), map);
  assert.deepEqual(plan.orphans, [{ logicalKey: 'phase:02', issueNumber: 22 }]);
  assert.deepEqual(plan.operations.map((entry) => entry.logicalKey), [issueKeyFor('2.1'), 'phase:2.1']);
});

test('a completion whose key is in a reserved bootstrap namespace is never reported as an orphan', () => {
  const single = desiredWithMilestone([{ id: '04', title: 'Phase Four', goal: 'g' }]);
  const map = {
    kind: 'valid',
    map: {
      completions: {
        [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 },
        project: { nodeId: 'PVT_x', issueNumber: 7 },
        'project-link': { nodeId: 'PVT_link_x' },
        'field:gsd-id': { nodeId: 'FIELD_x' },
        'option:status:todo': { nodeId: 'OPT_x' },
        'label:gsd-phase': { nodeId: 'LABEL_x' },
      },
    },
  };
  const plan = planReconciliation(single, remoteWith(), map);
  assert.deepEqual(plan.orphans, []);
});

test('orphan entries are emitted in ascending logical-key order and are stable across runs', () => {
  const single = desiredWithMilestone([{ id: '04', title: 'Phase Four', goal: 'g' }]);
  const map = {
    kind: 'valid',
    map: {
      completions: {
        [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 },
        'phase:10': { nodeId: 'item-10', issueNumber: 100 },
        'phase:02': { nodeId: 'item-02', issueNumber: 20 },
        'issue:phase:10': { nodeId: 'ISSUE_10', issueNumber: 100 },
      },
    },
  };
  const first = planReconciliation(single, remoteWith(), map);
  const second = planReconciliation(single, remoteWith(), map);
  assert.deepEqual(first.orphans, [{ logicalKey: 'phase:02', issueNumber: 20 }, { logicalKey: 'phase:10', issueNumber: 100 }]);
  assert.deepEqual(first.orphans, second.orphans);
});
