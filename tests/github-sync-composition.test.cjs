'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTempProject, cleanup } = require('./helpers.cjs');
const { makeFakeClock } = require('./helpers/clock.cjs');
const { planReconciliation } = require('../gsd-core/bin/lib/github-sync-reconcile.cjs');
const { applyMutationPlan } = require('../gsd-core/bin/lib/github-sync-apply.cjs');
const { readSyncMapStrict, recordCompletion, writeSyncMapAtomically } = require('../gsd-core/bin/lib/github-sync-map.cjs');

const TARGET = { owner: 'octo', repo: 'roadmap', repositoryNumber: 42, projectNumber: 7, projectNodeId: 'PVT_proj_node_1' };
const REPOSITORY = { owner: TARGET.owner, repo: TARGET.repo, number: TARGET.repositoryNumber };
const FIXED_NOW = '2026-07-30T21:00:00.000Z';

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
    issueNodeIds: { 101: 'ISSUE_NODE_101', 102: 'ISSUE_NODE_102' },
  };
}

function response(nodeId, issueNumber) {
  return {
    exitCode: 0,
    reason: 'ok',
    stdout: JSON.stringify({ data: {
      rateLimit: { cost: 1, remaining: 5000, resetAt: '2026-07-30T22:00:00.000Z' },
      addProjectV2Item: { projectV2Item: { id: nodeId, content: { number: issueNumber } } },
    } }),
    stderr: '',
  };
}

test('real reconciler, applier, and strict map resume each response-validated checkpoint without duplicate argv', (t) => {
  const cwd = createTempProject('github-sync-composition-');
  t.after(() => cleanup(cwd));
  const clock = makeFakeClock(Date.parse(FIXED_NOW));
  clock.nowIso = () => FIXED_NOW;
  const argv = [];
  const initialMap = {
    version: '1',
    repository: REPOSITORY,
    completions: {
      'phase:01': {
        logicalKey: 'phase:01',
        nodeId: 'ISSUE_NODE_101',
        issueNumber: 101,
        completedAt: FIXED_NOW,
        owner: TARGET.owner,
        repo: TARGET.repo,
        repositoryNumber: TARGET.repositoryNumber,
      },
      'phase:02': {
        logicalKey: 'phase:02',
        nodeId: 'ISSUE_NODE_102',
        issueNumber: 102,
        completedAt: FIXED_NOW,
        owner: TARGET.owner,
        repo: TARGET.repo,
        repositoryNumber: TARGET.repositoryNumber,
      },
    },
  };

  const firstPlan = planReconciliation(desired(), remote(), { kind: 'valid', map: initialMap });
  assert.equal(firstPlan.operations.length, 2);
  const firstRun = applyMutationPlan(firstPlan, {
    cwd,
    map: initialMap,
    clock,
    execGh(args) {
      argv.push(args);
      return argv.length === 1
        ? response('PVT_item_one', 101)
        : { exitCode: 1, reason: 'gh_exit_nonzero', stdout: '', stderr: 'semantic failure' };
    },
    recordCompletion,
    writeSyncMapAtomically,
  });
  assert.deepEqual(firstRun, {
    kind: 'failed', logicalKey: 'phase:02', remediation: 'Retry the sync after resolving the reported GitHub failure.',
  });

  const reopened = readSyncMapStrict(cwd, REPOSITORY);
  assert.equal(reopened.kind, 'valid');
  assert.deepEqual(reopened.map.completions['phase:01'], {
    logicalKey: 'phase:01', nodeId: 'PVT_item_one', issueNumber: 101, completedAt: FIXED_NOW,
    owner: TARGET.owner, repo: TARGET.repo, repositoryNumber: TARGET.repositoryNumber,
  });

  const resumedPlan = planReconciliation(
    desired(),
    remote([{ id: 'PVT_item_one', content: { id: 'ISSUE_NODE_101', number: 101 } }]),
    reopened,
  );
  assert.deepEqual(resumedPlan.operations.map((operation) => operation.logicalKey), ['phase:02']);
  const firstArgv = argv[0];
  const resumed = applyMutationPlan(resumedPlan, {
    cwd,
    map: reopened.map,
    clock,
    execGh(args) {
      argv.push(args);
      return response('PVT_item_two', 102);
    },
    recordCompletion,
    writeSyncMapAtomically,
  });
  assert.equal(resumed.kind, 'completed');
  assert.deepEqual(argv.map((args) => args.at(-1)), ['contentId=ISSUE_NODE_101', 'contentId=ISSUE_NODE_102', 'contentId=ISSUE_NODE_102']);
  assert.notDeepEqual(firstArgv, argv[2], 'the resumed operation must not duplicate the confirmed first-run argv');

  const unchanged = readSyncMapStrict(cwd, REPOSITORY);
  assert.equal(unchanged.kind, 'valid');
  const unchangedPlan = planReconciliation(
    desired(),
    remote([
      { id: 'PVT_item_one', content: { id: 'ISSUE_NODE_101', number: 101 } },
      { id: 'PVT_item_two', content: { id: 'ISSUE_NODE_102', number: 102 } },
    ]),
    unchanged,
  );
  assert.equal(unchangedPlan.operations.length, 0);
  let unexpectedCalls = 0;
  assert.equal(applyMutationPlan(unchangedPlan, {
    cwd,
    map: unchanged.map,
    clock,
    execGh() { unexpectedCalls += 1; throw new Error('unchanged state must not dispatch'); },
    recordCompletion,
    writeSyncMapAtomically,
  }).kind, 'completed');
  assert.equal(unexpectedCalls, 0);
});
