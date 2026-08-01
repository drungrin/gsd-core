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
const ID_ALLOWLIST = new Set(['PVT_proj_node_1', 'I_node_101', 'I_node_102']);

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
        rateLimit: { cost: 1, remaining: 5000, resetAt: '2026-07-30T22:00:00.000Z' },
        addProjectV2Item: { projectV2Item: { id: nodeId, content: { number: issueNumber } } },
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

function writeSeededMap(_cwd) {
  assert.fail('TODO: seed the map only through recordCompletion() and writeSyncMapAtomically()');
}

function assertOpaqueIdPairs(_argvCalls) {
  assert.fail('TODO: assert every ID-typed -F value belongs to the opaque node-ID allowlist');
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
  assert.deepEqual(firstRun, {
    kind: 'failed',
    logicalKey: 'phase:02',
    remediation: 'Retry the sync after resolving the reported GitHub failure.',
  });
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

  const unchanged = readSyncMapStrict(cwd, REPOSITORY);
  assert.equal(unchanged.kind, 'valid');
  const unchangedPlan = planReconciliation(
    desired(),
    remote([
      { id: 'PVTI_item_1', content: { id: 'I_node_101', number: 101 } },
      { id: 'PVTI_item_2', content: { id: 'I_node_102', number: 102 } },
    ]),
    unchanged,
  );
  assert.equal(unchangedPlan.operations.length, 0);
  assert.deepEqual(unchangedPlan.noops, [{ logicalKey: 'phase:01' }, { logicalKey: 'phase:02' }]);

  let unexpectedCalls = 0;
  const unchangedResult = applyMutationPlan(unchangedPlan, {
    cwd,
    map: unchanged.map,
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

test('identity-unresolvable absent-map run dispatches nothing and leaves no map file behind', (t) => {
  const cwd = createTempProject('github-sync-composition-absent-');
  t.after(() => cleanup(cwd));

  const absent = readSyncMapStrict(cwd, REPOSITORY);
  assert.deepEqual(absent, { kind: 'absent' });

  const plan = planReconciliation(desired(), remote(), absent);
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.noops, []);
  assert.deepEqual(plan.blocked, [
    { reason: OPERATION_REASON.IDENTITY_UNRESOLVABLE, detail: 'phase:01' },
    { reason: OPERATION_REASON.IDENTITY_UNRESOLVABLE, detail: 'phase:02' },
  ]);

  let dispatched = 0;
  const result = applyMutationPlan(plan, {
    cwd,
    map: null,
    clock: fixedClock(),
    execGh() {
      dispatched += 1;
      throw new Error('identity-unresolvable plan must not dispatch');
    },
    recordCompletion,
    writeSyncMapAtomically,
  });
  assert.equal(result.kind, 'completed');
  assert.equal(dispatched, 0);
  assert.equal(fs.existsSync(syncMapPath(cwd)), false);
});
