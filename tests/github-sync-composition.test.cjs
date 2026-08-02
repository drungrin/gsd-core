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
]);
const { BOOTSTRAP_LOGICAL_KEY } = require('../gsd-core/bin/lib/github-sync-bootstrap-plan.cjs');

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
  assert.ok([...new Set(idPairs.map(({ key }) => key))].every((key) => key === 'contentId' || key === 'projectId'));
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

function seedMilestoneOnlyMap(cwd) {
  let map = null;
  map = recordCompletion(map, makeSeedCompletion(PHASE_MILESTONE_KEY, 'MI_node_1', PHASE_MILESTONE_NUMBER));
  writeSyncMapAtomically(cwd, map);
  const reopened = readSyncMapStrict(cwd, REPOSITORY);
  assert.equal(reopened.kind, 'valid');
  return reopened;
}

test('one roadmap phase travels end-to-end: REST create then add-to-project, both identity keys recorded, no third phase-scoped key', (t) => {
  const cwd = createTempProject('github-sync-composition-tracer-');
  t.after(() => cleanup(cwd));

  const phase = { id: '04', title: 'Phase Four', goal: 'ship the tracer' };
  const singleDesired = desiredSinglePhase(phase);
  const seeded = seedMilestoneOnlyMap(cwd);
  const clock = fixedClock();
  const dispatchedArgv = [];

  const plan = planReconciliation(singleDesired, remote([]), seeded);
  assert.deepEqual(plan.blocked, []);
  assert.deepEqual(plan.operations.map((op) => op.logicalKey), ['issue:phase:04', 'phase:04']);
  assert.equal(plan.operations[0].transport, 'rest');
  assert.equal(plan.operations[1].transport, 'graphql');

  const run = applyMutationPlan(plan, {
    cwd,
    map: seeded.map,
    clock,
    execGh(args) {
      dispatchedArgv.push(args);
      if (dispatchedArgv.length === 1) {
        // The REST create call: its milestone= value must already be
        // resolved from the seeded map (late-bound, not hardcoded).
        assert.ok(args.includes(`milestone=${PHASE_MILESTONE_NUMBER}`), 'REST create must carry the milestone number resolved from the map');
        return restIssueCreateResponse('I_node_phase_04', 55);
      }
      // The add-to-project call: its contentId must be the REST create's own
      // capture from THIS SAME run, not any value known ahead of time.
      assert.ok(args.includes('contentId=I_node_phase_04'), 'add-to-project must late-bind to the REST create\'s own capture within the same run');
      return response('PVTI_item_phase_04', 55);
    },
    recordCompletion,
    writeSyncMapAtomically,
  });
  assert.equal(run.kind, 'completed');
  assertOpaqueIdPairs(dispatchedArgv);

  const reopened = readSyncMapStrict(cwd, REPOSITORY);
  assert.equal(reopened.kind, 'valid');
  assert.deepEqual(reopened.map.completions['issue:phase:04'], {
    logicalKey: 'issue:phase:04',
    nodeId: 'I_node_phase_04',
    issueNumber: 55,
    completedAt: FIXED_NOW,
    owner: TARGET.owner,
    repo: TARGET.repo,
    repositoryNumber: TARGET.repositoryNumber,
  });
  assert.deepEqual(reopened.map.completions['phase:04'], {
    logicalKey: 'phase:04',
    nodeId: 'PVTI_item_phase_04',
    issueNumber: 55,
    completedAt: FIXED_NOW,
    owner: TARGET.owner,
    repo: TARGET.repo,
    repositoryNumber: TARGET.repositoryNumber,
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

test('two phases in the desired state produce four operations grouped by phase in ascending id order, each REST create immediately preceding its own add-to-project', () => {
  const twoDesired = desiredTwoPhases(
    { id: '05', title: 'Phase Five', goal: 'g5' },
    { id: '04', title: 'Phase Four', goal: 'g4' },
  );
  const map = { kind: 'valid', map: { completions: { [PHASE_MILESTONE_KEY]: { nodeId: 'MI_node_1', issueNumber: PHASE_MILESTONE_NUMBER } } } };

  const plan = planReconciliation(twoDesired, remote([]), map);
  assert.deepEqual(plan.blocked, []);
  assert.deepEqual(plan.operations.map((op) => [op.transport, op.logicalKey]), [
    ['rest', 'issue:phase:04'],
    ['graphql', 'phase:04'],
    ['rest', 'issue:phase:05'],
    ['graphql', 'phase:05'],
  ]);
});
