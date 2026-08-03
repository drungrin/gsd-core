'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup } = require('./helpers.cjs');
const { makeFakeClock } = require('./helpers/clock.cjs');
const { planReconciliation, OPERATION_REASON } = require('../gsd-core/bin/lib/github-sync-reconcile.cjs');
const { applyMutationPlan } = require('../gsd-core/bin/lib/github-sync-apply.cjs');
const {
  readSyncMapStrict,
  recordCompletion,
  writeSyncMapAtomically,
  SYNC_MAP_FILE_NAME,
} = require('../gsd-core/bin/lib/github-sync-map.cjs');

const TARGET = {
  owner: 'octo',
  repo: 'roadmap',
  repositoryNumber: 42,
  projectNumber: 7,
  projectNodeId: 'PVT_proj_node_1',
};
const REPOSITORY = { owner: TARGET.owner, repo: TARGET.repo, number: TARGET.repositoryNumber };
const FIXED_NOW = '2026-07-30T21:00:00.000Z';
const SEEDED_AT = '2026-07-29T20:00:00.000Z';
const ID_ALLOWLIST = new Set([
  'PVT_proj_node_1', 'I_node_101', 'I_node_102',
  // plan 04-01: the REST-created phase issue's own node id, and the project
  // item id the add-to-project mutation mints for it in the same run.
  'I_node_phase_04', 'PVTI_item_phase_04',
  'I_node_phase_04_second', 'PVTI_item_phase_04_second',
  'I_node_phase_05', 'PVTI_item_phase_05',
  // plan 04-05: the four GSD item fields' own node ids and the status option
  // ids a bootstrapped board records — resolved through the reserved-key
  // catalog, never invented by this codebase.
  'FIELD_GSD_ID', 'FIELD_PHASE', 'FIELD_REQUIREMENTS', 'FIELD_STATUS',
  'OPTION_TODO', 'OPTION_IN_PROGRESS', 'OPTION_DONE',
  // plan 05-01: a plan sub-issue's own create capture, its native
  // addSubIssue link to a pre-existing parent phase issue, and the project
  // item id addProjectV2ItemById mints for it in the same run.
  'I_node_phase_plan_parent', 'I_node_plan_0403', 'PVTI_item_plan_0403',
  // plan 05-05: the plan-only Wave/Autonomous field and option node ids a
  // bootstrapped board records, resolved through the same reserved-key
  // catalog as the four shared fields above.
  'FIELD_WAVE', 'FIELD_AUTONOMOUS', 'OPTION_AUTONOMOUS_YES', 'OPTION_AUTONOMOUS_NO',
]);
const { BOOTSTRAP_LOGICAL_KEY } = require('../gsd-core/bin/lib/github-sync-bootstrap-plan.cjs');
const { phaseMarker, planMarker, FENCE_BEGIN, FENCE_END, renderPhaseRegion, contentHash, renderFieldState, PLAN_FIELD_NAMES } = require('../gsd-core/bin/lib/github-sync-issue-body.cjs');
const { prepareIssueUpdates } = require('../gsd-core/bin/lib/github-sync-issue-update.cjs');

const FIELD_KEY = {
  gsdId: BOOTSTRAP_LOGICAL_KEY.field('GSD ID'),
  phase: BOOTSTRAP_LOGICAL_KEY.field('Phase'),
  requirements: BOOTSTRAP_LOGICAL_KEY.field('Requirements'),
  status: BOOTSTRAP_LOGICAL_KEY.field('Status'),
};

/** Plan 04-05: the four field/option completions a bootstrapped board (`init`) already recorded — the same shape `field(name)`/`statusOption(name)` resolve against, never a live read. */
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

/** Plan 05-05: the plan item's two extra fields (Wave, Autonomous) and the Autonomous field's two options, alongside the four fields every phase already shares. */
function planFieldBootstrapCompletions() {
  return {
    ...fieldBootstrapCompletions(),
    [BOOTSTRAP_LOGICAL_KEY.field('Wave')]: { nodeId: 'FIELD_WAVE' },
    [BOOTSTRAP_LOGICAL_KEY.field('Autonomous')]: { nodeId: 'FIELD_AUTONOMOUS' },
    [BOOTSTRAP_LOGICAL_KEY.autonomousOption('Yes')]: { nodeId: 'OPTION_AUTONOMOUS_YES' },
    [BOOTSTRAP_LOGICAL_KEY.autonomousOption('No')]: { nodeId: 'OPTION_AUTONOMOUS_NO' },
  };
}

function desired() {
  return {
    available: true,
    reason: 'ok',
    phases: [
      { id: '01', title: 'One', goal: 'first phase' },
      { id: '02', title: 'Two', goal: 'second phase' },
    ],
  };
}

function remote(items = []) {
  return {
    available: true,
    reason: 'ok',
    target: TARGET,
    items,
    fields: [],
    subIssues: [],
    issueNodeIds: { 101: 'I_node_101', 102: 'I_node_102' },
  };
}

function response(nodeId, issueNumber) {
  return {
    exitCode: 0,
    reason: 'ok',
    stdout: JSON.stringify({
      data: {
        // plan 04-01: the live schema probe confirmed no rateLimit field on
        // Mutation and the confirmed mutation/payload shape is
        // addProjectV2ItemById { item { ... } }, not the phantom
        // addProjectV2Item { projectV2Item { ... } } Phase 2 assumed.
        addProjectV2ItemById: { item: { id: nodeId, content: { number: issueNumber } } },
      },
    }),
    stderr: '',
  };
}

function restIssueCreateResponse(nodeId, number) {
  return {
    exitCode: 0,
    reason: 'ok',
    stdout: JSON.stringify({ id: 555000 + number, node_id: nodeId, number }),
    stderr: '',
  };
}

/** Plan 04-05: the shape `updateProjectV2ItemFieldValue`'s response actually decodes through — both `UPDATE_FIELD_VALUE_TEXT_DOCUMENT` and `UPDATE_FIELD_VALUE_SINGLE_SELECT_DOCUMENT` select this same payload shape. */
function fieldValueResponse(nodeId, number) {
  return {
    exitCode: 0,
    reason: 'ok',
    stdout: JSON.stringify({
      data: {
        updateProjectV2ItemFieldValue: { projectV2Item: { id: nodeId, content: { number } } },
      },
    }),
    stderr: '',
  };
}

function syncMapPath(cwd) {
  return path.join(cwd, '.planning', SYNC_MAP_FILE_NAME);
}

function makeSeedCompletion(logicalKey, nodeId, issueNumber) {
  return {
    logicalKey,
    nodeId,
    issueNumber,
    completedAt: SEEDED_AT,
    owner: TARGET.owner,
    repo: TARGET.repo,
    repositoryNumber: TARGET.repositoryNumber,
  };
}

function fixedClock() {
  const clock = makeFakeClock(Date.parse(FIXED_NOW));
  clock.nowIso = () => FIXED_NOW;
  return clock;
}

function writeSeededMap(cwd) {
  let map = null;
  map = recordCompletion(map, makeSeedCompletion('phase:01', 'PVTI_item_original', 101));
  map = recordCompletion(map, makeSeedCompletion('phase:02', 'PVTI_item_original_2', 102));
  writeSyncMapAtomically(cwd, map);
  const reopened = readSyncMapStrict(cwd, REPOSITORY);
  assert.equal(reopened.kind, 'valid');
  return reopened;
}

function assertOpaqueIdPairs(argvCalls) {
  const idPairs = [];
  for (const args of argvCalls) {
    for (let index = 0; index < args.length - 1; index += 1) {
      // Plan 04-01: projectId/contentId now ride the raw -f flag (Task 1's
      // fix), not the typed -F flag — scan both so this helper still finds
      // every ID-typed argument regardless of which flag carries it.
      if (args[index] !== '-f' && args[index] !== '-F') continue;
      const raw = args[index + 1];
      if (typeof raw !== 'string') continue;
      const [key, value] = raw.split('=', 2);
      if (key.endsWith('Id')) idPairs.push({ key, value, raw });
    }
  }

  assert.ok(idPairs.length > 0, 'expected at least one ID-typed argument');
  // Plan 04-05: field-value operations introduce two more ID-typed argv keys
  // (itemId, fieldId) — both opaque GitHub node ids, both allowed alongside
  // the pre-existing contentId/projectId. Plan 05-01: addSubIssue introduces
  // issueId/subIssueId — both opaque GitHub node ids GSD echoes back.
  const ALLOWED_ID_KEYS = new Set(['contentId', 'projectId', 'itemId', 'fieldId', 'issueId', 'subIssueId']);
  assert.ok([...new Set(idPairs.map(({ key }) => key))].every((key) => ALLOWED_ID_KEYS.has(key)));
  for (const { raw, value } of idPairs) {
    assert.ok(ID_ALLOWLIST.has(value), `${raw} must use an opaque node ID from the allowlist`);
  }
}

test('real reconciler, applier, and strict map resume each response-validated checkpoint without duplicate argv', (t) => {
  const cwd = createTempProject('github-sync-composition-');
  t.after(() => cleanup(cwd));

  const seeded = writeSeededMap(cwd);
  const clock = fixedClock();
  const dispatchedArgv = [];

  const firstPlan = planReconciliation(desired(), remote(), seeded);
  assert.deepEqual(firstPlan.operations.map((operation) => operation.logicalKey), ['phase:01', 'phase:02']);
  assert.deepEqual(firstPlan.noops, []);
  assert.deepEqual(firstPlan.blocked, []);

  const firstRun = applyMutationPlan(firstPlan, {
    cwd,
    map: seeded.map,
    clock,
    execGh(args) {
      dispatchedArgv.push(args);
      return dispatchedArgv.length === 1
        ? response('PVTI_item_1', 101)
        : { exitCode: 1, reason: 'gh_exit_nonzero', stdout: '', stderr: 'semantic failure' };
    },
    recordCompletion,
    writeSyncMapAtomically,
  });
  // plan 03-02 (HIGH-F): ApplyResult now carries an outcomes journal on every
  // variant, so this assertion is narrowed to the three pre-existing fields
  // rather than a full-object deepEqual against them.
  assert.equal(firstRun.kind, 'failed');
  assert.equal(firstRun.logicalKey, 'phase:02');
  assert.equal(firstRun.remediation, 'Retry the sync after resolving the reported GitHub failure.');
  assertOpaqueIdPairs(dispatchedArgv);

  const reopened = readSyncMapStrict(cwd, REPOSITORY);
  assert.equal(reopened.kind, 'valid');
  assert.deepEqual(reopened.map.completions['phase:01'], {
    logicalKey: 'phase:01',
    nodeId: 'PVTI_item_1',
    issueNumber: 101,
    completedAt: FIXED_NOW,
    owner: TARGET.owner,
    repo: TARGET.repo,
    repositoryNumber: TARGET.repositoryNumber,
  });
  assert.deepEqual(reopened.map.completions['phase:02'], makeSeedCompletion('phase:02', 'PVTI_item_original_2', 102));

  const resumedPlan = planReconciliation(
    desired(),
    remote([{ id: 'PVTI_item_1', content: { id: 'I_node_101', number: 101 } }]),
    reopened,
  );
  assert.deepEqual(resumedPlan.noops, [{ logicalKey: 'phase:01' }]);
  assert.deepEqual(resumedPlan.operations.map((operation) => operation.logicalKey), ['phase:02']);

  const firstConfirmedArgv = dispatchedArgv[0];
  const resumed = applyMutationPlan(resumedPlan, {
    cwd,
    map: reopened.map,
    clock,
    execGh(args) {
      dispatchedArgv.push(args);
      return response('PVTI_item_2', 102);
    },
    recordCompletion,
    writeSyncMapAtomically,
  });
  assert.equal(resumed.kind, 'completed');
  assertOpaqueIdPairs(dispatchedArgv);
  assert.notDeepEqual(firstConfirmedArgv, dispatchedArgv[2], 'resume must not repeat the confirmed first-run argv for phase:01');

  const resumedMap = readSyncMapStrict(cwd, REPOSITORY);
  assert.equal(resumedMap.kind, 'valid');
  assert.deepEqual(resumedMap.map.completions['phase:02'], {
    logicalKey: 'phase:02',
    nodeId: 'PVTI_item_2',
    issueNumber: 102,
    completedAt: FIXED_NOW,
    owner: TARGET.owner,
    repo: TARGET.repo,
    repositoryNumber: TARGET.repositoryNumber,
  });

  const unchangedPlan = planReconciliation(
    desired(),
    remote([
      { id: 'PVTI_item_1', content: { id: 'I_node_101', number: 101 } },
      { id: 'PVTI_item_2', content: { id: 'I_node_102', number: 102 } },
    ]),
    resumedMap,
  );
  assert.equal(unchangedPlan.operations.length, 0);
  assert.deepEqual(unchangedPlan.noops, [{ logicalKey: 'phase:01' }, { logicalKey: 'phase:02' }]);

  let unexpectedCalls = 0;
  const unchangedResult = applyMutationPlan(unchangedPlan, {
    cwd,
    map: resumedMap.map,
    clock,
    execGh() {
      unexpectedCalls += 1;
      throw new Error('unchanged state must not dispatch');
    },
    recordCompletion,
    writeSyncMapAtomically,
  });
  assert.equal(unchangedResult.kind, 'completed');
  assert.equal(unexpectedCalls, 0);
});

test('milestone-unresolved absent-map run dispatches nothing and leaves no map file behind', (t) => {
  const cwd = createTempProject('github-sync-composition-absent-');
  t.after(() => cleanup(cwd));

  const absent = readSyncMapStrict(cwd, REPOSITORY);
  assert.deepEqual(absent, { kind: 'absent' });

  // Plan 04-01: with the map entirely absent, neither phase carries any
  // completion of any kind (no phase:<id>, no issue:phase:<id>), and this
  // fixture's `desired()` declares no milestone either — so both phases are
  // blocked as genuinely new phases with no checkpointed milestone to
  // create against, never as an identity-resolution failure.
  const plan = planReconciliation(desired(), remote(), absent);
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.noops, []);
  assert.deepEqual(plan.blocked, [
    { reason: OPERATION_REASON.MILESTONE_UNRESOLVED, detail: 'phase:01' },
    { reason: OPERATION_REASON.MILESTONE_UNRESOLVED, detail: 'phase:02' },
  ]);

  let dispatched = 0;
  const result = applyMutationPlan(plan, {
    cwd,
    map: null,
    clock: fixedClock(),
    execGh() {
      dispatched += 1;
      throw new Error('milestone-unresolved plan must not dispatch');
    },
    recordCompletion,
    writeSyncMapAtomically,
  });
  assert.equal(result.kind, 'completed');
  assert.equal(dispatched, 0);
  assert.equal(fs.existsSync(syncMapPath(cwd)), false);
});

// ─── Plan 04-01 Task 2 tracer: one roadmap phase reaches GitHub as a ───────
// ─── labeled, marked, milestoned issue that is a project item ─────────────

const PHASE_MILESTONE_VERSION = 'v1.0';
const PHASE_MILESTONE_KEY = BOOTSTRAP_LOGICAL_KEY.milestone(PHASE_MILESTONE_VERSION);
const PHASE_MILESTONE_NUMBER = 3;

function desiredSinglePhase(phase) {
  return {
    available: true,
    reason: 'ok',
    phases: [phase],
    milestones: [{ version: PHASE_MILESTONE_VERSION, name: 'One', title: `${PHASE_MILESTONE_VERSION} — One`, description: 'd', archived: false }],
  };
}

function desiredTwoPhases(phaseA, phaseB) {
  return {
    available: true,
    reason: 'ok',
    phases: [phaseA, phaseB],
    milestones: [{ version: PHASE_MILESTONE_VERSION, name: 'One', title: `${PHASE_MILESTONE_VERSION} — One`, description: 'd', archived: false }],
  };
}

/** Plan 04-05: the milestone completion plus a fully bootstrapped board's project/field/option completions — the shape a real `init` run would have already recorded before `sync` ever runs. */
function seedMilestoneAndFieldsMap(cwd) {
  let map = null;
  map = recordCompletion(map, makeSeedCompletion(PHASE_MILESTONE_KEY, 'MI_node_1', PHASE_MILESTONE_NUMBER));
  map = recordCompletion(map, makeSeedCompletion(BOOTSTRAP_LOGICAL_KEY.project(), TARGET.projectNodeId, undefined));
  for (const [logicalKey, completion] of Object.entries(fieldBootstrapCompletions())) {
    map = recordCompletion(map, makeSeedCompletion(logicalKey, completion.nodeId, undefined));
  }
  writeSyncMapAtomically(cwd, map);
  const reopened = readSyncMapStrict(cwd, REPOSITORY);
  assert.equal(reopened.kind, 'valid');
  return reopened;
}

test('one roadmap phase travels end-to-end: REST create, add-to-project, and four field writes; both identity keys recorded, no third phase-scoped key', (t) => {
  const cwd = createTempProject('github-sync-composition-tracer-');
  t.after(() => cleanup(cwd));

  const phase = { id: '04', title: 'Phase Four', goal: 'ship the tracer', requirements: ['PHASE-01'], status: 'Todo' };
  const singleDesired = desiredSinglePhase(phase);
  const seeded = seedMilestoneAndFieldsMap(cwd);
  const clock = fixedClock();
  const dispatchedArgv = [];

  const plan = planReconciliation(singleDesired, remote([]), seeded);
  assert.deepEqual(plan.blocked, []);
  // Plan 04-05: the create branch now also emits the four field-value
  // writes, all sharing the phase's own project-item logical key.
  assert.deepEqual(plan.operations.map((op) => op.logicalKey), [
    'issue:phase:04', 'phase:04', 'phase:04', 'phase:04', 'phase:04', 'phase:04',
  ]);
  assert.equal(plan.operations[0].transport, 'rest');
  for (const op of plan.operations.slice(1)) assert.equal(op.transport, 'graphql');

  const run = applyMutationPlan(plan, {
    cwd,
    map: seeded.map,
    clock,
    execGh(args) {
      dispatchedArgv.push(args);
      const callIndex = dispatchedArgv.length;
      if (callIndex === 1) {
        // The REST create call: its milestone= value must already be
        // resolved from the seeded map (late-bound, not hardcoded).
        assert.ok(args.includes(`milestone=${PHASE_MILESTONE_NUMBER}`), 'REST create must carry the milestone number resolved from the map');
        return restIssueCreateResponse('I_node_phase_04', 55);
      }
      if (callIndex === 2) {
        // The add-to-project call: its contentId must be the REST create's own
        // capture from THIS SAME run, not any value known ahead of time.
        assert.ok(args.includes('contentId=I_node_phase_04'), 'add-to-project must late-bind to the REST create\'s own capture within the same run');
        return response('PVTI_item_phase_04', 55);
      }
      // The four field-value calls: each late-binds its item id to the
      // add-to-project operation's own capture, recorded earlier in this
      // same run under the same `phase:04` logical key.
      assert.ok(args.includes('itemId=PVTI_item_phase_04'), 'a field write must late-bind to the add-to-project operation\'s own capture within the same run');
      return fieldValueResponse('PVTI_item_phase_04', 55);
    },
    recordCompletion,
    writeSyncMapAtomically,
  });
  assert.equal(run.kind, 'completed');
  assertOpaqueIdPairs(dispatchedArgv);

  const reopened = readSyncMapStrict(cwd, REPOSITORY);
  assert.equal(reopened.kind, 'valid');
  // Plan 04-04 Task 1: the create's REST capture carries the freshly
  // computed content hash. Plan 04-05: the field state no longer rides the
  // add-to-project capture — it now rides only the LAST field-value
  // operation's capture, so the recorded `phase:04` completion carries it
  // from there instead.
  const expectedContentHash = contentHash({ title: phase.title, region: renderPhaseRegion(phase), milestoneNumber: PHASE_MILESTONE_NUMBER });
  const expectedFieldState = renderFieldState({ gsdId: 'phase:04', phaseId: '04', requirements: ['PHASE-01'], status: 'Todo' });
  assert.deepEqual(reopened.map.completions['issue:phase:04'], {
    logicalKey: 'issue:phase:04',
    nodeId: 'I_node_phase_04',
    issueNumber: 55,
    completedAt: FIXED_NOW,
    owner: TARGET.owner,
    repo: TARGET.repo,
    repositoryNumber: TARGET.repositoryNumber,
    contentHash: expectedContentHash,
  });
  assert.deepEqual(reopened.map.completions['phase:04'], {
    logicalKey: 'phase:04',
    nodeId: 'PVTI_item_phase_04',
    issueNumber: 55,
    completedAt: FIXED_NOW,
    owner: TARGET.owner,
    repo: TARGET.repo,
    repositoryNumber: TARGET.repositoryNumber,
    fieldState: expectedFieldState,
  });
  const phaseScopedKeys = Object.keys(reopened.map.completions).filter((key) => key === 'phase:04' || key === 'issue:phase:04' || key.startsWith('phase:') || key.startsWith('issue:phase:'));
  assert.deepEqual(phaseScopedKeys.sort(), ['issue:phase:04', 'phase:04'], 'no third phase-scoped key');

  // Re-running the whole sequence against the resulting map adds no
  // operation for that phase and no new key (the identity invariant).
  const boundRemote = remote([{ id: 'PVTI_item_phase_04', content: { id: 'I_node_phase_04', number: 55 } }]);
  const secondPlan = planReconciliation(singleDesired, boundRemote, reopened);
  assert.deepEqual(secondPlan.operations, []);
  assert.deepEqual(secondPlan.noops, [{ logicalKey: 'phase:04' }]);

  let secondRunDispatched = 0;
  const secondRun = applyMutationPlan(secondPlan, {
    cwd,
    map: reopened.map,
    clock,
    execGh() {
      secondRunDispatched += 1;
      throw new Error('a re-run against the already-bound phase must not dispatch');
    },
    recordCompletion,
    writeSyncMapAtomically,
  });
  assert.equal(secondRun.kind, 'completed');
  assert.equal(secondRunDispatched, 0);
  const finalMap = readSyncMapStrict(cwd, REPOSITORY);
  assert.deepEqual(Object.keys(finalMap.map.completions).sort(), Object.keys(reopened.map.completions).sort(), 'no new key added by the identical re-run');
});

test('two phases in the desired state produce twelve operations grouped by phase in ascending id order, each REST create immediately preceding its own add-to-project and four field writes', () => {
  const twoDesired = desiredTwoPhases(
    { id: '05', title: 'Phase Five', goal: 'g5', requirements: [], status: 'Todo' },
    { id: '04', title: 'Phase Four', goal: 'g4', requirements: [], status: 'Todo' },
  );
  const map = {
    kind: 'valid',
    map: { completions: { [PHASE_MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: PHASE_MILESTONE_NUMBER }, ...fieldBootstrapCompletions() } },
  };

  const plan = planReconciliation(twoDesired, remote([]), map);
  assert.deepEqual(plan.blocked, []);
  assert.deepEqual(plan.operations.map((op) => [op.transport, op.logicalKey]), [
    ['rest', 'issue:phase:04'],
    ['graphql', 'phase:04'],
    ['graphql', 'phase:04'],
    ['graphql', 'phase:04'],
    ['graphql', 'phase:04'],
    ['graphql', 'phase:04'],
    ['rest', 'issue:phase:05'],
    ['graphql', 'phase:05'],
    ['graphql', 'phase:05'],
    ['graphql', 'phase:05'],
    ['graphql', 'phase:05'],
    ['graphql', 'phase:05'],
  ]);
});

// ─── Plan 04-05 Task 3: the four-run convergence sequence, end to end ─────

const SIX_MILESTONE_VERSION = 'v2.0';
const SIX_MILESTONE_KEY = BOOTSTRAP_LOGICAL_KEY.milestone(SIX_MILESTONE_VERSION);
const SIX_MILESTONE_NUMBER = 9;

function desiredOnePhase(phase) {
  return {
    available: true,
    reason: 'ok',
    phases: [phase],
    milestones: [{ version: SIX_MILESTONE_VERSION, name: 'Two', title: `${SIX_MILESTONE_VERSION} — Two`, description: 'd', archived: false }],
  };
}

/** Plan 04-05: the milestone completion plus a fully bootstrapped board's project/field/option completions, under the v2.0 milestone this section's fixtures share. */
function seedFullBootstrapMap(cwd) {
  let map = null;
  map = recordCompletion(map, makeSeedCompletion(SIX_MILESTONE_KEY, 'MI_node_9', SIX_MILESTONE_NUMBER));
  map = recordCompletion(map, makeSeedCompletion(BOOTSTRAP_LOGICAL_KEY.project(), TARGET.projectNodeId, undefined));
  for (const [logicalKey, completion] of Object.entries(fieldBootstrapCompletions())) {
    map = recordCompletion(map, makeSeedCompletion(logicalKey, completion.nodeId, undefined));
  }
  writeSyncMapAtomically(cwd, map);
  const reopened = readSyncMapStrict(cwd, REPOSITORY);
  assert.equal(reopened.kind, 'valid');
  return reopened;
}

test('four-run convergence: create, converge (byte-identical map), update in place preserving developer prose, advance status with no REST call at all — one fully populated phase, driven end to end', (t) => {
  const cwd = createTempProject('github-sync-composition-convergence-');
  t.after(() => cleanup(cwd));

  const basePhase = {
    id: '06',
    title: 'Phase Six',
    goal: 'Ship the whole thing',
    successCriteria: ['First criterion.', 'Second criterion.', 'Third criterion.'],
    requirements: ['PHASE-01', 'PHASE-02', 'PHASE-03'],
    status: 'Todo',
  };
  const clock = fixedClock();

  // ─── First run, empty map: six dispatched operations in order ─────────────
  const seeded = seedFullBootstrapMap(cwd);
  const firstDesired = desiredOnePhase(basePhase);
  const firstPlan = planReconciliation(firstDesired, remote([]), seeded);
  assert.deepEqual(firstPlan.blocked, []);
  assert.equal(firstPlan.operations.length, 6);
  assert.deepEqual(firstPlan.operations.map((op) => op.logicalKey), [
    'issue:phase:06', 'phase:06', 'phase:06', 'phase:06', 'phase:06', 'phase:06',
  ]);
  assert.equal(firstPlan.operations[0].transport, 'rest');
  for (const op of firstPlan.operations.slice(1)) assert.equal(op.transport, 'graphql');

  const restBodyEntry = firstPlan.operations[0].args.find((arg) => typeof arg === 'string' && arg.startsWith('body='));
  const restBody = restBodyEntry.slice('body='.length);
  assert.ok(restBody.includes(phaseMarker('06')));
  assert.ok(restBody.includes(FENCE_BEGIN));
  assert.ok(restBody.includes(FENCE_END));
  assert.ok(restBody.includes(basePhase.goal));
  for (const criterion of basePhase.successCriteria) assert.ok(restBody.includes(criterion));
  for (const requirementId of basePhase.requirements) assert.ok(restBody.includes(requirementId));

  const firstDispatched = [];
  const firstRun = applyMutationPlan(firstPlan, {
    cwd,
    map: seeded.map,
    clock,
    execGh(args) {
      firstDispatched.push(args);
      const callIndex = firstDispatched.length;
      if (callIndex === 1) return restIssueCreateResponse('I_node_06', 600);
      if (callIndex === 2) return response('PVTI_item_06', 600);
      return fieldValueResponse('PVTI_item_06', 600);
    },
    recordCompletion,
    writeSyncMapAtomically,
  });
  assert.equal(firstRun.kind, 'completed');
  assert.equal(firstDispatched.length, 6);

  const afterFirst = readSyncMapStrict(cwd, REPOSITORY);
  assert.equal(afterFirst.kind, 'valid');
  const region1 = renderPhaseRegion(basePhase);
  const expectedHash1 = contentHash({ title: basePhase.title, region: region1, milestoneNumber: SIX_MILESTONE_NUMBER });
  const expectedFieldState1 = renderFieldState({ gsdId: 'phase:06', phaseId: '06', requirements: basePhase.requirements, status: basePhase.status });
  assert.equal(afterFirst.map.completions['issue:phase:06'].contentHash, expectedHash1);
  assert.equal(afterFirst.map.completions['phase:06'].fieldState, expectedFieldState1);
  assert.equal(afterFirst.map.completions['phase:06'].issueNumber, 600);

  // ─── Second run, same input: zero operations, byte-identical map ─────────
  const boundRemote = remote([{ id: 'PVTI_item_06', content: { id: 'I_node_06', number: 600 } }]);
  const secondPlan = planReconciliation(firstDesired, boundRemote, afterFirst);
  assert.deepEqual(secondPlan.operations, []);
  assert.deepEqual(secondPlan.pendingIssueUpdates, []);
  assert.deepEqual(secondPlan.noops, [{ logicalKey: 'phase:06' }]);

  let secondDispatched = 0;
  const secondRun = applyMutationPlan(secondPlan, {
    cwd,
    map: afterFirst.map,
    clock,
    execGh() {
      secondDispatched += 1;
      throw new Error('an unchanged second run must not dispatch');
    },
    recordCompletion,
    writeSyncMapAtomically,
  });
  assert.equal(secondRun.kind, 'completed');
  assert.equal(secondDispatched, 0);
  const afterSecond = readSyncMapStrict(cwd, REPOSITORY);
  assert.equal(afterSecond.kind, 'valid');
  assert.deepEqual(afterSecond.map, afterFirst.map, 'second run\'s persisted map is byte-identical to the first run\'s');

  // ─── Third run, goal edited: zero field operations, one pending update ───
  const editedPhase = { ...basePhase, goal: 'Ship the whole thing, revised' };
  const thirdDesired = desiredOnePhase(editedPhase);
  const thirdPlan = planReconciliation(thirdDesired, boundRemote, afterSecond);
  assert.deepEqual(thirdPlan.operations, []);
  assert.deepEqual(thirdPlan.pendingFieldChanges, []);
  assert.equal(thirdPlan.pendingIssueUpdates.length, 1);

  const developerProseAbove = 'Some prose a developer added above the fence.';
  const developerProseBelow = 'Some prose a developer added below the fence.';
  const oldRegion = renderPhaseRegion(basePhase);
  const fetchedBody = `${phaseMarker('06')}\n${developerProseAbove}\n${FENCE_BEGIN}\n${oldRegion}\n${FENCE_END}\n${developerProseBelow}\n`;

  const prepared = prepareIssueUpdates(thirdPlan.pendingIssueUpdates, {
    cwd,
    execGh(args) {
      assert.deepEqual(args.slice(0, 4), ['api', `repos/${TARGET.owner}/${TARGET.repo}/issues/600`, '-X', 'GET']);
      return { exitCode: 0, stdout: JSON.stringify({ id: 900600, node_id: 'I_node_06', number: 600, body: fetchedBody }), stderr: '' };
    },
  });
  assert.deepEqual(prepared.reports, []);
  assert.equal(prepared.operations.length, 1);
  const patchBodyEntry = prepared.operations[0].args.find((arg) => typeof arg === 'string' && arg.startsWith('body='));
  const patchBody = patchBodyEntry.slice('body='.length);
  assert.ok(patchBody.includes(developerProseAbove));
  assert.ok(patchBody.includes(developerProseBelow));
  assert.ok(patchBody.includes(editedPhase.goal));
  assert.ok(patchBody.indexOf(developerProseAbove) < patchBody.indexOf(developerProseBelow), 'prose above must stay above prose below');
  // Byte-for-byte: everything outside the fences survives exactly, in position.
  assert.ok(patchBody.startsWith(`${phaseMarker('06')}\n${developerProseAbove}\n${FENCE_BEGIN}`));
  assert.ok(patchBody.endsWith(`${FENCE_END}\n${developerProseBelow}\n`));

  const thirdRun = applyMutationPlan({ operations: prepared.operations }, {
    cwd,
    map: afterSecond.map,
    clock,
    execGh(args) {
      assert.ok(args.includes('-X'));
      assert.ok(args.includes('PATCH'));
      return { exitCode: 0, stdout: JSON.stringify({ id: 900600, node_id: 'I_node_06', number: 600 }), stderr: '' };
    },
    recordCompletion,
    writeSyncMapAtomically,
  });
  assert.equal(thirdRun.kind, 'completed');

  const afterThird = readSyncMapStrict(cwd, REPOSITORY);
  assert.equal(afterThird.kind, 'valid');
  const newRegion = renderPhaseRegion(editedPhase);
  const expectedHash3 = contentHash({ title: editedPhase.title, region: newRegion, milestoneNumber: SIX_MILESTONE_NUMBER });
  assert.equal(afterThird.map.completions['issue:phase:06'].contentHash, expectedHash3);
  assert.notEqual(afterThird.map.completions['issue:phase:06'].contentHash, expectedHash1);
  assert.equal(afterThird.map.completions['phase:06'].fieldState, expectedFieldState1, 'the field state is left untouched by the goal-edit run');

  // ─── Fourth run, status advanced only: exactly one field operation, no REST call at all ───
  const advancedPhase = { ...editedPhase, status: 'Done' };
  const fourthDesired = desiredOnePhase(advancedPhase);
  const fourthPlan = planReconciliation(fourthDesired, boundRemote, afterThird);
  assert.deepEqual(fourthPlan.pendingIssueUpdates, []);
  assert.equal(fourthPlan.operations.length, 1);
  assert.equal(fourthPlan.operations[0].args.find((arg) => typeof arg === 'string' && arg.startsWith('fieldId=')), 'fieldId=FIELD_STATUS');

  const fourthDispatched = [];
  const fourthRun = applyMutationPlan(fourthPlan, {
    cwd,
    map: afterThird.map,
    clock,
    execGh(args) {
      fourthDispatched.push(args);
      return fieldValueResponse('PVTI_item_06', 600);
    },
    recordCompletion,
    writeSyncMapAtomically,
  });
  assert.equal(fourthRun.kind, 'completed');
  assert.equal(fourthDispatched.length, 1);
  assert.deepEqual(fourthDispatched[0].slice(0, 2), ['api', 'graphql'], 'advancing status must issue no REST call at all — the D-12 property proven end to end');

  const afterFourth = readSyncMapStrict(cwd, REPOSITORY);
  assert.equal(afterFourth.kind, 'valid');
  const expectedFieldState4 = renderFieldState({ gsdId: 'phase:06', phaseId: '06', requirements: advancedPhase.requirements, status: 'Done' });
  assert.equal(afterFourth.map.completions['phase:06'].fieldState, expectedFieldState4);
  assert.equal(afterFourth.map.completions['phase:06'].issueNumber, 600, 'the field write must still carry the issue number the add-to-project capture stored');

  // ─── Across all four runs: exactly one issue:phase:06 key and one phase:06 key ───
  const phaseScopedKeys = Object.keys(afterFourth.map.completions).filter((key) => key.startsWith('phase:') || key.startsWith('issue:phase:'));
  assert.deepEqual(phaseScopedKeys.sort(), ['issue:phase:06', 'phase:06']);
});

test('interrupted run: killing the sequence after the second of four field writes and re-running re-emits all four (unknown state converges by rewriting) and never emits a duplicate create', (t) => {
  const cwd = createTempProject('github-sync-composition-interrupted-');
  t.after(() => cleanup(cwd));

  const phase = { id: '07', title: 'Phase Seven', goal: 'ship it', successCriteria: [], requirements: [], status: 'Todo' };
  const seeded = seedFullBootstrapMap(cwd);
  const desiredPhase = desiredOnePhase(phase);
  const clock = fixedClock();

  const plan = planReconciliation(desiredPhase, remote([]), seeded);
  assert.deepEqual(plan.blocked, []);
  assert.equal(plan.operations.length, 6);

  // Create + add-to-project + the first two of four field writes succeed;
  // the third field write (the fifth dispatched call overall) "crashes".
  let calls = 0;
  const interruptedRun = applyMutationPlan(plan, {
    cwd,
    map: seeded.map,
    clock,
    execGh(_args) {
      calls += 1;
      if (calls === 1) return restIssueCreateResponse('I_node_07', 700);
      if (calls === 2) return response('PVTI_item_07', 700);
      if (calls <= 4) return fieldValueResponse('PVTI_item_07', 700);
      // Simulate a crash (a non-retryable GitHub failure) on the third field
      // write: applyMutationPlan expects execGh to RETURN a failure result,
      // never to throw — a thrown JS exception here would propagate past
      // the interpreter uncaught rather than exercising its failure path.
      return { exitCode: 1, reason: 'gh_exit_nonzero', stdout: '', stderr: 'simulated crash after the second field write' };
    },
    recordCompletion,
    writeSyncMapAtomically,
  });
  assert.equal(interruptedRun.kind, 'failed');
  assert.equal(calls, 5);

  const afterInterrupted = readSyncMapStrict(cwd, REPOSITORY);
  assert.equal(afterInterrupted.kind, 'valid');
  // The create, the add-to-project, and the first two field writes are all
  // durably recorded (each is its own atomic write) — but `phase:07` carries
  // no field state at all: only the LAST of the four field writes ever
  // carries it, and the sequence never reached the last.
  assert.equal(afterInterrupted.map.completions['phase:07'].fieldState, undefined);
  assert.equal(afterInterrupted.map.completions['phase:07'].nodeId, 'PVTI_item_07');
  assert.equal(afterInterrupted.map.completions['issue:phase:07'].nodeId, 'I_node_07');

  const boundRemote = remote([{ id: 'PVTI_item_07', content: { id: 'I_node_07', number: 700 } }]);
  const resumedPlan = planReconciliation(desiredPhase, boundRemote, afterInterrupted);
  assert.deepEqual(resumedPlan.pendingIssueUpdates, [], 'the issue content already converged and is never re-created');
  assert.equal(resumedPlan.operations.length, 4, 'an unknown field state converges by rewriting all four next run');
  assert.ok(resumedPlan.operations.every((op) => op.kind !== 'create-issue'), 'never a duplicate create');

  let resumedCalls = 0;
  const resumedRun = applyMutationPlan(resumedPlan, {
    cwd,
    map: afterInterrupted.map,
    clock,
    execGh() {
      resumedCalls += 1;
      return fieldValueResponse('PVTI_item_07', 700);
    },
    recordCompletion,
    writeSyncMapAtomically,
  });
  assert.equal(resumedRun.kind, 'completed');
  assert.equal(resumedCalls, 4);

  const finalMap = readSyncMapStrict(cwd, REPOSITORY);
  const finalKeys = Object.keys(finalMap.map.completions).filter((key) => key.startsWith('phase:') || key.startsWith('issue:phase:'));
  assert.deepEqual(finalKeys.sort(), ['issue:phase:07', 'phase:07'], 'exactly two phase-scoped keys after the interruption and its resume');
  assert.equal(finalMap.map.completions['phase:07'].issueNumber, 700, 'the item still carries its issue number after the resumed field writes');
});

// ─── Plan 05-01 Task 1 tracer: one PLAN.md becomes a native sub-issue, ────
// ─── attached to its phase issue and to the board, tasks rendered ────────

const PLAN_MILESTONE_VERSION = 'v1.0';
const PLAN_MILESTONE_KEY = BOOTSTRAP_LOGICAL_KEY.milestone(PLAN_MILESTONE_VERSION);
const PLAN_MILESTONE_NUMBER = 5;

function desiredWithOnePlan(plan) {
  return {
    available: true,
    reason: 'ok',
    phases: [],
    plans: [plan],
    milestones: [{ version: PLAN_MILESTONE_VERSION, name: 'One', title: `${PLAN_MILESTONE_VERSION} — One`, description: 'd', archived: false }],
  };
}

/** Plan 05-01, extended by 05-05: the milestone completion, the parent phase issue's own `issue:phase:<phaseId>` completion, the `project` completion, and the plan item's six field/option completions — the shape a prior Phase 3/4 `init` run would already have recorded. */
function seedPhaseIssueAndMilestoneMap(cwd, phaseId, phaseIssueNodeId) {
  let map = null;
  map = recordCompletion(map, makeSeedCompletion(PLAN_MILESTONE_KEY, 'MI_node_plan', PLAN_MILESTONE_NUMBER));
  map = recordCompletion(map, makeSeedCompletion(`issue:phase:${phaseId}`, phaseIssueNodeId, 40));
  map = recordCompletion(map, makeSeedCompletion(BOOTSTRAP_LOGICAL_KEY.project(), TARGET.projectNodeId, undefined));
  for (const [logicalKey, completion] of Object.entries(planFieldBootstrapCompletions())) {
    map = recordCompletion(map, makeSeedCompletion(logicalKey, completion.nodeId, undefined));
  }
  writeSyncMapAtomically(cwd, map);
  const reopened = readSyncMapStrict(cwd, REPOSITORY);
  assert.equal(reopened.kind, 'valid');
  return reopened;
}

function addSubIssueResponse(issueNodeId, subIssueNodeId, subIssueNumber) {
  return {
    exitCode: 0,
    reason: 'ok',
    stdout: JSON.stringify({
      data: {
        addSubIssue: { issue: { id: issueNodeId }, subIssue: { id: subIssueNodeId, number: subIssueNumber } },
      },
    }),
    stderr: '',
  };
}

test('one PLAN.md on disk, given a phase issue already in the map, produces a native sub-issue of its phase issue and an item on the board, plus its five field writes (Wave omitted, unset), tasks rendered inside the fenced region, checkpointed under issue:plan and plan', (t) => {
  const cwd = createTempProject('github-sync-composition-plan-tracer-');
  t.after(() => cleanup(cwd));

  const plan = {
    id: '04-03',
    phaseId: '04',
    title: '04-03 — Splice a region by severity',
    tasks: ['Task 1: Splice a region by severity', 'Task 2: Content hash and field-state trio'],
    status: 'Todo',
  };
  const singleDesired = desiredWithOnePlan(plan);
  const seeded = seedPhaseIssueAndMilestoneMap(cwd, plan.phaseId, 'I_node_phase_plan_parent');
  const clock = fixedClock();
  const dispatchedArgv = [];

  const reconPlan = planReconciliation(singleDesired, remote([]), seeded);
  assert.deepEqual(reconPlan.blocked, []);
  // Plan 05-05: the create branch now also emits the plan's field writes —
  // gsdId, phaseId, requirements, status, autonomous (Wave omitted since
  // this fixture's plan declares no `wave`, which is `null` by default).
  assert.deepEqual(reconPlan.operations.map((op) => op.logicalKey), [
    'issue:plan:04-03', 'issue:plan:04-03',
    'plan:04-03', 'plan:04-03', 'plan:04-03', 'plan:04-03', 'plan:04-03', 'plan:04-03',
  ]);
  assert.deepEqual(reconPlan.operations.map((op) => op.transport), [
    'rest', 'graphql', 'graphql', 'graphql', 'graphql', 'graphql', 'graphql', 'graphql',
  ]);

  const run = applyMutationPlan(reconPlan, {
    cwd,
    map: seeded.map,
    clock,
    execGh(args) {
      dispatchedArgv.push(args);
      const callIndex = dispatchedArgv.length;
      if (callIndex === 1) {
        assert.deepEqual(args.slice(0, 4), ['api', `repos/${TARGET.owner}/${TARGET.repo}/issues`, '-X', 'POST']);
        return restIssueCreateResponse('I_node_plan_0403', 88);
      }
      if (callIndex === 2) {
        assert.ok(args.includes('issueId=I_node_phase_plan_parent'), 'addSubIssue must late-bind the parent phase issue\'s own completion');
        assert.ok(args.includes('subIssueId=I_node_plan_0403'), 'addSubIssue must late-bind this run\'s own create capture');
        return addSubIssueResponse('I_node_phase_plan_parent', 'I_node_plan_0403', 88);
      }
      if (callIndex === 3) {
        assert.ok(args.includes('contentId=I_node_plan_0403'), 'add-to-project must late-bind the create capture within the same run');
        return response('PVTI_item_plan_0403', 88);
      }
      // The five field-value calls: each late-binds its item id to the
      // add-to-project operation's own capture, recorded earlier in this
      // same run under the same `plan:04-03` logical key.
      assert.ok(args.includes('itemId=PVTI_item_plan_0403'), 'a field write must late-bind to the add-to-project operation\'s own capture within the same run');
      return fieldValueResponse('PVTI_item_plan_0403', 88);
    },
    recordCompletion,
    writeSyncMapAtomically,
  });
  assert.equal(run.kind, 'completed');
  assertOpaqueIdPairs(dispatchedArgv);
  assert.equal(dispatchedArgv.length, 8, 'three content-creating operations plus five field writes for one plan');

  const reopened = readSyncMapStrict(cwd, REPOSITORY);
  assert.equal(reopened.kind, 'valid');
  assert.equal(reopened.map.completions['issue:plan:04-03'].nodeId, 'I_node_plan_0403');
  assert.equal(reopened.map.completions['issue:plan:04-03'].issueNumber, 88);
  assert.equal(reopened.map.completions['plan:04-03'].nodeId, 'PVTI_item_plan_0403');
  const expectedFieldState = renderFieldState(
    { gsdId: 'plan:04-03', phaseId: '04', requirements: [], status: 'Todo', wave: null, autonomous: false },
    PLAN_FIELD_NAMES,
  );
  assert.equal(reopened.map.completions['plan:04-03'].fieldState, expectedFieldState);

  // The created body's five-part shape: marker, begin fence, region, end
  // fence, one trailing newline — the same shape renderNewIssueBody produces
  // for a phase — and the tasks render inside it.
  const restBodyEntry = reconPlan.operations[0].args.find((arg) => typeof arg === 'string' && arg.startsWith('body='));
  const restBody = restBodyEntry.slice('body='.length);
  const bodyLines = restBody.split('\n');
  assert.equal(bodyLines[0], planMarker(plan.id));
  assert.equal(bodyLines[1], FENCE_BEGIN);
  assert.equal(bodyLines[bodyLines.length - 2], FENCE_END);
  assert.equal(bodyLines[bodyLines.length - 1], '');
  for (const taskName of plan.tasks) assert.ok(restBody.includes(taskName));
  assert.doesNotMatch(restBody, /\[ \]/);
  assert.doesNotMatch(restBody, /\[x\]/i);

  // Re-running against the resulting (now-bound) map emits zero further operations.
  const boundRemote = remote([{ id: 'PVTI_item_plan_0403', content: { id: 'I_node_plan_0403', number: 88 } }]);
  const secondPlan = planReconciliation(singleDesired, boundRemote, reopened);
  assert.deepEqual(secondPlan.operations, []);
  assert.deepEqual(secondPlan.blocked, []);
  assert.deepEqual(secondPlan.noops, [{ logicalKey: 'plan:04-03' }]);

  let secondRunDispatched = 0;
  const secondRun = applyMutationPlan(secondPlan, {
    cwd,
    map: reopened.map,
    clock,
    execGh() {
      secondRunDispatched += 1;
      throw new Error('a re-run against the already-bound plan must not dispatch');
    },
    recordCompletion,
    writeSyncMapAtomically,
  });
  assert.equal(secondRun.kind, 'completed');
  assert.equal(secondRunDispatched, 0);
});

// ─── Plan 05-05 Task 3: the four-run offline convergence proof for plans ──

const PLAN_FOUR_RUN_MILESTONE_VERSION = 'v3.0';
const PLAN_FOUR_RUN_MILESTONE_KEY = BOOTSTRAP_LOGICAL_KEY.milestone(PLAN_FOUR_RUN_MILESTONE_VERSION);
const PLAN_FOUR_RUN_MILESTONE_NUMBER = 12;

function fourRunPlansDesired(planA, planB) {
  return {
    available: true,
    reason: 'ok',
    phases: [],
    plans: [planA, planB],
    milestones: [{ version: PLAN_FOUR_RUN_MILESTONE_VERSION, name: 'Three', title: `${PLAN_FOUR_RUN_MILESTONE_VERSION} — Three`, description: 'd', archived: false }],
  };
}

/** The milestone completion, the parent phase issue's own completion, the `project` completion, and the plan item's six field/option completions — a fully bootstrapped board plus one prior phase sync. */
function seedPlanFourRunMap(cwd) {
  let map = null;
  map = recordCompletion(map, makeSeedCompletion(PLAN_FOUR_RUN_MILESTONE_KEY, 'MI_node_four_run', PLAN_FOUR_RUN_MILESTONE_NUMBER));
  map = recordCompletion(map, makeSeedCompletion(BOOTSTRAP_LOGICAL_KEY.project(), TARGET.projectNodeId, undefined));
  map = recordCompletion(map, makeSeedCompletion('issue:phase:08', 'I_node_phase_four_run_parent', 200));
  for (const [logicalKey, completion] of Object.entries(planFieldBootstrapCompletions())) {
    map = recordCompletion(map, makeSeedCompletion(logicalKey, completion.nodeId, undefined));
  }
  writeSyncMapAtomically(cwd, map);
  const reopened = readSyncMapStrict(cwd, REPOSITORY);
  assert.equal(reopened.kind, 'valid');
  return reopened;
}

test('four-run offline convergence: a phase issue already in the map plus two plans — run one dispatches the full create-and-field-write set, runs two through four dispatch nothing', (t) => {
  const cwd = createTempProject('github-sync-composition-plan-four-run-');
  t.after(() => cleanup(cwd));

  const planA = { id: '08-01', phaseId: '08', title: '08-01 — Plan A', tasks: ['Task 1: A1'], status: 'Todo', wave: 1, autonomous: true, requirements: ['PLAN-01'] };
  const planB = { id: '08-02', phaseId: '08', title: '08-02 — Plan B', tasks: ['Task 1: B1'], status: 'Todo', wave: 1, autonomous: false, requirements: [] };
  const desiredPlans = fourRunPlansDesired(planA, planB);
  const seeded = seedPlanFourRunMap(cwd);
  const clock = fixedClock();

  // ─── Run 1: create everything (2 plans x [3 create ops + 6 field writes]) ─
  const firstPlan = planReconciliation(desiredPlans, remote([]), seeded);
  assert.deepEqual(firstPlan.blocked, []);
  assert.equal(firstPlan.operations.length, 18);

  let currentPlanNodeId = null;
  let currentPlanNumber = null;
  let currentPlanItemId = null;
  let callCount = 0;
  const firstDispatched = [];
  function fourRunExecGh(args) {
    firstDispatched.push(args);
    callCount += 1;
    if (args[0] === 'api' && args[2] === '-X' && args[3] === 'POST') {
      currentPlanNodeId = `I_node_plan_run1_${callCount}`;
      currentPlanNumber = 900 + callCount;
      return restIssueCreateResponse(currentPlanNodeId, currentPlanNumber);
    }
    const queryArg = args.find((arg) => typeof arg === 'string' && arg.startsWith('query='));
    if (queryArg && queryArg.includes('addSubIssue')) {
      return addSubIssueResponse('I_node_phase_four_run_parent', currentPlanNodeId, currentPlanNumber);
    }
    if (queryArg && queryArg.includes('addProjectV2ItemById')) {
      currentPlanItemId = `PVTI_item_plan_run1_${callCount}`;
      return response(currentPlanItemId, currentPlanNumber);
    }
    return fieldValueResponse(currentPlanItemId, currentPlanNumber);
  }

  const firstRun = applyMutationPlan(firstPlan, {
    cwd, map: seeded.map, clock, execGh: fourRunExecGh, recordCompletion, writeSyncMapAtomically,
  });
  assert.equal(firstRun.kind, 'completed');
  assert.equal(firstDispatched.length, 18);

  const afterFirst = readSyncMapStrict(cwd, REPOSITORY);
  assert.equal(afterFirst.kind, 'valid');

  // The bound remote every subsequent run reads: one project item per plan,
  // matching the `plan:<id>` completion's own recorded node id.
  const boundItems = Object.entries(afterFirst.map.completions)
    .filter(([key]) => key.startsWith('plan:'))
    .map(([, completion]) => ({ id: completion.nodeId, content: { id: 'ignored', number: completion.issueNumber } }));
  assert.equal(boundItems.length, 2);

  // ─── Run 2: zero operations, zero dispatches ───────────────────────────
  const secondReconPlan = planReconciliation(desiredPlans, remote(boundItems), afterFirst);
  assert.deepEqual(secondReconPlan.operations, []);
  assert.deepEqual(secondReconPlan.blocked, []);

  let secondDispatched = 0;
  const secondRun = applyMutationPlan(secondReconPlan, {
    cwd, map: afterFirst.map, clock,
    execGh() { secondDispatched += 1; throw new Error('run two must not dispatch'); },
    recordCompletion, writeSyncMapAtomically,
  });
  assert.equal(secondRun.kind, 'completed');
  assert.equal(secondDispatched, 0);
  const afterSecond = readSyncMapStrict(cwd, REPOSITORY);
  assert.equal(afterSecond.kind, 'valid');

  // ─── Run 3: zero operations, zero dispatches ───────────────────────────
  const thirdReconPlan = planReconciliation(desiredPlans, remote(boundItems), afterSecond);
  assert.deepEqual(thirdReconPlan.operations, []);
  let thirdDispatched = 0;
  const thirdRun = applyMutationPlan(thirdReconPlan, {
    cwd, map: afterSecond.map, clock,
    execGh() { thirdDispatched += 1; throw new Error('run three must not dispatch'); },
    recordCompletion, writeSyncMapAtomically,
  });
  assert.equal(thirdRun.kind, 'completed');
  assert.equal(thirdDispatched, 0);
  const afterThird = readSyncMapStrict(cwd, REPOSITORY);
  assert.equal(afterThird.kind, 'valid');

  // ─── Run 4: zero operations, zero dispatches ───────────────────────────
  const fourthReconPlan = planReconciliation(desiredPlans, remote(boundItems), afterThird);
  assert.deepEqual(fourthReconPlan.operations, []);
  let fourthDispatched = 0;
  const fourthRun = applyMutationPlan(fourthReconPlan, {
    cwd, map: afterThird.map, clock,
    execGh() { fourthDispatched += 1; throw new Error('run four must not dispatch'); },
    recordCompletion, writeSyncMapAtomically,
  });
  assert.equal(fourthRun.kind, 'completed');
  assert.equal(fourthDispatched, 0);

  assert.deepEqual([firstDispatched.length, secondDispatched, thirdDispatched, fourthDispatched], [18, 0, 0, 0]);
});
