/* Pure reconciliation tests: supplied JSON-safe inputs only, no disk or transport. */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  planReconciliation, OPERATION_KIND, OPERATION_REASON, issueKeyFor,
  buildFieldValueOperations, buildPlanFieldValueOperations, PLAN_FIELD_VALUE_SPEC,
  planKeyFor, planIssueKeyFor, buildCreatePlanIssueOperation, buildAddSubIssueOperation, ADD_SUB_ISSUE_DOCUMENT,
  UPDATE_FIELD_VALUE_NUMBER_DOCUMENT, bodyArgvEntry, buildPlanIssueStateOperation, PLAN_ISSUE_STATE,
  PLAN_SUB_ISSUE_LIMIT, PLAN_SUB_ISSUE_WARN_THRESHOLD,
} = require('../gsd-core/bin/lib/github-sync-reconcile.cjs');
const { GSD_LABELS, BOOTSTRAP_LOGICAL_KEY } = require('../gsd-core/bin/lib/github-sync-bootstrap-plan.cjs');
const {
  renderPhaseRegion, renderPlanRegion, renderNewPlanIssueBody, contentHash, renderFieldState, PLAN_FIELD_NAMES,
  DEPENDENCY_REF_SENTINEL,
} = require('../gsd-core/bin/lib/github-sync-issue-body.cjs');
const { resolveArgv } = require('../gsd-core/bin/lib/github-sync-operation.cjs');

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
    pendingIssueUpdates: [], orphans: [], pendingFieldChanges: [], subIssueCeilingWarnings: [],
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

// ─── Plan 05-07: the sub-issue-per-parent ceiling warning ─────────────────
//
// D-14: a phase whose parent issue's sub-issue count reaches the warn
// threshold (90) is reported by `planReconciliation`, computed entirely
// from `remote.subIssues` — the paginated read the run already performed —
// and never gates: the same run dispatches the same operations whether or
// not it warns.

/** Every returned node counts equally: no `state` field, no shape beyond `parentIssueNumber` is read by the count. */
function subIssuesForParent(parentIssueNumber, count) {
  return Array.from({ length: count }, (_, index) => ({ id: `SUBISSUE_${parentIssueNumber}_${index}`, number: 2000 + index, parentIssueNumber }));
}

test('PLAN_SUB_ISSUE_LIMIT and PLAN_SUB_ISSUE_WARN_THRESHOLD are exported with the values 100 and 90', () => {
  assert.equal(PLAN_SUB_ISSUE_LIMIT, 100);
  assert.equal(PLAN_SUB_ISSUE_WARN_THRESHOLD, 90);
});

test('a phase issue with 89 sub-issues produces no warning; the same phase with 90 produces one warning carrying the phase id, the parent issue number, the count, and the limit', () => {
  const phase = steadyPhase();
  const region = renderPhaseRegion(phase);
  const hash = contentHash({ title: phase.title, region, milestoneNumber: STEADY_MILESTONE_NUMBER });
  const fieldState = renderFieldState(steadyFieldValues(phase));
  const map = steadyMap({ contentHashValue: hash, fieldStateValue: fieldState });

  const below = planReconciliation(steadyDesired(phase), { ...steadyRemote(), subIssues: subIssuesForParent(55, 89) }, map);
  assert.deepEqual(below.subIssueCeilingWarnings, []);

  const at = planReconciliation(steadyDesired(phase), { ...steadyRemote(), subIssues: subIssuesForParent(55, 90) }, map);
  assert.deepEqual(at.subIssueCeilingWarnings, [{ phaseId: STEADY_ID, issueNumber: 55, count: 90, limit: PLAN_SUB_ISSUE_LIMIT }]);
});

test('counts of 99, 100, and 137 each produce a warning — the threshold is a floor, not an equality test', () => {
  const phase = steadyPhase();
  const region = renderPhaseRegion(phase);
  const hash = contentHash({ title: phase.title, region, milestoneNumber: STEADY_MILESTONE_NUMBER });
  const fieldState = renderFieldState(steadyFieldValues(phase));
  const map = steadyMap({ contentHashValue: hash, fieldStateValue: fieldState });

  for (const count of [99, 100, 137]) {
    const plan = planReconciliation(steadyDesired(phase), { ...steadyRemote(), subIssues: subIssuesForParent(55, count) }, map);
    assert.deepEqual(plan.subIssueCeilingWarnings, [{ phaseId: STEADY_ID, issueNumber: 55, count, limit: PLAN_SUB_ISSUE_LIMIT }], `expected a warning at count ${count}`);
  }
});

test('a phase with zero sub-issues produces no warning', () => {
  const phase = steadyPhase();
  const region = renderPhaseRegion(phase);
  const hash = contentHash({ title: phase.title, region, milestoneNumber: STEADY_MILESTONE_NUMBER });
  const fieldState = renderFieldState(steadyFieldValues(phase));
  const map = steadyMap({ contentHashValue: hash, fieldStateValue: fieldState });

  const plan = planReconciliation(steadyDesired(phase), steadyRemote(), map);
  assert.deepEqual(plan.subIssueCeilingWarnings, []);
});

test('a snapshot whose subIssues array is absent produces no warnings and no error', () => {
  const phase = steadyPhase();
  const region = renderPhaseRegion(phase);
  const hash = contentHash({ title: phase.title, region, milestoneNumber: STEADY_MILESTONE_NUMBER });
  const fieldState = renderFieldState(steadyFieldValues(phase));
  const map = steadyMap({ contentHashValue: hash, fieldStateValue: fieldState });
  const remoteNoSubIssuesField = steadyRemote();
  delete remoteNoSubIssuesField.subIssues;

  assert.doesNotThrow(() => planReconciliation(steadyDesired(phase), remoteNoSubIssuesField, map));
  const plan = planReconciliation(steadyDesired(phase), remoteNoSubIssuesField, map);
  assert.deepEqual(plan.subIssueCeilingWarnings, []);
});

test('sub-issues belonging to two different parents are counted separately, and only the over-threshold parent warns', () => {
  const two = steadyDesired(steadyPhase());
  two.phases = [
    { id: '04', title: 'Phase Four', goal: 'ship it', requirements: [], status: 'Todo' },
    { id: '06', title: 'Phase Six', goal: 'ship it too', requirements: [], status: 'Todo' },
  ];
  const map = {
    kind: 'valid',
    map: {
      completions: {
        [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: STEADY_MILESTONE_NUMBER },
        [issueKeyFor('04')]: { nodeId: 'ISSUE_NODE_04', issueNumber: 55 },
        'phase:04': { nodeId: 'item-04', issueNumber: 55 },
        [issueKeyFor('06')]: { nodeId: 'ISSUE_NODE_06', issueNumber: 66 },
        'phase:06': { nodeId: 'item-06', issueNumber: 66 },
      },
    },
  };
  const remoteTwo = { ...steadyRemote(), subIssues: [...subIssuesForParent(55, 40), ...subIssuesForParent(66, 91)] };

  const plan = planReconciliation(two, remoteTwo, map);
  assert.deepEqual(plan.subIssueCeilingWarnings, [{ phaseId: '06', issueNumber: 66, count: 91, limit: PLAN_SUB_ISSUE_LIMIT }]);
});

test('every returned sub-issue node counts, with no filtering by state or by whether the child is a known GSD plan', () => {
  const phase = steadyPhase();
  const region = renderPhaseRegion(phase);
  const hash = contentHash({ title: phase.title, region, milestoneNumber: STEADY_MILESTONE_NUMBER });
  const fieldState = renderFieldState(steadyFieldValues(phase));
  const map = steadyMap({ contentHashValue: hash, fieldStateValue: fieldState });
  // 90 nodes, none of which carry a `state`/`closed` field or any relation to
  // a known GSD plan id — the count is arithmetic over the node list alone.
  const unknownChildren = Array.from({ length: 90 }, (_, index) => ({ id: `RANDOM_${index}`, number: 3000 + index, parentIssueNumber: 55, isDraft: true, someOtherField: 'not a gsd plan' }));

  const plan = planReconciliation(steadyDesired(phase), { ...steadyRemote(), subIssues: unknownChildren }, map);
  assert.deepEqual(plan.subIssueCeilingWarnings, [{ phaseId: STEADY_ID, issueNumber: 55, count: 90, limit: PLAN_SUB_ISSUE_LIMIT }]);
});

test('the warnings array is always present on the reconciliation plan, empty when nothing applies, matching noops, blocked, and orphans', () => {
  const phase = steadyPhase();
  const region = renderPhaseRegion(phase);
  const hash = contentHash({ title: phase.title, region, milestoneNumber: STEADY_MILESTONE_NUMBER });
  const fieldState = renderFieldState(steadyFieldValues(phase));
  const map = steadyMap({ contentHashValue: hash, fieldStateValue: fieldState });

  const plan = planReconciliation(steadyDesired(phase), steadyRemote(), map);
  assert.ok(Array.isArray(plan.subIssueCeilingWarnings));
  assert.deepEqual(plan.subIssueCeilingWarnings, []);
});

test('a run that warns emits exactly the same operations as the same run with the count reduced below the threshold — the no-gate control', () => {
  const phase = steadyPhase({ status: 'Done' });
  const region = renderPhaseRegion(phase);
  const hash = contentHash({ title: phase.title, region, milestoneNumber: STEADY_MILESTONE_NUMBER });
  const staleFieldState = renderFieldState({ ...steadyFieldValues(phase), status: 'Todo' });
  const baseMap = steadyMap({ contentHashValue: hash, fieldStateValue: staleFieldState });
  const mapWithResolvedStatusField = {
    kind: 'valid',
    map: {
      completions: {
        ...baseMap.map.completions,
        'field:status': { nodeId: 'FIELD_STATUS' },
        'option:status:done': { nodeId: 'OPTION_DONE' },
      },
    },
  };

  const belowRemote = { ...steadyRemote(), subIssues: subIssuesForParent(55, PLAN_SUB_ISSUE_WARN_THRESHOLD - 1) };
  const aboveRemote = { ...steadyRemote(), subIssues: subIssuesForParent(55, PLAN_SUB_ISSUE_WARN_THRESHOLD) };

  const belowPlan = planReconciliation(steadyDesired(phase), belowRemote, mapWithResolvedStatusField);
  const abovePlan = planReconciliation(steadyDesired(phase), aboveRemote, mapWithResolvedStatusField);

  assert.ok(belowPlan.operations.length > 0, 'fixture must produce real operations for the no-gate control to be meaningful');
  assert.deepEqual(abovePlan.operations, belowPlan.operations);
  assert.deepEqual(abovePlan.blocked, belowPlan.blocked);
  assert.deepEqual(belowPlan.subIssueCeilingWarnings, []);
  assert.deepEqual(abovePlan.subIssueCeilingWarnings, [{ phaseId: STEADY_ID, issueNumber: 55, count: PLAN_SUB_ISSUE_WARN_THRESHOLD, limit: PLAN_SUB_ISSUE_LIMIT }]);
});

test('the sub-issue ceiling count requires no additional remote call — a plain JSON remote snapshot (stripped of any function/seam) is sufficient input', () => {
  const phase = steadyPhase();
  const region = renderPhaseRegion(phase);
  const hash = contentHash({ title: phase.title, region, milestoneNumber: STEADY_MILESTONE_NUMBER });
  const fieldState = renderFieldState(steadyFieldValues(phase));
  const map = steadyMap({ contentHashValue: hash, fieldStateValue: fieldState });
  const remoteWithWarning = { ...steadyRemote(), subIssues: subIssuesForParent(55, 90) };
  // A round trip through JSON strips any function/prototype the count could
  // only have obtained by calling out — proving the count is arithmetic over
  // plain data already in hand, not a fresh transport call.
  const plainRemote = JSON.parse(JSON.stringify(remoteWithWarning));

  const plan = planReconciliation(steadyDesired(phase), plainRemote, map);
  assert.deepEqual(plan.subIssueCeilingWarnings, [{ phaseId: STEADY_ID, issueNumber: 55, count: 90, limit: PLAN_SUB_ISSUE_LIMIT }]);
});

test('warning entries are emitted in ascending phase-id order (the same numeric-aware comparison the orphan pass uses) and are stable across runs', () => {
  const two = steadyDesired(steadyPhase());
  two.phases = [
    { id: '10', title: 'Phase Ten', goal: 'g', requirements: [], status: 'Todo' },
    { id: '2', title: 'Phase Two', goal: 'g', requirements: [], status: 'Todo' },
  ];
  const map = {
    kind: 'valid',
    map: {
      completions: {
        [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: STEADY_MILESTONE_NUMBER },
        [issueKeyFor('10')]: { nodeId: 'ISSUE_NODE_10', issueNumber: 110 },
        'phase:10': { nodeId: 'item-10', issueNumber: 110 },
        [issueKeyFor('2')]: { nodeId: 'ISSUE_NODE_2', issueNumber: 22 },
        'phase:2': { nodeId: 'item-2', issueNumber: 22 },
      },
    },
  };
  const remoteBoth = { ...steadyRemote(), subIssues: [...subIssuesForParent(110, 91), ...subIssuesForParent(22, 92)] };

  const first = planReconciliation(two, remoteBoth, map);
  const second = planReconciliation(two, remoteBoth, map);
  assert.deepEqual(first.subIssueCeilingWarnings.map((entry) => entry.phaseId), ['2', '10']);
  assert.deepEqual(first.subIssueCeilingWarnings, second.subIssueCeilingWarnings);
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

test('buildFieldValueOperations (the phase builder): passing "wave" and "autonomous" in the changed set alongside all four phase fields still produces exactly four operations — FIELD_VALUE_SPEC has no Wave/Autonomous member', () => {
  const phase = { id: '04', title: 'Phase Four', goal: 'g', requirements: ['R1'], status: 'Todo' };
  const result = buildFieldValueOperations(phase, ['gsdId', 'phaseId', 'requirements', 'status', 'wave', 'autonomous'], fieldBootstrapCompletions(), 'phase:04', CONTEXT);
  assert.equal(result.operations.length, 4);
  assert.deepEqual(result.operations.map(fieldIdOf), ['FIELD_GSD_ID', 'FIELD_PHASE', 'FIELD_REQUIREMENTS', 'FIELD_STATUS']);
});

// ─── Plan 05-05 Task 1: plan item field values (buildPlanFieldValueOperations) ─

const PLAN_FIELD_KEY = {
  gsdId: BOOTSTRAP_LOGICAL_KEY.field('GSD ID'),
  phase: BOOTSTRAP_LOGICAL_KEY.field('Phase'),
  requirements: BOOTSTRAP_LOGICAL_KEY.field('Requirements'),
  status: BOOTSTRAP_LOGICAL_KEY.field('Status'),
  wave: BOOTSTRAP_LOGICAL_KEY.field('Wave'),
  autonomous: BOOTSTRAP_LOGICAL_KEY.field('Autonomous'),
};

/** Plan 05-05: the six plan-item fields' own reserved-key completions a bootstrapped board (`init`) already recorded — the phase four plus the two new Wave/Autonomous ones. */
function planFieldBootstrapCompletions() {
  return {
    [PLAN_FIELD_KEY.gsdId]: { nodeId: 'FIELD_GSD_ID' },
    [PLAN_FIELD_KEY.phase]: { nodeId: 'FIELD_PHASE' },
    [PLAN_FIELD_KEY.requirements]: { nodeId: 'FIELD_REQUIREMENTS' },
    [PLAN_FIELD_KEY.status]: { nodeId: 'FIELD_STATUS' },
    [PLAN_FIELD_KEY.wave]: { nodeId: 'FIELD_WAVE' },
    [PLAN_FIELD_KEY.autonomous]: { nodeId: 'FIELD_AUTONOMOUS' },
    [BOOTSTRAP_LOGICAL_KEY.statusOption('Todo')]: { nodeId: 'OPTION_TODO' },
    [BOOTSTRAP_LOGICAL_KEY.statusOption('In Progress')]: { nodeId: 'OPTION_IN_PROGRESS' },
    [BOOTSTRAP_LOGICAL_KEY.statusOption('Done')]: { nodeId: 'OPTION_DONE' },
    [BOOTSTRAP_LOGICAL_KEY.autonomousOption('Yes')]: { nodeId: 'OPTION_AUTONOMOUS_YES' },
    [BOOTSTRAP_LOGICAL_KEY.autonomousOption('No')]: { nodeId: 'OPTION_AUTONOMOUS_NO' },
  };
}

function planFieldFixture(overrides = {}) {
  return {
    id: '04-03', phaseId: '04', title: '04-03 — Splice a region', tasks: ['Task 1: First'],
    status: 'Todo', wave: 3, autonomous: true, requirements: ['PLAN-01'],
    ...overrides,
  };
}

test('PLAN_FIELD_VALUE_SPEC: declares exactly six members in the fixed order GSD ID, Phase, Requirements, Status, Wave, Autonomous', () => {
  assert.deepEqual(PLAN_FIELD_VALUE_SPEC.map((entry) => entry.fieldName), ['gsdId', 'phaseId', 'requirements', 'status', 'wave', 'autonomous']);
  assert.deepEqual(PLAN_FIELD_VALUE_SPEC.map((entry) => entry.declaredName), ['GSD ID', 'Phase', 'Requirements', 'Status', 'Wave', 'Autonomous']);
});

test('UPDATE_FIELD_VALUE_NUMBER_DOCUMENT: declares a Float! variable and wraps the value under the "number" key, matching the createFieldNumber precedent\'s naming', () => {
  assert.match(UPDATE_FIELD_VALUE_NUMBER_DOCUMENT, /# github-sync:updateFieldValueNumber/);
  assert.match(UPDATE_FIELD_VALUE_NUMBER_DOCUMENT, /\$value:Float!/);
  assert.match(UPDATE_FIELD_VALUE_NUMBER_DOCUMENT, /value:\{number:\$value\}/);
  assert.match(UPDATE_FIELD_VALUE_NUMBER_DOCUMENT, /projectV2Item \{ id content \{ \.\.\. on Issue \{ number \} \} \}/);
  assert.doesNotMatch(UPDATE_FIELD_VALUE_NUMBER_DOCUMENT, /rateLimit/);
});

test('buildPlanFieldValueOperations: all six names changed emits six operations, in PLAN_FIELD_VALUE_SPEC\'s declared order', () => {
  const plan = planFieldFixture();
  const result = buildPlanFieldValueOperations(plan, [...PLAN_FIELD_NAMES], planFieldBootstrapCompletions(), 'plan:04-03', CONTEXT);
  assert.deepEqual(result.blocked, []);
  assert.equal(result.operations.length, 6);
  assert.deepEqual(result.operations.map(fieldIdOf), [
    'FIELD_GSD_ID', 'FIELD_PHASE', 'FIELD_REQUIREMENTS', 'FIELD_STATUS', 'FIELD_WAVE', 'FIELD_AUTONOMOUS',
  ]);
});

test('buildPlanFieldValueOperations: only the LAST of the six operations carries plannerFields.fieldState, serialized through the six-name variant', () => {
  const plan = planFieldFixture();
  const result = buildPlanFieldValueOperations(plan, [...PLAN_FIELD_NAMES], planFieldBootstrapCompletions(), 'plan:04-03', CONTEXT);
  assert.deepEqual(result.operations.map((op) => op.captures[0].plannerFields !== undefined), [false, false, false, false, false, true]);
  assert.deepEqual(JSON.parse(result.operations[5].captures[0].plannerFields.fieldState), {
    gsdId: 'plan:04-03', phaseId: '04', requirements: ['PLAN-01'], status: 'Todo', wave: 3, autonomous: true,
  });
});

test('buildPlanFieldValueOperations: the Status write is an ArgvRef resolving option:status:<slug>; the Autonomous write is an ArgvRef resolving option:autonomous:yes or option:autonomous:no — never a literal name, never a literal id', () => {
  const planTrue = planFieldFixture({ status: 'Done', autonomous: true });
  const resultTrue = buildPlanFieldValueOperations(planTrue, ['status', 'autonomous'], planFieldBootstrapCompletions(), 'plan:04-03', CONTEXT);
  const [statusOp, autonomousOp] = resultTrue.operations;
  const statusValueArg = statusOp.args.find((arg) => typeof arg === 'object' && arg.prefix === 'value=');
  assert.deepEqual(statusValueArg, { from: BOOTSTRAP_LOGICAL_KEY.statusOption('Done'), part: 'nodeId', prefix: 'value=' });
  assert.equal(statusOp.args.includes('value=Done'), false);
  const autonomousValueArgYes = autonomousOp.args.find((arg) => typeof arg === 'object' && arg.prefix === 'value=');
  assert.deepEqual(autonomousValueArgYes, { from: BOOTSTRAP_LOGICAL_KEY.autonomousOption('Yes'), part: 'nodeId', prefix: 'value=' });

  const planFalse = planFieldFixture({ autonomous: false });
  const resultFalse = buildPlanFieldValueOperations(planFalse, ['autonomous'], planFieldBootstrapCompletions(), 'plan:04-03', CONTEXT);
  const autonomousValueArgNo = resultFalse.operations[0].args.find((arg) => typeof arg === 'object' && arg.prefix === 'value=');
  assert.deepEqual(autonomousValueArgNo, { from: BOOTSTRAP_LOGICAL_KEY.autonomousOption('No'), part: 'nodeId', prefix: 'value=' });
});

test('buildPlanFieldValueOperations: the three text writes carry literal values — the plan\'s own logical key, its phase id as it appears on disk, and its requirement ids joined by ", "', () => {
  const plan = planFieldFixture({ requirements: ['PLAN-01', 'PLAN-05'] });
  const result = buildPlanFieldValueOperations(plan, ['gsdId', 'phaseId', 'requirements'], planFieldBootstrapCompletions(), 'plan:04-03', CONTEXT);
  assert.ok(result.operations[0].args.includes('value=plan:04-03'));
  assert.ok(result.operations[1].args.includes('value=04'));
  assert.ok(result.operations[2].args.includes('value=PLAN-01, PLAN-05'));
});

test('buildPlanFieldValueOperations: a null wave emits five operations, omitting the Wave write, and the recorded field state still reflects the null', () => {
  const plan = planFieldFixture({ wave: null });
  const result = buildPlanFieldValueOperations(plan, [...PLAN_FIELD_NAMES], planFieldBootstrapCompletions(), 'plan:04-03', CONTEXT);
  assert.deepEqual(result.blocked, []);
  assert.equal(result.operations.length, 5);
  assert.deepEqual(result.operations.map(fieldIdOf), ['FIELD_GSD_ID', 'FIELD_PHASE', 'FIELD_REQUIREMENTS', 'FIELD_STATUS', 'FIELD_AUTONOMOUS']);
  const lastCapture = result.operations[4].captures[0];
  assert.equal(JSON.parse(lastCapture.plannerFields.fieldState).wave, null);
});

test('buildPlanFieldValueOperations: an empty requirements list emits the Requirements write with an empty text value, never a skip', () => {
  const plan = planFieldFixture({ requirements: [] });
  const result = buildPlanFieldValueOperations(plan, ['requirements'], planFieldBootstrapCompletions(), 'plan:04-03', CONTEXT);
  assert.equal(result.operations.length, 1);
  assert.ok(result.operations[0].args.includes('value='));
});

test('buildPlanFieldValueOperations: an absent field:wave completion returns zero operations and one field_unresolved blocked entry naming that key', () => {
  const plan = planFieldFixture();
  const completions = planFieldBootstrapCompletions();
  delete completions[PLAN_FIELD_KEY.wave];
  const result = buildPlanFieldValueOperations(plan, [...PLAN_FIELD_NAMES], completions, 'plan:04-03', CONTEXT);
  assert.deepEqual(result.operations, []);
  assert.deepEqual(result.blocked, [{ reason: OPERATION_REASON.FIELD_UNRESOLVED, detail: `${PLAN_FIELD_KEY.wave} has no resolved completion` }]);
});

test('buildPlanFieldValueOperations: an absent option:autonomous:yes completion returns zero operations and one field_unresolved blocked entry naming that key', () => {
  const plan = planFieldFixture({ autonomous: true });
  const completions = planFieldBootstrapCompletions();
  delete completions[BOOTSTRAP_LOGICAL_KEY.autonomousOption('Yes')];
  const result = buildPlanFieldValueOperations(plan, ['autonomous'], completions, 'plan:04-03', CONTEXT);
  assert.deepEqual(result.operations, []);
  assert.deepEqual(result.blocked, [{ reason: OPERATION_REASON.FIELD_UNRESOLVED, detail: `${BOOTSTRAP_LOGICAL_KEY.autonomousOption('Yes')} has no resolved completion` }]);
});

test('buildPlanFieldValueOperations: two plans sharing a Wave value each produce their own six operations against their own item logical key — no convergence onto one item', () => {
  const planA = planFieldFixture({ id: '02-01', phaseId: '02', wave: 3 });
  const planB = planFieldFixture({ id: '02-02', phaseId: '02', wave: 3 });
  const resultA = buildPlanFieldValueOperations(planA, [...PLAN_FIELD_NAMES], planFieldBootstrapCompletions(), 'plan:02-01', CONTEXT);
  const resultB = buildPlanFieldValueOperations(planB, [...PLAN_FIELD_NAMES], planFieldBootstrapCompletions(), 'plan:02-02', CONTEXT);
  assert.equal(resultA.operations.length, 6);
  assert.equal(resultB.operations.length, 6);
  assert.ok(resultA.operations.every((op) => op.logicalKey === 'plan:02-01'));
  assert.ok(resultB.operations.every((op) => op.logicalKey === 'plan:02-02'));
});

test('buildPlanFieldValueOperations: the Wave write uses the NUMBER document and carries a validated integer literal on the typed flag (LIVE FINDING 05-08: GraphQL Float! rejects the raw-string encoding)', () => {
  const plan = planFieldFixture({ wave: 7 });
  const result = buildPlanFieldValueOperations(plan, ['wave'], planFieldBootstrapCompletions(), 'plan:04-03', CONTEXT);
  assert.equal(result.operations.length, 1);
  assert.match(queryOf(result.operations[0]), /value:\{number:\$value\}/);
  const args = result.operations[0].args;
  const valueIndex = args.indexOf('value=7');
  assert.ok(valueIndex > 0, 'value=7 present in args');
  assert.equal(args[valueIndex - 1], '-F', 'Wave rides the typed flag so GitHub can coerce it to Float!');
  assert.equal(args.filter((arg) => arg === '-F').length, 1, 'exactly one -F flag on this operation (the Wave value only)');
});

test('buildPlanFieldValueOperations: no field-write operation\'s query= argv entry contains any plan title, task name, requirement id, or phase id text (T-5-01 injection control)', () => {
  const plan = planFieldFixture({
    title: 'INJECTED_TITLE <script>alert(1)</script>',
    tasks: ['INJECTED_TASK'],
    requirements: ['INJECTED-REQ'],
    phaseId: 'INJECTED_PHASE',
  });
  const result = buildPlanFieldValueOperations(plan, [...PLAN_FIELD_NAMES], planFieldBootstrapCompletions(), 'plan:04-03', CONTEXT);
  for (const op of result.operations) {
    const query = queryOf(op);
    assert.doesNotMatch(query, /INJECTED_TITLE/);
    assert.doesNotMatch(query, /INJECTED_TASK/);
    assert.doesNotMatch(query, /INJECTED-REQ/);
    assert.doesNotMatch(query, /INJECTED_PHASE/);
  }
});

test('buildPlanFieldValueOperations: an empty changed set produces zero operations and zero blocked entries', () => {
  const plan = planFieldFixture();
  const result = buildPlanFieldValueOperations(plan, [], planFieldBootstrapCompletions(), 'plan:04-03', CONTEXT);
  assert.deepEqual(result, { operations: [], blocked: [] });
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
  const fullBody = renderNewPlanIssueBody({ id: plan.id, title: plan.title, status: plan.status, tasks: plan.tasks });
  const bodyResult = bodyArgvEntry(fullBody, []);
  assert.equal(bodyResult.kind, 'ok');
  const op = buildCreatePlanIssueOperation(plan, planIssueKeyFor(plan.id), MILESTONE_KEY, 'repos/octo/repo/issues', CONTEXT, bodyResult.entry);

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

test('planReconciliation: a plan with no issue:plan:<id> completion, a resolvable parent, and a resolvable milestone but no plan-item field completions produces the three create operations plus one field_unresolved blocked entry — mirroring the phase precedent, zero partial field writes', () => {
  const plan = planFixture();
  const result = planReconciliation(desiredWithPlans([plan]), remoteForPlans(), mapWithPhaseIssue('04', 'I_node_phase_parent'));

  assert.deepEqual(result.operations.map((op) => op.logicalKey), ['issue:plan:04-03', 'issue:plan:04-03', 'plan:04-03']);
  assert.deepEqual(result.operations.map((op) => op.transport), ['rest', 'graphql', 'graphql']);
  assert.deepEqual(result.blocked, [{ reason: OPERATION_REASON.FIELD_UNRESOLVED, detail: `${PLAN_FIELD_KEY.gsdId} has no resolved completion` }]);
});

test('planReconciliation: the same plan, with plan-item field completions also seeded, produces the three create operations plus the full field-write set (five: Wave omitted since unset) and zero blocked entries', () => {
  const plan = planFixture();
  const map = mapWithPhaseIssue('04', 'I_node_phase_parent', planFieldBootstrapCompletions());
  const result = planReconciliation(desiredWithPlans([plan]), remoteForPlans(), map);

  assert.deepEqual(result.blocked, []);
  assert.equal(result.operations.length, 8, 'three create operations plus five field writes (gsdId, phaseId, requirements, status, autonomous)');
  assert.deepEqual(result.operations.slice(0, 3).map((op) => op.logicalKey), ['issue:plan:04-03', 'issue:plan:04-03', 'plan:04-03']);
  assert.ok(result.operations.slice(3).every((op) => op.logicalKey === 'plan:04-03'));
});

test('planReconciliation: the addSubIssue operation (the LAST write to issue:plan:<id> within the run) carries the freshly computed content hash on its planner fields, matching contentHash({title, region, milestoneNumber}) — never the preceding create\'s own capture, which recordCompletion would otherwise wipe', () => {
  const plan = planFixture();
  const result = planReconciliation(desiredWithPlans([plan]), remoteForPlans(), mapWithPhaseIssue('04', 'I_node_phase_parent'));

  const expectedHash = contentHash({
    title: plan.title,
    region: renderPlanRegion({ id: plan.id, title: plan.title, status: plan.status, tasks: plan.tasks }),
    milestoneNumber: 3,
  });
  assert.equal(result.operations[0].captures[0].plannerFields, undefined, 'the create operation itself must carry no plannerFields');
  assert.equal(result.operations[1].kind, 'add-sub-issue');
  assert.equal(result.operations[1].captures[0].plannerFields.contentHash, expectedHash);
});

test('planReconciliation: a plan with no completion whose parent phase carries no issue:phase:<phaseId> completion and is not created earlier in the same run emits zero operations and one parent_unresolved blocked entry naming the plan', () => {
  const plan = planFixture();
  const map = { kind: 'valid', map: { completions: { [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 } } } };

  const result = planReconciliation(desiredWithPlans([plan]), remoteForPlans(), map);

  assert.deepEqual(result.operations, []);
  assert.deepEqual(result.blocked, [{ reason: OPERATION_REASON.PARENT_UNRESOLVED, detail: 'plan:04-03' }]);
});

test('planReconciliation: a plan whose parent phase IS created earlier in the same run emits its three operations, and the same fixture with the phase already bound-and-completed also emits them — proving both parent sources resolve', () => {
  const newPhase = { id: '04', title: 'Phase Four', goal: 'g4', requirements: [], status: 'Todo' };
  const plan = planFixture();
  const desiredSameRunCreate = {
    available: true, reason: 'ok', currentPhase: '04',
    phases: [newPhase],
    plans: [plan],
    milestones: [{ version: MILESTONE_VERSION, name: 'One', title: `${MILESTONE_VERSION} — One`, description: 'd', archived: false }],
  };
  const mapSameRunCreate = { kind: 'valid', map: { completions: { [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 }, ...planFieldBootstrapCompletions() } } };

  const sameRunResult = planReconciliation(desiredSameRunCreate, remoteForPlans(), mapSameRunCreate);
  assert.deepEqual(sameRunResult.blocked, []);
  const sameRunPlanOps = sameRunResult.operations.filter((op) => op.logicalKey.startsWith('issue:plan:') || op.logicalKey.startsWith('plan:'));
  assert.deepEqual(sameRunPlanOps.slice(0, 3).map((op) => op.logicalKey), ['issue:plan:04-03', 'issue:plan:04-03', 'plan:04-03']);

  // Same plan, but the phase is already bound-and-completed from a prior run
  // instead of being created in this same run.
  const mapPriorRun = mapWithPhaseIssue('04', 'I_node_phase_parent', planFieldBootstrapCompletions());
  const priorRunResult = planReconciliation(desiredWithPlans([plan]), remoteForPlans(), mapPriorRun);
  assert.deepEqual(priorRunResult.blocked, []);
  assert.deepEqual(priorRunResult.operations.slice(0, 3).map((op) => op.logicalKey), ['issue:plan:04-03', 'issue:plan:04-03', 'plan:04-03']);
});

test('planReconciliation: a plan with a resolvable parent but no resolvable milestone emits zero operations and one milestone_unresolved blocked entry', () => {
  const plan = planFixture();
  const map = { kind: 'valid', map: { completions: { [issueKeyFor('04')]: { nodeId: 'I_node_phase_parent', issueNumber: 40 } } } };

  const result = planReconciliation(desiredWithPlans([plan]), remoteForPlans(), map);

  assert.deepEqual(result.operations, []);
  assert.deepEqual(result.blocked, [{ reason: OPERATION_REASON.MILESTONE_UNRESOLVED, detail: 'plan:04-03' }]);
});

test('planReconciliation: one plan blocked on an unresolved parent never suppresses a sibling plan\'s operations in the same run', () => {
  const blockedPlan = planFixture({ id: '09-01', phaseId: '09', title: '09-01 — No parent yet' });
  const okPlan = planFixture({ id: '04-03', phaseId: '04' });
  const map = mapWithPhaseIssue('04', 'I_node_phase_parent', planFieldBootstrapCompletions());

  const result = planReconciliation(desiredWithPlans([blockedPlan, okPlan]), remoteForPlans(), map);

  assert.deepEqual(result.blocked, [{ reason: OPERATION_REASON.PARENT_UNRESOLVED, detail: 'plan:09-01' }]);
  const okOps = result.operations.filter((op) => op.logicalKey.includes('04-03'));
  assert.ok(okOps.length > 0, 'the sibling plan with a resolvable parent must still emit its operations');
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
  const map = mapWithPhaseIssue('04', 'I_node_phase_parent', planFieldBootstrapCompletions());
  const result = planReconciliation(desiredWithPlans([planB, planA]), remoteForPlans(), map);

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
  // question, which the two tests above cover directly.
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
        ...planFieldBootstrapCompletions(),
        [issueKeyFor('02')]: { nodeId: 'I_node_phase_02', issueNumber: 20 },
      },
    },
  };

  const result = planReconciliation(plannedDesired, remoteForPlans(), map);

  assert.deepEqual(result.blocked, []);
  const phaseCreateIndex = Math.max(...result.operations.map((op, index) => (op.kind === 'create-issue' ? index : -1)));
  const planCreateIndex = Math.min(...result.operations.map((op, index) => (op.kind === 'create-plan-issue' ? index : Infinity)));
  assert.ok(phaseCreateIndex >= 0, 'expected a phase create-issue operation');
  assert.ok(planCreateIndex < Infinity, 'expected a plan create-plan-issue operation');
  assert.ok(phaseCreateIndex < planCreateIndex, 'every phase create must appear at a lower index than every plan create');
});

// ─── Plan 05-05 Task 2: the full per-plan decision order (bound/pending-update/pending-field-change/bind/converged) ─

const PLAN_STEADY_ID = '04-03';
const PLAN_STEADY_LOGICAL_KEY = planKeyFor(PLAN_STEADY_ID);
const PLAN_STEADY_ISSUE_KEY = planIssueKeyFor(PLAN_STEADY_ID);
const PLAN_STEADY_MILESTONE_NUMBER = 3;

function steadyPlan(overrides = {}) {
  return {
    id: PLAN_STEADY_ID, phaseId: '04', title: '04-03 — Splice a region', tasks: ['Task 1: First'],
    status: 'In Progress', wave: 2, autonomous: true, requirements: ['PLAN-01'],
    ...overrides,
  };
}

function steadyPlanDesired(plan) {
  return {
    available: true, reason: 'ok', currentPhase: null,
    phases: [], plans: [plan],
    milestones: [{ version: MILESTONE_VERSION, name: 'One', title: `${MILESTONE_VERSION} — One`, description: 'd', archived: false }],
  };
}

function steadyPlanRemote() {
  return {
    available: true, reason: 'ok',
    target: { owner: 'octo', repo: 'repo', repositoryNumber: 42, projectNumber: 7, projectNodeId: 'PVT_proj_node_1' },
    items: [{ id: 'item-plan-0403', content: { id: 'ISSUE_NODE_PLAN_0403', number: 88 } }],
    fields: [], subIssues: [], issueNodeIds: {},
  };
}

function steadyPlanFieldValues(plan) {
  return { gsdId: PLAN_STEADY_LOGICAL_KEY, phaseId: plan.phaseId, requirements: plan.requirements ?? [], status: plan.status ?? '', wave: plan.wave ?? null, autonomous: plan.autonomous ?? false };
}

function steadyPlanMap({ contentHashValue, fieldStateValue, issueStateValue, milestoneNumber = PLAN_STEADY_MILESTONE_NUMBER } = {}) {
  return {
    kind: 'valid',
    map: {
      completions: {
        [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: milestoneNumber },
        [PLAN_STEADY_LOGICAL_KEY]: { nodeId: 'item-plan-0403', issueNumber: 88, ...(fieldStateValue !== undefined ? { fieldState: fieldStateValue } : {}) },
        [PLAN_STEADY_ISSUE_KEY]: {
          nodeId: 'ISSUE_NODE_PLAN_0403', issueNumber: 88,
          ...(contentHashValue !== undefined ? { contentHash: contentHashValue } : {}),
          ...(issueStateValue !== undefined ? { issueState: issueStateValue } : {}),
        },
      },
    },
  };
}

test('planReconciliation: a converged plan (equal content hash, equal field state) contributes exactly one no-op and zero operations', () => {
  const plan = steadyPlan();
  const region = renderPlanRegion({ id: plan.id, title: plan.title, status: plan.status, tasks: plan.tasks });
  const hash = contentHash({ title: plan.title, region, milestoneNumber: PLAN_STEADY_MILESTONE_NUMBER });
  const fieldState = renderFieldState(steadyPlanFieldValues(plan), PLAN_FIELD_NAMES);
  const map = steadyPlanMap({ contentHashValue: hash, fieldStateValue: fieldState, issueStateValue: 'open' });

  const result = planReconciliation(steadyPlanDesired(plan), steadyPlanRemote(), map);
  assert.deepEqual(result.operations, []);
  assert.deepEqual(result.pendingIssueUpdates, []);
  assert.deepEqual(result.pendingFieldChanges, []);
  assert.deepEqual(result.noops, [{ logicalKey: PLAN_STEADY_LOGICAL_KEY }]);
  assert.deepEqual(result.blocked, []);
});

test('planReconciliation: a stored content hash that differs from the freshly computed one produces zero operations and one pending update entry carrying the full projection', () => {
  const plan = steadyPlan();
  const region = renderPlanRegion({ id: plan.id, title: plan.title, status: plan.status, tasks: plan.tasks });
  const hash = contentHash({ title: plan.title, region, milestoneNumber: PLAN_STEADY_MILESTONE_NUMBER });
  const fieldState = renderFieldState(steadyPlanFieldValues(plan), PLAN_FIELD_NAMES);
  const map = steadyPlanMap({ contentHashValue: 'stale-plan-hash', fieldStateValue: fieldState, issueStateValue: 'open' });

  const result = planReconciliation(steadyPlanDesired(plan), steadyPlanRemote(), map);
  assert.deepEqual(result.operations, []);
  assert.equal(result.pendingIssueUpdates.length, 1);
  assert.deepEqual(result.pendingIssueUpdates[0], {
    logicalKey: PLAN_STEADY_LOGICAL_KEY,
    issueKey: PLAN_STEADY_ISSUE_KEY,
    issueNumber: 88,
    issueNodeId: 'ISSUE_NODE_PLAN_0403',
    title: plan.title,
    region,
    milestoneNumber: PLAN_STEADY_MILESTONE_NUMBER,
    milestoneKey: MILESTONE_KEY,
    contentHash: hash,
    completionContext: { owner: 'octo', repo: 'repo', repositoryNumber: 42 },
    dependsOn: [],
  });
});

test('planReconciliation: a matching content hash but a differing field state produces a field-change entry and no pending update — the two units converge independently', () => {
  const plan = steadyPlan();
  const region = renderPlanRegion({ id: plan.id, title: plan.title, status: plan.status, tasks: plan.tasks });
  const hash = contentHash({ title: plan.title, region, milestoneNumber: PLAN_STEADY_MILESTONE_NUMBER });
  const staleFieldState = renderFieldState({ ...steadyPlanFieldValues(plan), wave: 999 }, PLAN_FIELD_NAMES);
  const map = steadyPlanMap({ contentHashValue: hash, fieldStateValue: staleFieldState, issueStateValue: 'open' });

  const result = planReconciliation(steadyPlanDesired(plan), steadyPlanRemote(), map);
  assert.deepEqual(result.pendingIssueUpdates, []);
  assert.deepEqual(result.operations, []);
  assert.deepEqual(result.pendingFieldChanges, [{ logicalKey: PLAN_STEADY_LOGICAL_KEY, changed: ['wave'] }]);
});

test('planReconciliation: a plan bound on the board with no issue:plan:<id> completion is a plain no-op, mirroring the phase loop\'s pre-migration case', () => {
  const plan = steadyPlan();
  const map = { kind: 'valid', map: { completions: { [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: PLAN_STEADY_MILESTONE_NUMBER }, [PLAN_STEADY_LOGICAL_KEY]: { nodeId: 'item-plan-0403', issueNumber: 88 } } } };
  const result = planReconciliation(steadyPlanDesired(plan), steadyPlanRemote(), map);
  assert.deepEqual(result.noops, [{ logicalKey: PLAN_STEADY_LOGICAL_KEY }]);
  assert.deepEqual(result.operations, []);
  assert.deepEqual(result.blocked, []);
});

test('planReconciliation: a plan with an issue:plan:<id> completion but no board binding emits one add-to-board operation and no create', () => {
  const plan = steadyPlan();
  const map = { kind: 'valid', map: { completions: { [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 }, [PLAN_STEADY_ISSUE_KEY]: { nodeId: 'ISSUE_NODE_PLAN_0403', issueNumber: 88 } } } };
  const result = planReconciliation(steadyPlanDesired(plan), remoteForPlans(), map);
  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0].kind, 'create');
  assert.equal(result.operations[0].logicalKey, PLAN_STEADY_LOGICAL_KEY);
  assert.ok(result.operations[0].args.includes('contentId=ISSUE_NODE_PLAN_0403'));
  assert.deepEqual(result.noops, []);
  assert.deepEqual(result.blocked, []);
});

// ─── Plan 05-05 Task 3: plan orphans, reported by name, never acted on ────

test('planReconciliation: a plan:<id> completion whose id is absent from the desired plan set produces one orphan entry keyed plan:<id>', () => {
  const plan = planFixture();
  const map = mapWithPhaseIssue('04', 'I_node_phase_parent', {
    ...planFieldBootstrapCompletions(),
    'plan:09-09': { nodeId: 'item-orphan-plan', issueNumber: 500 },
  });
  const result = planReconciliation(desiredWithPlans([plan]), remoteForPlans(), map);
  assert.deepEqual(result.orphans.filter((entry) => entry.logicalKey === 'plan:09-09'), [{ logicalKey: 'plan:09-09', issueNumber: 500 }]);
});

test('planReconciliation: a deleted plan with both plan:<id> and issue:plan:<id> completions produces exactly one orphan entry carrying the issue number, whichever completion carries it', () => {
  const map = {
    kind: 'valid',
    map: {
      completions: {
        [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 },
        'plan:09-09': { nodeId: 'item-orphan-plan' },
        'issue:plan:09-09': { nodeId: 'ISSUE_orphan_plan', issueNumber: 500 },
      },
    },
  };
  const result = planReconciliation(desiredWithPlans([]), remoteForPlans(), map);
  assert.deepEqual(result.orphans, [{ logicalKey: 'plan:09-09', issueNumber: 500 }]);
});

test('planReconciliation: a phase:<id> completion is still reported under the phase namespace, unchanged, alongside a plan orphan in the same run', () => {
  const map = {
    kind: 'valid',
    map: {
      completions: {
        [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 },
        'phase:09': { nodeId: 'item-09', issueNumber: 77 },
        'issue:phase:09': { nodeId: 'ISSUE_NODE_09', issueNumber: 77 },
        'plan:09-01': { nodeId: 'item-plan-09-01', issueNumber: 501 },
      },
    },
  };
  const result = planReconciliation(desiredWithPlans([]), remoteForPlans(), map);
  assert.deepEqual(result.orphans, [
    { logicalKey: 'phase:09', issueNumber: 77 },
    { logicalKey: 'plan:09-01', issueNumber: 501 },
  ]);
});

test('planReconciliation: every reserved bootstrap key shape — including option:autonomous:yes — is never reported as a plan orphan', () => {
  const map = {
    kind: 'valid',
    map: {
      completions: {
        [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 },
        project: { nodeId: 'PVT_x' },
        'project-link': { nodeId: 'PVT_link_x' },
        'field:gsd-id': { nodeId: 'FIELD_x' },
        'field:wave': { nodeId: 'FIELD_WAVE_x' },
        'field:autonomous': { nodeId: 'FIELD_AUTO_x' },
        'option:status:todo': { nodeId: 'OPT_x' },
        'option:autonomous:yes': { nodeId: 'OPT_AUTO_YES_x' },
        'option:autonomous:no': { nodeId: 'OPT_AUTO_NO_x' },
        'label:gsd-plan': { nodeId: 'LABEL_x' },
        'milestone:v1-0': { nodeId: 'MI_x' },
      },
    },
  };
  const result = planReconciliation(desiredWithPlans([]), remoteForPlans(), map);
  assert.deepEqual(result.orphans, []);
});

test('planReconciliation: zero operations are emitted for any orphaned plan, and no operation anywhere in the plan carries an action that would close, unlink, or delete an issue', () => {
  const plan = planFixture();
  const map = mapWithPhaseIssue('04', 'I_node_phase_parent', {
    ...planFieldBootstrapCompletions(),
    'plan:09-09': { nodeId: 'item-orphan-plan', issueNumber: 500 },
    'issue:plan:09-09': { nodeId: 'ISSUE_orphan_plan', issueNumber: 500 },
  });
  const result = planReconciliation(desiredWithPlans([plan]), remoteForPlans(), map);
  const orphanOps = result.operations.filter((op) => op.logicalKey.includes('09-09'));
  assert.deepEqual(orphanOps, []);
  const DESTRUCTIVE_ACTIONS = new Set(['close', 'unlink', 'delete']);
  assert.ok(result.operations.every((op) => !DESTRUCTIVE_ACTIONS.has(op.action)));
});

test('planReconciliation: orphan entries (phase and plan namespaces together) are emitted in ascending logical-key order and are stable across runs', () => {
  const map = {
    kind: 'valid',
    map: {
      completions: {
        [MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: 3 },
        'plan:10-02': { nodeId: 'item-plan-10-02', issueNumber: 100 },
        'plan:02-01': { nodeId: 'item-plan-02-01', issueNumber: 20 },
      },
    },
  };
  const first = planReconciliation(desiredWithPlans([]), remoteForPlans(), map);
  const second = planReconciliation(desiredWithPlans([]), remoteForPlans(), map);
  assert.deepEqual(first.orphans, [{ logicalKey: 'plan:02-01', issueNumber: 20 }, { logicalKey: 'plan:10-02', issueNumber: 100 }]);
  assert.deepEqual(first.orphans, second.orphans);
});

// ─── Plan 05-06 Task 2: dependency references in a plan's create body ──────

/** Recursively asserts no argv string anywhere in `operations` contains the raw dependency-reference sentinel — a body must never dispatch carrying an unsubstituted slot. */
function assertNoSentinelInOperations(operations) {
  for (const op of operations) {
    for (const arg of op.args) {
      if (typeof arg === 'string') {
        assert.equal(arg.includes(DEPENDENCY_REF_SENTINEL), false, `argv string carries an unsubstituted dependency-reference sentinel: ${arg}`);
      } else if (arg && Array.isArray(arg.parts)) {
        for (const part of arg.parts) {
          if (typeof part === 'string') {
            assert.equal(part.includes(DEPENDENCY_REF_SENTINEL), false, `ArgvConcat literal part carries an unsubstituted sentinel: ${part}`);
          }
        }
      }
    }
  }
}

test('planReconciliation: a plan with two resolvable dependencies produces a create operation whose body argv entry is a concatenating entry with three literal segments and two issue:plan:<depId> NUMBER references, resolving to the real issue numbers with no sentinel surviving', () => {
  const plan = { id: '04-05', phaseId: '04', title: 'Depends on two', tasks: ['Task 1: First'], status: 'Todo', dependsOn: ['04-01', '04-02'] };
  const map = mapWithPhaseIssue('04', 'I_node_phase_parent', {
    'issue:plan:04-01': { nodeId: 'ISSUE_NODE_0401', issueNumber: 201 },
    'issue:plan:04-02': { nodeId: 'ISSUE_NODE_0402', issueNumber: 202 },
    ...planFieldBootstrapCompletions(),
  });
  const result = planReconciliation(desiredWithPlans([plan]), remoteForPlans(), map);
  assert.deepEqual(result.blocked, []);
  assertNoSentinelInOperations(result.operations);

  const createOp = result.operations.find((op) => op.kind === 'create-plan-issue');
  const bodyEntry = createOp.args.find((arg) => arg && typeof arg === 'object' && Array.isArray(arg.parts));
  assert.ok(bodyEntry, 'the body argv entry must be a concatenating entry, not a plain string');
  const literalParts = bodyEntry.parts.filter((part) => typeof part === 'string');
  const refParts = bodyEntry.parts.filter((part) => typeof part === 'object');
  assert.equal(literalParts.length, 3, 'three literal segments surround/separate two references');
  assert.equal(refParts.length, 2);
  assert.deepEqual(refParts.map((ref) => ref.from), ['issue:plan:04-01', 'issue:plan:04-02']);
  assert.ok(refParts.every((ref) => ref.part === 'number' && ref.prefix === '#'), 'each reference resolves the NUMBER slot with a # prefix so GitHub renders a linked issue reference');
  assert.equal(literalParts[0].startsWith('body='), true);

  // Resolved through a map holding both dependencies plus the milestone
  // reference the create op also carries, exactly as applyMutationPlan
  // would at dispatch time.
  const lookup = {
    'issue:plan:04-01': { nodeId: 'ISSUE_NODE_0401', remoteNumber: 201 },
    'issue:plan:04-02': { nodeId: 'ISSUE_NODE_0402', remoteNumber: 202 },
    [MILESTONE_KEY]: { nodeId: 'MI_node_1', remoteNumber: 3 },
  };
  const resolved = resolveArgv(createOp.args, lookup);
  assert.equal(resolved.ok, true);
  const resolvedBodyArg = resolved.argv.find((arg) => arg.startsWith('body='));
  assert.ok(resolvedBodyArg.includes('#201'));
  assert.ok(resolvedBodyArg.includes('#202'));
  assert.equal(resolvedBodyArg.includes(DEPENDENCY_REF_SENTINEL), false, 'no sentinel survives a resolved body');
});

test('planReconciliation: a plan with zero dependencies produces a plain string body argv entry, not a concatenating one with a single part', () => {
  const plan = planFixture();
  const result = planReconciliation(desiredWithPlans([plan]), remoteForPlans(), mapWithPhaseIssue('04', 'I_node_phase_parent', planFieldBootstrapCompletions()));
  const createOp = result.operations.find((op) => op.kind === 'create-plan-issue');
  const bodyArg = createOp.args.find((arg) => typeof arg === 'string' && arg.startsWith('body='));
  assert.ok(bodyArg, 'zero dependencies must produce a plain string body entry');
  assert.equal(createOp.args.some((arg) => arg && typeof arg === 'object' && Array.isArray(arg.parts)), false);
});

test('planReconciliation: a plan whose dependency has no issue:plan:<depId> completion and is not created earlier in the same run produces a typed blocked entry naming the missing key and zero operations for that plan, while a sibling plan still emits its own', () => {
  const blockedPlan = { id: '04-05', phaseId: '04', title: 'Depends on missing', tasks: ['Task 1'], status: 'Todo', dependsOn: ['04-99'] };
  const siblingPlan = planFixture({ id: '04-06', title: 'Sibling, no deps' });
  const map = mapWithPhaseIssue('04', 'I_node_phase_parent', planFieldBootstrapCompletions());
  const result = planReconciliation(desiredWithPlans([blockedPlan, siblingPlan]), remoteForPlans(), map);

  assert.ok(result.blocked.some((entry) => entry.reason === OPERATION_REASON.DEPENDENCY_SLOT_MISMATCH && entry.detail === 'issue:plan:04-99'));
  assert.equal(result.operations.some((op) => op.logicalKey === 'issue:plan:04-05' || op.logicalKey === 'plan:04-05'), false, 'the blocked plan emits no operation at all — no body operation, no field writes, no board bind');
  assert.ok(result.operations.some((op) => op.logicalKey === 'issue:plan:04-06'), 'the sibling plan still emits its own operations');
});

test('planReconciliation: a dependency created earlier in this same run (no prior-run completion) resolves too — the second of two plans in one run carries the first\'s late-bound reference', () => {
  const first = { id: '04-01', phaseId: '04', title: 'First plan', tasks: ['Task 1'], status: 'Todo' };
  const second = { id: '04-02', phaseId: '04', title: 'Second plan', tasks: ['Task 1'], status: 'Todo', dependsOn: ['04-01'] };
  const map = mapWithPhaseIssue('04', 'I_node_phase_parent', planFieldBootstrapCompletions());
  const result = planReconciliation(desiredWithPlans([first, second]), remoteForPlans(), map);

  assert.deepEqual(result.blocked, []);
  const secondCreate = result.operations.find((op) => op.kind === 'create-plan-issue' && op.logicalKey === 'issue:plan:04-02');
  const bodyEntry = secondCreate.args.find((arg) => arg && typeof arg === 'object' && Array.isArray(arg.parts));
  assert.ok(bodyEntry, 'the second plan\'s body carries a concatenating entry referencing the first');
  const refPart = bodyEntry.parts.find((part) => typeof part === 'object');
  assert.deepEqual(refPart, { from: 'issue:plan:04-01', part: 'number', prefix: '#' });
});

// ─── CR-01 pin (05-REVIEW re-review): the already-bound branch's own
// dependency-resolvability pre-check, mirroring the create branch's ────────

test('planReconciliation: CR-01 pin — an already-bound plan whose dependsOn names an unresolvable id is blocked with a scoped DEPENDENCY_SLOT_MISMATCH entry, contributes zero operations, is never reported as a no-op, and never suppresses a sibling plan\'s own create', () => {
  const blockedPlan = steadyPlan({ dependsOn: ['04-99'] });
  const siblingPlan = { id: '04-06', phaseId: '04', title: 'Sibling, no deps', tasks: ['Task 1'], status: 'Todo' };
  const desired = {
    available: true, reason: 'ok', currentPhase: null,
    phases: [], plans: [blockedPlan, siblingPlan],
    milestones: [{ version: MILESTONE_VERSION, name: 'One', title: `${MILESTONE_VERSION} — One`, description: 'd', archived: false }],
  };
  const map = mapWithPhaseIssue('04', 'I_node_phase_parent', {
    [PLAN_STEADY_LOGICAL_KEY]: { nodeId: 'item-plan-0403', issueNumber: 88 },
    [PLAN_STEADY_ISSUE_KEY]: { nodeId: 'ISSUE_NODE_PLAN_0403', issueNumber: 88 },
    ...planFieldBootstrapCompletions(),
  });

  const result = planReconciliation(desired, steadyPlanRemote(), map);

  assert.ok(
    result.blocked.some((entry) => entry.reason === OPERATION_REASON.DEPENDENCY_SLOT_MISMATCH && entry.detail === 'issue:plan:04-99'),
    'the already-bound branch now reports the exact same typed, scoped blocker the create branch already reports for an unresolvable dependency',
  );
  assert.equal(
    result.operations.some((op) => op.logicalKey === PLAN_STEADY_LOGICAL_KEY || op.logicalKey === PLAN_STEADY_ISSUE_KEY),
    false,
    'the blocked plan emits no operation at all — no state PATCH, no field write, no board bind',
  );
  assert.deepEqual(
    result.pendingIssueUpdates,
    [],
    'CR-01: before this fix, the plan would have reached pendingIssueUpdates carrying dependsOn: ["04-99"] as an unresolved ArgvRef, only to be caught later by resolveArgv at dispatch time — aborting every other queued operation in the run, not just this plan\'s',
  );
  assert.equal(result.noops.some((entry) => entry.logicalKey === PLAN_STEADY_LOGICAL_KEY), false, 'a blocked plan is never also reported as a no-op');
  assert.ok(
    result.operations.some((op) => op.logicalKey === 'issue:plan:04-06'),
    'the sibling plan still creates in the same run — one plan\'s bad dependency never suppresses another\'s unrelated operations',
  );
});

test('planReconciliation: CR-01 pin — once the dependency resolves (its own completion now exists), the previously blocked already-bound plan proceeds to its normal convergence path', () => {
  const plan = steadyPlan({ dependsOn: ['04-99'] });
  const map = mapWithPhaseIssue('04', 'I_node_phase_parent', {
    [PLAN_STEADY_LOGICAL_KEY]: { nodeId: 'item-plan-0403', issueNumber: 88 },
    [PLAN_STEADY_ISSUE_KEY]: { nodeId: 'ISSUE_NODE_PLAN_0403', issueNumber: 88 },
    'issue:plan:04-99': { nodeId: 'ISSUE_NODE_0499', issueNumber: 99 },
    ...planFieldBootstrapCompletions(),
  });

  const result = planReconciliation(steadyPlanDesired(plan), steadyPlanRemote(), map);

  assert.deepEqual(
    result.blocked.filter((entry) => entry.detail === 'issue:plan:04-99'),
    [],
    'the dependency now resolves — no DEPENDENCY_SLOT_MISMATCH for it',
  );
  assert.equal(
    result.pendingIssueUpdates.length,
    1,
    'the plan proceeds past the dependency check into its normal already-bound convergence path (a pending content update, since the stored completion carries no contentHash)',
  );
  assert.equal(result.pendingIssueUpdates[0].logicalKey, PLAN_STEADY_LOGICAL_KEY);
  assert.deepEqual(result.pendingIssueUpdates[0].dependsOn, ['04-99'], 'the resolved dependency id still rides the pending update\'s own projection, unchanged by CR-01\'s new pre-check');
});

test('planReconciliation: WR-02 pin — a dependency on a numerically-higher plan id cannot resolve same-run and self-heals on the next run once the dependency\'s completion exists', () => {
  // Ascending-id pass processes 04-01 before 04-05, so when 04-01's own
  // dependency check runs, 04-05's create hasn't been pushed yet — unlike
  // the lower-id case covered above, this is NOT resolvable same-run.
  const forwardDependent = { id: '04-01', phaseId: '04', title: 'Depends on a later plan', tasks: ['Task 1'], status: 'Todo', dependsOn: ['04-05'] };
  const laterPlan = { id: '04-05', phaseId: '04', title: 'Sorts later, no deps', tasks: ['Task 1'], status: 'Todo' };
  const map = mapWithPhaseIssue('04', 'I_node_phase_parent', planFieldBootstrapCompletions());

  const runOne = planReconciliation(desiredWithPlans([forwardDependent, laterPlan]), remoteForPlans(), map);
  assert.ok(
    runOne.blocked.some((entry) => entry.reason === OPERATION_REASON.DEPENDENCY_SLOT_MISMATCH && entry.detail === 'issue:plan:04-05'),
    'the forward-pointing dependent is blocked on its first run, even though its dependency is present in the very same desired set',
  );
  assert.equal(runOne.operations.some((op) => op.logicalKey === 'issue:plan:04-01' || op.logicalKey === 'plan:04-01'), false);
  assert.ok(runOne.operations.some((op) => op.logicalKey === 'issue:plan:04-05'), 'the independent later-sorting plan still creates in the same run');

  // Next run: 04-05's completion now exists (as it would after run one's
  // create dispatches), so the forward dependency resolves and 04-01
  // converges — the self-heal the finding describes.
  const mapAfterRunOne = mapWithPhaseIssue('04', 'I_node_phase_parent', {
    'issue:plan:04-05': { nodeId: 'ISSUE_NODE_0405', issueNumber: 305 },
    ...planFieldBootstrapCompletions(),
  });
  const runTwo = planReconciliation(desiredWithPlans([forwardDependent, laterPlan]), remoteForPlans(), mapAfterRunOne);
  assert.deepEqual(runTwo.blocked.filter((entry) => entry.detail === 'issue:plan:04-05'), []);
  assert.ok(runTwo.operations.some((op) => op.logicalKey === 'issue:plan:04-01'), 'the forward dependent resolves and creates on the next run');
});

test('planReconciliation: the content hash for a plan is unchanged by which issue numbers its dependencies resolve to', () => {
  const plan = { id: '04-05', phaseId: '04', title: 'Depends on two', tasks: ['Task 1: First'], status: 'Todo', dependsOn: ['04-01', '04-02'] };
  const mapA = mapWithPhaseIssue('04', 'I_node_phase_parent', {
    'issue:plan:04-01': { nodeId: 'ISSUE_NODE_0401', issueNumber: 201 },
    'issue:plan:04-02': { nodeId: 'ISSUE_NODE_0402', issueNumber: 202 },
    ...planFieldBootstrapCompletions(),
  });
  const mapB = mapWithPhaseIssue('04', 'I_node_phase_parent', {
    'issue:plan:04-01': { nodeId: 'ISSUE_NODE_DIFFERENT_1', issueNumber: 555 },
    'issue:plan:04-02': { nodeId: 'ISSUE_NODE_DIFFERENT_2', issueNumber: 777 },
    ...planFieldBootstrapCompletions(),
  });
  const resultA = planReconciliation(desiredWithPlans([plan]), remoteForPlans(), mapA);
  const resultB = planReconciliation(desiredWithPlans([plan]), remoteForPlans(), mapB);

  const hashA = resultA.operations.find((op) => op.kind === 'add-sub-issue').captures[0].plannerFields.contentHash;
  const hashB = resultB.operations.find((op) => op.kind === 'add-sub-issue').captures[0].plannerFields.contentHash;
  assert.equal(hashA, hashB, 'two otherwise-identical plans whose dependencies resolve to different issue numbers must produce equal content hashes');

  // And the plan-id substitution the hash is computed over really did differ
  // in dependency identity from an empty-dependency plan, proving the hash
  // is sensitive to WHICH plans are depended on, just not to their numbers.
  const noDepsPlan = { ...plan, dependsOn: [] };
  const resultNoDeps = planReconciliation(desiredWithPlans([noDepsPlan]), remoteForPlans(), mapWithPhaseIssue('04', 'I_node_phase_parent', planFieldBootstrapCompletions()));
  const hashNoDeps = resultNoDeps.operations.find((op) => op.kind === 'add-sub-issue').captures[0].plannerFields.contentHash;
  assert.notEqual(hashA, hashNoDeps);
});

test('bodyArgvEntry: a body carrying no sentinel returns a plain string entry equal to "body=" concatenated with the body, with no map lookup implied', () => {
  const result = bodyArgvEntry('a plain body with no dependency slots', []);
  assert.deepEqual(result, { kind: 'ok', entry: 'body=a plain body with no dependency slots' });
});

test('bodyArgvEntry: a slot/dependency count disagreement returns a typed mismatch, never a body', () => {
  const bodyWithOneSlot = `before${DEPENDENCY_REF_SENTINEL}after`;
  const result = bodyArgvEntry(bodyWithOneSlot, ['04-01', '04-02']);
  assert.equal(result.kind, 'mismatch');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'entry'), false);
  assert.match(result.detail, /1/);
  assert.match(result.detail, /2/);
});

// ─── Plan 05-06 Task 3: the plan issue's own open/closed state ────────────

test('PLAN_ISSUE_STATE: exposes exactly the two literal values', () => {
  assert.deepEqual(PLAN_ISSUE_STATE, { OPEN: 'open', CLOSED: 'closed' });
});

test('buildPlanIssueStateOperation: REST PATCH carrying the state on the raw flag, no labels entry, contentCreation false, and a node capture recording the written state as a planner field', () => {
  const op = buildPlanIssueStateOperation('octo', 'repo', 88, planIssueKeyFor('04-03'), PLAN_ISSUE_STATE.CLOSED, CONTEXT);
  assert.equal(op.kind, 'update-plan-issue-state');
  assert.equal(op.transport, 'rest');
  assert.equal(op.action, 'update');
  assert.equal(op.hasPointsBudget, false);
  assert.equal(op.contentCreation, false, 'a state PATCH never consumes the content-creation pacing budget');
  assert.deepEqual(op.args, ['api', 'repos/octo/repo/issues/88', '-X', 'PATCH', '-f', 'state=closed']);
  for (const arg of op.args) {
    if (typeof arg === 'string') assert.doesNotMatch(arg, /labels/i, 'the state PATCH must carry no labels entry of any kind');
  }
  assert.deepEqual(op.captures[0], {
    kind: 'node', logicalKey: planIssueKeyFor('04-03'), nodeIdPath: 'node_id', numberPath: 'number',
    plannerFields: { issueState: 'closed' },
  });
});

test('buildPlanIssueStateOperation: returns null when the owner/repo fails the path-safety charset check, never dispatching gh with an unsafe path', () => {
  const op = buildPlanIssueStateOperation('{owner}', 'repo', 88, planIssueKeyFor('04-03'), PLAN_ISSUE_STATE.OPEN, CONTEXT);
  assert.equal(op, null);
});

test('planReconciliation: a plan whose sibling SUMMARY.md exists (complete) and whose completion records an open state emits one PATCH setting the issue closed', () => {
  const plan = steadyPlan({ complete: true });
  const region = renderPlanRegion({ id: plan.id, title: plan.title, status: plan.status, tasks: plan.tasks });
  const hash = contentHash({ title: plan.title, region, milestoneNumber: PLAN_STEADY_MILESTONE_NUMBER });
  const fieldState = renderFieldState(steadyPlanFieldValues(plan), PLAN_FIELD_NAMES);
  const map = steadyPlanMap({ contentHashValue: hash, fieldStateValue: fieldState, issueStateValue: 'open' });

  const result = planReconciliation(steadyPlanDesired(plan), steadyPlanRemote(), map);
  const stateOps = result.operations.filter((op) => op.kind === 'update-plan-issue-state');
  assert.equal(stateOps.length, 1);
  assert.ok(stateOps[0].args.includes('state=closed'));
  assert.deepEqual(result.noops, [], 'a plan with a pending state transition is never also reported as a no-op');
});

test('planReconciliation: a plan whose sibling SUMMARY.md is absent and whose completion records a closed state emits one PATCH setting the issue open', () => {
  const plan = steadyPlan({ complete: false });
  const region = renderPlanRegion({ id: plan.id, title: plan.title, status: plan.status, tasks: plan.tasks });
  const hash = contentHash({ title: plan.title, region, milestoneNumber: PLAN_STEADY_MILESTONE_NUMBER });
  const fieldState = renderFieldState(steadyPlanFieldValues(plan), PLAN_FIELD_NAMES);
  const map = steadyPlanMap({ contentHashValue: hash, fieldStateValue: fieldState, issueStateValue: 'closed' });

  const result = planReconciliation(steadyPlanDesired(plan), steadyPlanRemote(), map);
  const stateOps = result.operations.filter((op) => op.kind === 'update-plan-issue-state');
  assert.equal(stateOps.length, 1);
  assert.ok(stateOps[0].args.includes('state=open'));
});

test('planReconciliation: a plan whose recorded state already matches disk emits no state operation', () => {
  const plan = steadyPlan({ complete: true });
  const region = renderPlanRegion({ id: plan.id, title: plan.title, status: plan.status, tasks: plan.tasks });
  const hash = contentHash({ title: plan.title, region, milestoneNumber: PLAN_STEADY_MILESTONE_NUMBER });
  const fieldState = renderFieldState(steadyPlanFieldValues(plan), PLAN_FIELD_NAMES);
  const map = steadyPlanMap({ contentHashValue: hash, fieldStateValue: fieldState, issueStateValue: 'closed' });

  const result = planReconciliation(steadyPlanDesired(plan), steadyPlanRemote(), map);
  assert.deepEqual(result.operations.filter((op) => op.kind === 'update-plan-issue-state'), []);
  assert.deepEqual(result.noops, [{ logicalKey: PLAN_STEADY_LOGICAL_KEY }]);
});

test('planReconciliation: a plan whose completion records no state at all is treated as unknown and emits one PATCH, converging on that run', () => {
  const plan = steadyPlan({ complete: false });
  const region = renderPlanRegion({ id: plan.id, title: plan.title, status: plan.status, tasks: plan.tasks });
  const hash = contentHash({ title: plan.title, region, milestoneNumber: PLAN_STEADY_MILESTONE_NUMBER });
  const fieldState = renderFieldState(steadyPlanFieldValues(plan), PLAN_FIELD_NAMES);
  const map = steadyPlanMap({ contentHashValue: hash, fieldStateValue: fieldState }); // no issueStateValue at all

  const result = planReconciliation(steadyPlanDesired(plan), steadyPlanRemote(), map);
  const stateOps = result.operations.filter((op) => op.kind === 'update-plan-issue-state');
  assert.equal(stateOps.length, 1);
  assert.ok(stateOps[0].args.includes('state=open'));
});

test("planReconciliation: the state PATCH's capture carries the newly written state as a planner field, so the following run is a no-op", () => {
  const plan = steadyPlan({ complete: true });
  const region = renderPlanRegion({ id: plan.id, title: plan.title, status: plan.status, tasks: plan.tasks });
  const hash = contentHash({ title: plan.title, region, milestoneNumber: PLAN_STEADY_MILESTONE_NUMBER });
  const fieldState = renderFieldState(steadyPlanFieldValues(plan), PLAN_FIELD_NAMES);
  const map = steadyPlanMap({ contentHashValue: hash, fieldStateValue: fieldState, issueStateValue: 'open' });

  const result = planReconciliation(steadyPlanDesired(plan), steadyPlanRemote(), map);
  const stateOp = result.operations.find((op) => op.kind === 'update-plan-issue-state');
  // Rule 1 fix: the capture also carries the freshly computed contentHash
  // forward, so a state-only run never wipes it under recordCompletion's
  // wholesale-replace semantics — see buildPlanIssueStateOperation's doc.
  assert.equal(stateOp.captures[0].plannerFields.issueState, 'closed');
  assert.equal(stateOp.captures[0].plannerFields.contentHash, hash);
});

test('planReconciliation: two consecutive runs over unchanged disk emit one state PATCH on the first and none on the second', () => {
  const plan = steadyPlan({ complete: false });
  const region = renderPlanRegion({ id: plan.id, title: plan.title, status: plan.status, tasks: plan.tasks });
  const hash = contentHash({ title: plan.title, region, milestoneNumber: PLAN_STEADY_MILESTONE_NUMBER });
  const fieldState = renderFieldState(steadyPlanFieldValues(plan), PLAN_FIELD_NAMES);

  const firstMap = steadyPlanMap({ contentHashValue: hash, fieldStateValue: fieldState }); // unknown state
  const firstResult = planReconciliation(steadyPlanDesired(plan), steadyPlanRemote(), firstMap);
  assert.equal(firstResult.operations.filter((op) => op.kind === 'update-plan-issue-state').length, 1);

  // The second run's map reflects the first run's state PATCH already having
  // been recorded — exactly what applyMutationPlan/recordCompletion would do.
  const secondMap = steadyPlanMap({ contentHashValue: hash, fieldStateValue: fieldState, issueStateValue: 'open' });
  const secondResult = planReconciliation(steadyPlanDesired(plan), steadyPlanRemote(), secondMap);
  assert.equal(secondResult.operations.filter((op) => op.kind === 'update-plan-issue-state').length, 0);
  assert.deepEqual(secondResult.noops, [{ logicalKey: PLAN_STEADY_LOGICAL_KEY }]);
});

test('planReconciliation: no code path writes a value from a GitHub response back into any .planning/ file other than the sync map\'s own node ids, numbers, hashes and state', () => {
  // The one-way-mirror control: the state PATCH's own args and captures name
  // no filesystem path, and desired state is derived solely from `plan.complete`
  // (github-sync-desired.cts's own disk-truth signal), never from `remote`.
  const plan = steadyPlan({ complete: true });
  const region = renderPlanRegion({ id: plan.id, title: plan.title, status: plan.status, tasks: plan.tasks });
  const hash = contentHash({ title: plan.title, region, milestoneNumber: PLAN_STEADY_MILESTONE_NUMBER });
  const fieldState = renderFieldState(steadyPlanFieldValues(plan), PLAN_FIELD_NAMES);
  const map = steadyPlanMap({ contentHashValue: hash, fieldStateValue: fieldState, issueStateValue: 'open' });

  const result = planReconciliation(steadyPlanDesired(plan), steadyPlanRemote(), map);
  const stateOp = result.operations.find((op) => op.kind === 'update-plan-issue-state');
  for (const arg of stateOp.args) {
    if (typeof arg === 'string') assert.doesNotMatch(arg, /\.planning/, 'no argv value names a .planning/ path');
  }
});
