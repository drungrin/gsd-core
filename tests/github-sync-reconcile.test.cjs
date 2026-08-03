/* Pure reconciliation tests: supplied JSON-safe inputs only, no disk or transport. */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  planReconciliation, OPERATION_KIND, OPERATION_REASON, issueKeyFor,
  buildFieldValueOperations,
  planKeyFor, planIssueKeyFor, buildCreatePlanIssueOperation, buildAddSubIssueOperation, ADD_SUB_ISSUE_DOCUMENT,
} = require('../gsd-core/bin/lib/github-sync-reconcile.cjs');
const { GSD_LABELS, BOOTSTRAP_LOGICAL_KEY } = require('../gsd-core/bin/lib/github-sync-bootstrap-plan.cjs');
const { renderPhaseRegion, renderPlanRegion, contentHash, renderFieldState } = require('../gsd-core/bin/lib/github-sync-issue-body.cjs');

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

test('a phase absent from the map, with a checkpointed milestone but no field completions, produces exactly the two create operations and one field_unresolved blocked entry (plan 04-05: zero field operations, never a partial write)', () => {
  const single = desiredWithMilestone([{ id: '04', title: 'Phase Four', goal: 'ship it' }]);
  const map = { kind: 'valid', map: { completions: { [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 } } } };

  const plan = planReconciliation(single, remoteWith(), map);
  assert.deepEqual(plan.blocked, [{ reason: OPERATION_REASON.FIELD_UNRESOLVED, detail: 'field:gsd-id has no resolved completion' }]);
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

test('a create operation attaches the content hash to its REST capture and the field state to the LAST field-value operation\'s capture (never the add-to-project capture), so an immediate re-plan is a no-op with no extra write', () => {
  const phase = { id: '05', title: 'Phase Five', goal: 'ship', requirements: [], status: 'Todo' };
  const single = desiredWithMilestone([phase]);
  const bootstrapCompletions = {
    [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 },
    'field:gsd-id': { nodeId: 'FIELD_GSD_ID' },
    'field:phase': { nodeId: 'FIELD_PHASE' },
    'field:requirements': { nodeId: 'FIELD_REQUIREMENTS' },
    'field:status': { nodeId: 'FIELD_STATUS' },
    'option:status:todo': { nodeId: 'OPTION_TODO' },
  };
  const map = { kind: 'valid', map: { completions: bootstrapCompletions } };

  const plan = planReconciliation(single, remoteWith(), map);
  assert.deepEqual(plan.blocked, []);
  assert.equal(plan.operations.length, 6);
  const [createOp, addOp, gsdIdOp, phaseOp, requirementsOp, statusOp] = plan.operations;
  assert.equal(typeof createOp.captures[0].plannerFields.contentHash, 'string');
  assert.ok(createOp.captures[0].plannerFields.contentHash.length > 0);
  assert.equal(addOp.captures[0].plannerFields, undefined, 'plan 04-05: fieldState no longer rides the add-to-project capture');
  assert.equal(gsdIdOp.captures[0].plannerFields, undefined);
  assert.equal(phaseOp.captures[0].plannerFields, undefined);
  assert.equal(requirementsOp.captures[0].plannerFields, undefined);
  assert.equal(typeof statusOp.captures[0].plannerFields.fieldState, 'string');
  assert.deepEqual(JSON.parse(statusOp.captures[0].plannerFields.fieldState), { gsdId: 'phase:05', phaseId: '05', requirements: [], status: 'Todo' });

  const resultingMap = {
    kind: 'valid',
    map: {
      completions: {
        ...bootstrapCompletions,
        'phase:05': { nodeId: 'item-05-node', issueNumber: 900, fieldState: statusOp.captures[0].plannerFields.fieldState },
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

// ─── Plan 04-05 Task 2: item field values (buildFieldValueOperations) ─────

const FIELD_KEY = {
  gsdId: BOOTSTRAP_LOGICAL_KEY.field('GSD ID'),
  phase: BOOTSTRAP_LOGICAL_KEY.field('Phase'),
  requirements: BOOTSTRAP_LOGICAL_KEY.field('Requirements'),
  status: BOOTSTRAP_LOGICAL_KEY.field('Status'),
};

function fieldBootstrapCompletions() {
  return {
    [FIELD_KEY.gsdId]: { nodeId: 'FIELD_GSD_ID' },
    [FIELD_KEY.phase]: { nodeId: 'FIELD_PHASE' },
    [FIELD_KEY.requirements]: { nodeId: 'FIELD_REQUIREMENTS' },
    [FIELD_KEY.status]: { nodeId: 'FIELD_STATUS' },
    [BOOTSTRAP_LOGICAL_KEY.statusOption('Todo')]: { nodeId: 'OPTION_TODO' },
    [BOOTSTRAP_LOGICAL_KEY.statusOption('In Progress')]: { nodeId: 'OPTION_IN_PROGRESS' },
    [BOOTSTRAP_LOGICAL_KEY.statusOption('Done')]: { nodeId: 'OPTION_DONE' },
  };
}

const CONTEXT = { owner: 'octo', repo: 'repo', repositoryNumber: 42 };

function fieldIdOf(op) {
  return op.args.find((arg) => typeof arg === 'string' && arg.startsWith('fieldId=')).slice('fieldId='.length);
}
function queryOf(op) {
  return op.args.find((arg) => typeof arg === 'string' && arg.startsWith('query=')).slice('query='.length);
}

test('buildFieldValueOperations: a phase whose field state is unknown produces exactly four operations, in the order GSD ID, Phase, Requirements, Status', () => {
  const phase = { id: '04', title: 'Phase Four', goal: 'g', requirements: ['PHASE-01'], status: 'In Progress' };
  const result = buildFieldValueOperations(phase, ['gsdId', 'phaseId', 'requirements', 'status'], fieldBootstrapCompletions(), 'phase:04', CONTEXT);
  assert.deepEqual(result.blocked, []);
  assert.equal(result.operations.length, 4);
  assert.deepEqual(result.operations.map(fieldIdOf), ['FIELD_GSD_ID', 'FIELD_PHASE', 'FIELD_REQUIREMENTS', 'FIELD_STATUS']);
});

test('buildFieldValueOperations: a changed set of exactly one field ("status") produces exactly one operation, the status one', () => {
  const phase = { id: '04', title: 'Phase Four', goal: 'g', requirements: [], status: 'Done' };
  const result = buildFieldValueOperations(phase, ['status'], fieldBootstrapCompletions(), 'phase:04', CONTEXT);
  assert.equal(result.operations.length, 1);
  assert.equal(fieldIdOf(result.operations[0]), 'FIELD_STATUS');
});

test('buildFieldValueOperations: an empty changed set produces zero operations and zero blocked entries', () => {
  const phase = { id: '04', title: 'Phase Four', goal: 'g', requirements: [], status: 'Done' };
  const result = buildFieldValueOperations(phase, [], fieldBootstrapCompletions(), 'phase:04', CONTEXT);
  assert.deepEqual(result, { operations: [], blocked: [] });
});

test('planReconciliation: two phases both needing all four field writes produce eight operations grouped by phase, each phase\'s four contiguous and in the fixed order, phases in ascending id order', () => {
  const phaseA = { id: '02', title: 'A', goal: 'ga', requirements: ['PHASE-01'], status: 'Todo' };
  const phaseB = { id: '10', title: 'B', goal: 'gb', requirements: ['PHASE-02'], status: 'Done' };
  // Deliberately supplied out of id order: planReconciliation's own sort is
  // what must produce the ascending-id ordering guarantee, not input order.
  const desiredTwo = {
    available: true, reason: 'ok', currentPhase: '02',
    phases: [phaseB, phaseA],
    plans: [],
    milestones: [{ version: MILESTONE_VERSION, name: 'One', title: `${MILESTONE_VERSION} — One`, description: 'd', archived: false }],
  };
  const hashA = contentHash({ title: phaseA.title, region: renderPhaseRegion(phaseA), milestoneNumber: 3 });
  const hashB = contentHash({ title: phaseB.title, region: renderPhaseRegion(phaseB), milestoneNumber: 3 });
  const remoteTwo = {
    available: true, reason: 'ok',
    target: { owner: 'octo', repo: 'repo', repositoryNumber: 42, projectNumber: 7, projectNodeId: 'PVT_proj_node_1' },
    items: [
      { id: 'item-02', content: { id: 'ISSUE_NODE_02', number: 20 } },
      { id: 'item-10', content: { id: 'ISSUE_NODE_10', number: 100 } },
    ],
    fields: [], subIssues: [], issueNodeIds: {},
  };
  const map = {
    kind: 'valid',
    map: {
      completions: {
        [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 },
        ...fieldBootstrapCompletions(),
        // Neither phase carries a fieldState at all (unknown -> all 4 changed).
        'phase:02': { nodeId: 'item-02', issueNumber: 20 },
        'issue:phase:02': { nodeId: 'ISSUE_NODE_02', issueNumber: 20, contentHash: hashA },
        'phase:10': { nodeId: 'item-10', issueNumber: 100 },
        'issue:phase:10': { nodeId: 'ISSUE_NODE_10', issueNumber: 100, contentHash: hashB },
      },
    },
  };

  const plan = planReconciliation(desiredTwo, remoteTwo, map);
  assert.deepEqual(plan.blocked, []);
  assert.deepEqual(plan.pendingIssueUpdates, []);
  assert.equal(plan.operations.length, 8);
  assert.deepEqual(plan.operations.map((op) => op.logicalKey), [
    'phase:02', 'phase:02', 'phase:02', 'phase:02',
    'phase:10', 'phase:10', 'phase:10', 'phase:10',
  ]);
  assert.deepEqual(plan.operations.map(fieldIdOf), [
    'FIELD_GSD_ID', 'FIELD_PHASE', 'FIELD_REQUIREMENTS', 'FIELD_STATUS',
    'FIELD_GSD_ID', 'FIELD_PHASE', 'FIELD_REQUIREMENTS', 'FIELD_STATUS',
  ]);
  // Only the last operation of each phase's four carries the field state.
  assert.deepEqual(plan.operations.map((op) => op.captures[0].plannerFields !== undefined), [
    false, false, false, true, false, false, false, true,
  ]);
});

test('buildFieldValueOperations: the three TEXT operations use the text document (wrapper key "text"); the status operation uses the single-select document (wrapper key "singleSelectOptionId")', () => {
  const phase = { id: '04', title: 'Phase Four', goal: 'g', requirements: ['R1'], status: 'Todo' };
  const result = buildFieldValueOperations(phase, ['gsdId', 'phaseId', 'requirements', 'status'], fieldBootstrapCompletions(), 'phase:04', CONTEXT);
  const [gsdIdOp, phaseOp, requirementsOp, statusOp] = result.operations;
  for (const op of [gsdIdOp, phaseOp, requirementsOp]) {
    assert.match(queryOf(op), /\{text:\$value\}/);
    assert.doesNotMatch(queryOf(op), /singleSelectOptionId/);
  }
  assert.match(queryOf(statusOp), /\{singleSelectOptionId:\$value\}/);
  assert.doesNotMatch(queryOf(statusOp), /\{text:\$value\}/);
});

test('buildFieldValueOperations: neither document declares a points-budget selection, and neither operation declares a points budget', () => {
  const phase = { id: '04', title: 'Phase Four', goal: 'g', requirements: ['R1'], status: 'Todo' };
  const result = buildFieldValueOperations(phase, ['gsdId', 'phaseId', 'requirements', 'status'], fieldBootstrapCompletions(), 'phase:04', CONTEXT);
  for (const op of result.operations) {
    assert.equal(op.hasPointsBudget, false);
    assert.equal(op.contentCreation, false);
    assert.doesNotMatch(queryOf(op), /rateLimit/);
  }
});

test('buildFieldValueOperations: every developer-sourced value (the phase id, the requirement list, the logical key) rides the raw value flag; no value rides the typed flag', () => {
  const phase = { id: '04', title: 'Phase Four', goal: 'g', requirements: ['R1', 'R2'], status: 'Todo' };
  const result = buildFieldValueOperations(phase, ['gsdId', 'phaseId', 'requirements', 'status'], fieldBootstrapCompletions(), 'phase:04', CONTEXT);
  for (const op of result.operations) {
    assert.equal(op.args.filter((arg) => arg === '-F').length, 0, 'no -F flag anywhere in a field-value operation');
  }
  const requirementsOp = result.operations[2];
  assert.ok(requirementsOp.args.includes('value=R1, R2'));
});

test('buildFieldValueOperations: the status operation\'s value is an ArgvRef resolving the option:status:<slug> completion\'s node id, not a literal name and not a literal id', () => {
  const phase = { id: '04', title: 'Phase Four', goal: 'g', requirements: [], status: 'Todo' };
  const completions = fieldBootstrapCompletions();
  const result = buildFieldValueOperations(phase, ['status'], completions, 'phase:04', CONTEXT);
  const [statusOp] = result.operations;
  const valueArg = statusOp.args.find((arg) => typeof arg === 'object' && arg.prefix === 'value=');
  assert.ok(valueArg, 'the status value must be an ArgvRef object, not a literal string');
  assert.deepEqual(valueArg, { from: BOOTSTRAP_LOGICAL_KEY.statusOption('Todo'), part: 'nodeId', prefix: 'value=' });
  assert.equal(statusOp.args.includes('value=Todo'), false, 'must not be a literal status name');
  assert.equal(statusOp.args.includes(`value=${completions[BOOTSTRAP_LOGICAL_KEY.statusOption('Todo')].nodeId}`), false, 'must not be a literal option id');
});

test('buildFieldValueOperations: the item id in every operation is an ArgvRef resolving from the phase\'s own project-item completion, and the project id resolves from the project completion', () => {
  const phase = { id: '04', title: 'Phase Four', goal: 'g', requirements: [], status: 'Todo' };
  const result = buildFieldValueOperations(phase, ['gsdId'], fieldBootstrapCompletions(), 'phase:04', CONTEXT);
  const [op] = result.operations;
  const itemIdArg = op.args.find((arg) => typeof arg === 'object' && arg.prefix === 'itemId=');
  assert.deepEqual(itemIdArg, { from: 'phase:04', part: 'nodeId', prefix: 'itemId=' });
  const projectIdArg = op.args.find((arg) => typeof arg === 'object' && arg.prefix === 'projectId=');
  assert.deepEqual(projectIdArg, { from: BOOTSTRAP_LOGICAL_KEY.project(), part: 'nodeId', prefix: 'projectId=' });
});

test('buildFieldValueOperations: Wave and Autonomous never produce an operation, even when both fields exist as completions in the map', () => {
  const phase = { id: '04', title: 'Phase Four', goal: 'g', requirements: [], status: 'Todo' };
  const completions = {
    ...fieldBootstrapCompletions(),
    [BOOTSTRAP_LOGICAL_KEY.field('Wave')]: { nodeId: 'FIELD_WAVE' },
    [BOOTSTRAP_LOGICAL_KEY.field('Autonomous')]: { nodeId: 'FIELD_AUTONOMOUS' },
  };
  const result = buildFieldValueOperations(phase, ['gsdId', 'phaseId', 'requirements', 'status'], completions, 'phase:04', CONTEXT);
  assert.equal(result.operations.length, 4);
  for (const op of result.operations) {
    assert.ok(!op.args.some((arg) => typeof arg === 'string' && (arg.includes('FIELD_WAVE') || arg.includes('FIELD_AUTONOMOUS'))));
  }
});

test('buildFieldValueOperations: a missing field:requirements completion produces zero operations and one typed blocked entry naming the unresolved field', () => {
  const phase = { id: '04', title: 'Phase Four', goal: 'g', requirements: ['R1'], status: 'Todo' };
  const completions = fieldBootstrapCompletions();
  delete completions[FIELD_KEY.requirements];
  const result = buildFieldValueOperations(phase, ['gsdId', 'phaseId', 'requirements', 'status'], completions, 'phase:04', CONTEXT);
  assert.deepEqual(result.operations, []);
  assert.deepEqual(result.blocked, [{ reason: OPERATION_REASON.FIELD_UNRESOLVED, detail: `${FIELD_KEY.requirements} has no resolved completion` }]);
});

test('buildFieldValueOperations: a missing option:status:<slug> completion for the phase\'s derived status produces zero operations and one typed blocked entry', () => {
  const phase = { id: '04', title: 'Phase Four', goal: 'g', requirements: [], status: 'Blocked' };
  const result = buildFieldValueOperations(phase, ['status'], fieldBootstrapCompletions(), 'phase:04', CONTEXT);
  assert.deepEqual(result.operations, []);
  assert.deepEqual(result.blocked, [{ reason: OPERATION_REASON.FIELD_UNRESOLVED, detail: `${BOOTSTRAP_LOGICAL_KEY.statusOption('Blocked')} has no resolved completion` }]);
});

test('planReconciliation: a phase whose field:requirements completion is absent produces zero field operations for that phase and one typed blocked entry — and does not suppress a sibling phase in the same run', () => {
  const phaseA = { id: '02', title: 'A', goal: 'ga', requirements: ['R1'], status: 'Todo' }; // unknown field state -> needs all four
  const phaseB = { id: '03', title: 'B', goal: 'gb', requirements: [], status: 'Done' }; // stale in status only
  const desiredTwo = {
    available: true, reason: 'ok', currentPhase: '02',
    phases: [phaseA, phaseB],
    plans: [],
    milestones: [{ version: MILESTONE_VERSION, name: 'One', title: `${MILESTONE_VERSION} — One`, description: 'd', archived: false }],
  };
  const hashA = contentHash({ title: phaseA.title, region: renderPhaseRegion(phaseA), milestoneNumber: 3 });
  const hashB = contentHash({ title: phaseB.title, region: renderPhaseRegion(phaseB), milestoneNumber: 3 });
  const remoteTwo = {
    available: true, reason: 'ok',
    target: { owner: 'octo', repo: 'repo', repositoryNumber: 42, projectNumber: 7, projectNodeId: 'PVT_proj_node_1' },
    items: [
      { id: 'item-02', content: { id: 'ISSUE_NODE_02', number: 20 } },
      { id: 'item-03', content: { id: 'ISSUE_NODE_03', number: 30 } },
    ],
    fields: [], subIssues: [], issueNodeIds: {},
  };
  const noRequirementsFieldCompletions = fieldBootstrapCompletions();
  delete noRequirementsFieldCompletions[FIELD_KEY.requirements];
  const staleStatusOnlyFieldState = renderFieldState({ gsdId: 'phase:03', phaseId: '03', requirements: [], status: 'Todo' });
  const map = {
    kind: 'valid',
    map: {
      completions: {
        [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 },
        ...noRequirementsFieldCompletions,
        'phase:02': { nodeId: 'item-02', issueNumber: 20 },
        'issue:phase:02': { nodeId: 'ISSUE_NODE_02', issueNumber: 20, contentHash: hashA },
        'phase:03': { nodeId: 'item-03', issueNumber: 30, fieldState: staleStatusOnlyFieldState },
        'issue:phase:03': { nodeId: 'ISSUE_NODE_03', issueNumber: 30, contentHash: hashB },
      },
    },
  };

  const plan = planReconciliation(desiredTwo, remoteTwo, map);
  assert.deepEqual(plan.blocked, [{ reason: OPERATION_REASON.FIELD_UNRESOLVED, detail: `${FIELD_KEY.requirements} has no resolved completion` }]);
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].logicalKey, 'phase:03');
  assert.equal(fieldIdOf(plan.operations[0]), 'FIELD_STATUS');
});

test('buildFieldValueOperations: a one-operation case still carries the field state on its own capture (the "last" operation is also the "only" operation)', () => {
  const phase = { id: '04', title: 'Phase Four', goal: 'g', requirements: [], status: 'Done' };
  const result = buildFieldValueOperations(phase, ['status'], fieldBootstrapCompletions(), 'phase:04', CONTEXT);
  assert.equal(result.operations.length, 1);
  assert.equal(typeof result.operations[0].captures[0].plannerFields.fieldState, 'string');
});

test('buildFieldValueOperations: every operation\'s capture is keyed on the phase\'s project-item key and declares both a node-id path and a number path', () => {
  const phase = { id: '04', title: 'Phase Four', goal: 'g', requirements: ['R1'], status: 'Todo' };
  const result = buildFieldValueOperations(phase, ['gsdId', 'phaseId', 'requirements', 'status'], fieldBootstrapCompletions(), 'phase:04', CONTEXT);
  for (const op of result.operations) {
    assert.equal(op.captures.length, 1);
    assert.equal(op.captures[0].kind, 'node');
    assert.equal(op.captures[0].logicalKey, 'phase:04');
    assert.ok(op.captures[0].nodeIdPath.length > 0);
    assert.ok(op.captures[0].numberPath.length > 0);
  }
});

// ─── Phase 5 (05-01 Task 1): plan-issue reconciliation, D-13's addSubIssue ─

test('planKeyFor/planIssueKeyFor: mirror phase:<id>/issue:phase:<id> namespacing, and never collide with each other for the same id', () => {
  assert.equal(planKeyFor('04-03'), 'plan:04-03');
  assert.equal(planIssueKeyFor('04-03'), 'issue:plan:04-03');
  assert.notEqual(planKeyFor('04-03'), planIssueKeyFor('04-03'));
});

test('ADD_SUB_ISSUE_DOCUMENT: pins the mutation name and its selected payload fields (the addProjectV2ItemById precedent for a mutation document never registered in the recorded-fixture contract)', () => {
  assert.match(ADD_SUB_ISSUE_DOCUMENT, /# github-sync:addSubIssue/);
  assert.match(ADD_SUB_ISSUE_DOCUMENT, /addSubIssue\(input:\{issueId:\$issueId,subIssueId:\$subIssueId\}\)/);
  assert.match(ADD_SUB_ISSUE_DOCUMENT, /issue \{ id \}/);
  assert.match(ADD_SUB_ISSUE_DOCUMENT, /subIssue \{ id number \}/);
});

test('buildCreatePlanIssueOperation: REST create carrying the rendered plan body, the gsd:plan label, and a late-bound milestone reference — never the typed flag for a plan-sourced string', () => {
  const plan = { id: '04-03', phaseId: '04', title: '04-03 — Splice a region', tasks: ['Task 1: First'], status: 'Todo' };
  const op = buildCreatePlanIssueOperation(plan, planIssueKeyFor(plan.id), MILESTONE_KEY, 'repos/octo/repo/issues', CONTEXT);

  assert.equal(op.transport, 'rest');
  assert.equal(op.action, 'create');
  assert.equal(op.contentCreation, true);
  assert.equal(op.args.filter((arg) => arg === '-F').length, 1, 'only the milestone reference rides the typed flag');
  const titleArg = op.args.find((arg) => typeof arg === 'string' && arg.startsWith('title='));
  assert.equal(titleArg, `title=${plan.title}`);
  const bodyArg = op.args.find((arg) => typeof arg === 'string' && arg.startsWith('body='));
  assert.ok(bodyArg.includes(renderPlanRegion({ id: plan.id, title: plan.title, status: plan.status, tasks: plan.tasks })));
  const labelArg = op.args.find((arg) => typeof arg === 'string' && arg.startsWith('labels[]='));
  assert.equal(labelArg, 'labels[]=gsd:plan');
  const milestoneArg = op.args.find((arg) => typeof arg === 'object' && arg.prefix === 'milestone=');
  assert.deepEqual(milestoneArg, { from: MILESTONE_KEY, part: 'number', prefix: 'milestone=' });
  assert.equal(op.captures[0].nodeIdPath, 'node_id');
  assert.equal(op.captures[0].numberPath, 'number');
});

test('buildAddSubIssueOperation: both issueId and subIssueId are late-bound ArgvRefs riding the raw -f flag, never the typed -F flag', () => {
  const op = buildAddSubIssueOperation('04-03', '04', CONTEXT);

  assert.equal(op.transport, 'graphql');
  assert.equal(op.action, 'link');
  assert.equal(op.logicalKey, 'issue:plan:04-03');
  assert.equal(op.args.filter((arg) => arg === '-F').length, 0);
  const issueIdArg = op.args.find((arg) => typeof arg === 'object' && arg.prefix === 'issueId=');
  assert.deepEqual(issueIdArg, { from: 'issue:phase:04', part: 'nodeId', prefix: 'issueId=' });
  const subIssueIdArg = op.args.find((arg) => typeof arg === 'object' && arg.prefix === 'subIssueId=');
  assert.deepEqual(subIssueIdArg, { from: 'issue:plan:04-03', part: 'nodeId', prefix: 'subIssueId=' });
  assert.equal(op.captures[0].nodeIdPath, 'addSubIssue.subIssue.id');
  assert.equal(op.captures[0].numberPath, 'addSubIssue.subIssue.number');
});

function planFixture(overrides = {}) {
  return { id: '04-03', phaseId: '04', title: '04-03 — Splice a region', tasks: ['Task 1: First'], status: 'Todo', ...overrides };
}

function desiredWithPlans(plans, phases = []) {
  return {
    available: true, reason: 'ok', currentPhase: null,
    phases,
    plans,
    milestones: [{ version: MILESTONE_VERSION, name: 'One', title: `${MILESTONE_VERSION} — One`, description: 'd', archived: false }],
  };
}

function remoteForPlans() {
  return {
    available: true, reason: 'ok',
    target: { owner: 'octo', repo: 'repo', repositoryNumber: 42, projectNumber: 7, projectNodeId: 'PVT_proj_node_1' },
    items: [], fields: [], subIssues: [], issueNodeIds: {},
  };
}

function mapWithPhaseIssue(phaseId, phaseIssueNodeId, extraCompletions = {}) {
  return {
    kind: 'valid',
    map: {
      completions: {
        [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 },
        [issueKeyFor(phaseId)]: { nodeId: phaseIssueNodeId, issueNumber: 40 },
        ...extraCompletions,
      },
    },
  };
}

test('planReconciliation: a plan with no issue:plan:<id> completion and a resolvable parent produces exactly three content-creating operations in order — REST create, addSubIssue, addProjectV2ItemById', () => {
  const plan = planFixture();
  const result = planReconciliation(desiredWithPlans([plan]), remoteForPlans(), mapWithPhaseIssue('04', 'I_node_phase_parent'));

  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.operations.map((op) => op.logicalKey), ['issue:plan:04-03', 'issue:plan:04-03', 'plan:04-03']);
  assert.deepEqual(result.operations.map((op) => op.transport), ['rest', 'graphql', 'graphql']);
});

test('planReconciliation: the create operation carries the freshly computed content hash on its planner fields, matching contentHash({title, region, milestoneNumber})', () => {
  const plan = planFixture();
  const result = planReconciliation(desiredWithPlans([plan]), remoteForPlans(), mapWithPhaseIssue('04', 'I_node_phase_parent'));

  const expectedHash = contentHash({
    title: plan.title,
    region: renderPlanRegion({ id: plan.id, title: plan.title, status: plan.status, tasks: plan.tasks }),
    milestoneNumber: 3,
  });
  assert.equal(result.operations[0].captures[0].plannerFields.contentHash, expectedHash);
});

test('planReconciliation: re-running with the same plan files on disk and the two completions present emits zero further create operations for that plan', () => {
  const plan = planFixture();
  const map = mapWithPhaseIssue('04', 'I_node_phase_parent', {
    [planIssueKeyFor('04-03')]: { nodeId: 'I_node_plan_already', issueNumber: 88 },
    [planKeyFor('04-03')]: { nodeId: 'PVTI_item_plan_already' },
  });

  const result = planReconciliation(desiredWithPlans([plan]), remoteForPlans(), map);

  assert.deepEqual(result.operations, []);
  assert.deepEqual(result.blocked, []);
});

test('planReconciliation: an unresolvable parent (no issue:phase:<phaseId> completion) emits zero operations and no blocked entry, in this tracer\'s scope', () => {
  const plan = planFixture();
  const map = { kind: 'valid', map: { completions: { [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 } } } };

  const result = planReconciliation(desiredWithPlans([plan]), remoteForPlans(), map);

  assert.deepEqual(result.operations, []);
  assert.deepEqual(result.blocked, []);
});

test('planReconciliation: an unresolvable milestone emits zero operations and no blocked entry for the plan, even with a resolvable parent', () => {
  const plan = planFixture();
  const map = { kind: 'valid', map: { completions: { [issueKeyFor('04')]: { nodeId: 'I_node_phase_parent', issueNumber: 40 } } } };

  const result = planReconciliation(desiredWithPlans([plan]), remoteForPlans(), map);

  assert.deepEqual(result.operations, []);
  assert.deepEqual(result.blocked, []);
});

test('planReconciliation: with zero PLAN.md files on disk (an empty plans array), the reconciler emits zero plan operations, records no blocked entry attributable to plans, and does not fail the run', () => {
  const result = planReconciliation(desiredWithPlans([]), remoteForPlans(), mapWithPhaseIssue('04', 'I_node_phase_parent'));

  assert.deepEqual(result.operations, []);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.uncertain, []);
});

test('planReconciliation: two plans whose ids sort adjacently each map to their own sub-issue — no two plans ever share one issue:plan:<id> logical key', () => {
  const planA = planFixture({ id: '04-02', title: '04-02 — Earlier plan' });
  const planB = planFixture({ id: '04-03', title: '04-03 — Later plan' });
  const result = planReconciliation(desiredWithPlans([planB, planA]), remoteForPlans(), mapWithPhaseIssue('04', 'I_node_phase_parent'));

  assert.deepEqual(result.blocked, []);
  const planIssueKeys = result.operations.filter((op) => op.logicalKey.startsWith('issue:plan:')).map((op) => op.logicalKey);
  // Ascending plan id order, regardless of desired.plans' own input order.
  assert.deepEqual(planIssueKeys, ['issue:plan:04-02', 'issue:plan:04-02', 'issue:plan:04-03', 'issue:plan:04-03']);
  assert.equal(new Set(planIssueKeys).size, 2, 'exactly two distinct issue:plan:<id> logical keys, never shared');
});

test('planReconciliation: every phase create operation appears at a lower index than every plan create operation, when both are present in the same run', () => {
  const newPhase = { id: '04', title: 'Phase Four', goal: 'g4', requirements: [], status: 'Todo' };
  // The plan's own parent (phase 02) is already resolved from a prior run —
  // decoupled from `newPhase` (04) so this test isolates the phase-loop
  // vs. plan-loop structural ordering from D-13's same-run parent-resolution
  // question, which plan 05-05 owns.
  const plan = planFixture({ id: '02-05', phaseId: '02', title: '02-05 — Plan under an existing phase' });
  const plannedDesired = {
    available: true, reason: 'ok', currentPhase: '04',
    phases: [newPhase],
    plans: [plan],
    milestones: [{ version: MILESTONE_VERSION, name: 'One', title: `${MILESTONE_VERSION} — One`, description: 'd', archived: false }],
  };
  const map = {
    kind: 'valid',
    map: {
      completions: {
        [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 },
        ...fieldBootstrapCompletions(),
        [issueKeyFor('02')]: { nodeId: 'I_node_phase_02', issueNumber: 20 },
      },
    },
  };

  const result = planReconciliation(plannedDesired, remoteForPlans(), map);

  assert.deepEqual(result.blocked, []);
  assert.equal(result.operations.length, 9, 'six for phase 04\'s create, three for the plan\'s create');
  const phaseOps = result.operations.slice(0, 6);
  const planOps = result.operations.slice(6);
  assert.ok(phaseOps.every((op) => op.logicalKey === 'phase:04' || op.logicalKey === 'issue:phase:04'));
  assert.deepEqual(planOps.map((op) => op.logicalKey), ['issue:plan:02-05', 'issue:plan:02-05', 'plan:02-05']);
});
