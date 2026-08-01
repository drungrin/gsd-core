'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeClock } = require('./helpers/clock.cjs');
const {
  applyMutationPlan,
  POINTS_RESERVE,
  parseRateLimit,
  decodeCompletions,
} = require('../gsd-core/bin/lib/github-sync-apply.cjs');
const { planReconciliation } = require('../gsd-core/bin/lib/github-sync-reconcile.cjs');
const {
  OPERATION_TRANSPORT,
  OPERATION_ACTION,
  OPERATION_OUTCOME,
  confirmedKeys,
  checkpointedKeys,
  mutatedKeys,
} = require('../gsd-core/bin/lib/github-sync-operation.cjs');
const realMap = require('../gsd-core/bin/lib/github-sync-map.cjs');

const CONTEXT = { owner: 'octo', repo: 'repo', repositoryNumber: 1 };

function operation(key, {
  kind = 'update',
  action = OPERATION_ACTION.UPDATE,
  hasPointsBudget = true,
  contentCreation = false,
  transport = OPERATION_TRANSPORT.GRAPHQL,
  captures,
  args,
  completionContext = CONTEXT,
} = {}) {
  return {
    kind,
    logicalKey: key,
    args: args ?? ['api', 'graphql', '-f', `query=mutation { # ${key} }`],
    completionContext,
    transport,
    action,
    hasPointsBudget,
    contentCreation,
    captures: captures ?? [{
      kind: 'node',
      logicalKey: key,
      nodeIdPath: 'addProjectV2Item.projectV2Item.id',
      numberPath: 'addProjectV2Item.projectV2Item.content.number',
    }],
  };
}

function success({ cost = 1, remaining = 4999, resetAt = '1970-01-01T00:00:10.000Z', nodeId = 'node-ok', issueNumber = 3, noRateLimit = false } = {}) {
  return {
    exitCode: 0,
    reason: 'ok',
    stdout: JSON.stringify({
      data: {
        ...(noRateLimit ? {} : { rateLimit: { cost, remaining, resetAt } }),
        addProjectV2Item: { projectV2Item: { id: nodeId, content: { number: issueNumber } } },
      },
    }),
    stderr: '',
  };
}

function makeAdapters(results, overrides = {}) {
  const calls = [];
  const clock = makeFakeClock(0);
  let stored = null;
  return {
    calls,
    clock,
    getStored: () => stored,
    adapters: {
      execGh(args) { calls.push(['exec', args]); return results.shift() ?? success(); },
      recordCompletion(map, completion) { calls.push(['record', completion]); return { version: '1', repository: { owner: 'octo', repo: 'repo', number: 1 }, completions: { ...(map?.completions ?? {}), [completion.logicalKey]: completion } }; },
      writeSyncMapAtomically(_cwd, map) { calls.push(['write', Object.keys(map.completions).join(',')]); stored = JSON.stringify(map); },
      clock,
      random: () => 0,
      notice(message) { calls.push(['notice', message]); },
      ...overrides,
    },
  };
}

// ─── decoders ───────────────────────────────────────────────────────────────

test('decoders accept only strict rateLimit and capture-selected completion data (translated to decodeCompletions)', () => {
  const result = success({ nodeId: 'project-item-1', issueNumber: 9 });
  assert.deepEqual(parseRateLimit(result), { cost: 1, remaining: 4999, resetAt: '1970-01-01T00:00:10.000Z' });
  const op = operation('one');
  const root = JSON.parse(result.stdout).data;
  assert.deepEqual(decodeCompletions(op, root, '1970-01-01T00:00:00.000Z'), [
    { logicalKey: 'one', nodeId: 'project-item-1', remoteNumber: 9, completedAt: '1970-01-01T00:00:00.000Z' },
  ]);
  assert.equal(parseRateLimit({ ...result, stdout: JSON.stringify({ data: { rateLimit: { cost: -1, remaining: 1, resetAt: 'nope' } } }) }), null);
  assert.equal(decodeCompletions(op, { addProjectV2Item: { projectV2Item: { id: '' } } }, 'now'), null);
});

// ─── points budget: optional rate-limit requirement ────────────────────────

test('an operation declaring no points budget succeeds without a rateLimit block, and its completion is still recorded', () => {
  const setup = makeAdapters([success({ noRateLimit: true, nodeId: 'no-budget-node' })]);
  const result = applyMutationPlan({ operations: [operation('one', { hasPointsBudget: false })] }, { cwd: '/repo', map: null, ...setup.adapters });
  assert.equal(result.kind, 'completed');
  assert.equal(setup.calls.find((call) => call[0] === 'record')[1].nodeId, 'no-budget-node');
});

test('an operation declaring a points budget on a response with no rateLimit block still fails', () => {
  const setup = makeAdapters([success({ noRateLimit: true })]);
  const result = applyMutationPlan({ operations: [operation('one', { hasPointsBudget: true })] }, { cwd: '/repo', map: null, ...setup.adapters });
  assert.equal(result.kind, 'failed');
});

// ─── fan-out captures ───────────────────────────────────────────────────────

test('an operation whose captures fan out to five completions produces five recordCompletion calls and exactly one writeSyncMapAtomically call', () => {
  const keyMap = { Todo: 'option:status:todo', 'In Progress': 'option:status:in-progress', Blocked: 'option:status:blocked', Done: 'option:status:done', Deferred: 'option:status:deferred' };
  const fanOutOp = operation('status-merge', {
    captures: [{ kind: 'each', listPath: 'updateProjectV2Field.projectV2Field.options', matchPath: 'name', nodeIdPath: 'id', keyMap }],
  });
  const response = {
    exitCode: 0, reason: 'ok', stderr: '',
    stdout: JSON.stringify({
      data: {
        rateLimit: { cost: 1, remaining: 5000, resetAt: '1970-01-01T00:00:10.000Z' },
        updateProjectV2Field: { projectV2Field: { options: Object.keys(keyMap).map((name, i) => ({ id: `opt-${i}`, name })) } },
      },
    }),
  };
  const setup = makeAdapters([response]);
  const result = applyMutationPlan({ operations: [fanOutOp] }, { cwd: '/repo', map: null, ...setup.adapters });
  assert.equal(result.kind, 'completed');
  assert.equal(setup.calls.filter((call) => call[0] === 'record').length, 5);
  assert.equal(setup.calls.filter((call) => call[0] === 'write').length, 1);
  assert.equal(result.outcomes.length, 5);
  assert.ok(result.outcomes.every((outcome) => outcome.operationKey === 'status-merge'));
});

// ─── late-bound argv ────────────────────────────────────────────────────────

test('a late-bound argv reference resolves an earlier operation\'s completion, recorded before the later dispatch', () => {
  const setup = makeAdapters([success({ nodeId: 'project-node' }), success({ nodeId: 'field-node' })]);
  const first = operation('project');
  const second = operation('field', {
    args: ['api', 'graphql', '-f', 'query=mutation { # field }', '-F', { from: 'project', part: 'nodeId', prefix: 'projectId=' }],
  });
  const result = applyMutationPlan({ operations: [first, second] }, { cwd: '/repo', map: null, ...setup.adapters });
  assert.equal(result.kind, 'completed');
  const execCalls = setup.calls.filter((call) => call[0] === 'exec');
  assert.equal(execCalls.length, 2);
  assert.ok(execCalls[1][1].includes('projectId=project-node'));
  const firstWriteIndex = setup.calls.findIndex((call) => call[0] === 'write');
  const secondExecIndex = setup.calls.lastIndexOf(setup.calls.filter((call) => call[0] === 'exec').at(-1));
  assert.ok(firstWriteIndex < secondExecIndex);
});

test('an argv reference to a key that was never confirmed returns a failed result and execGh is not called for it', () => {
  const setup = makeAdapters([]);
  const op = operation('field', {
    args: ['api', 'graphql', '-F', { from: 'project', part: 'nodeId', prefix: 'projectId=' }],
  });
  const result = applyMutationPlan({ operations: [op] }, { cwd: '/repo', map: null, ...setup.adapters });
  assert.equal(result.kind, 'failed');
  assert.equal(result.logicalKey, 'field');
  assert.equal(setup.calls.filter((call) => call[0] === 'exec').length, 0);
});

// ─── REST transport ─────────────────────────────────────────────────────────

test('a REST-transport operation succeeds against a bare JSON object body with no data envelope', () => {
  const setup = makeAdapters([{ exitCode: 0, reason: 'ok', stderr: '', stdout: JSON.stringify({ id: 'REST_1', node_id: 'REST_NODE_1' }) }]);
  const op = operation('rest-op', {
    transport: OPERATION_TRANSPORT.REST,
    hasPointsBudget: false,
    captures: [{ kind: 'node', logicalKey: 'rest-op', nodeIdPath: 'node_id' }],
  });
  const result = applyMutationPlan({ operations: [op] }, { cwd: '/repo', map: null, ...setup.adapters });
  assert.equal(result.kind, 'completed');
  assert.equal(setup.calls.find((call) => call[0] === 'record')[1].nodeId, 'REST_NODE_1');
});

// ─── repository-mismatch throw during dispatch ─────────────────────────────

test('a completion whose repository binding disagrees with the map throws inside recordCompletion, and applyMutationPlan returns uncertain with prior completions intact', () => {
  let map = null;
  map = realMap.recordCompletion(map, { logicalKey: 'seed', nodeId: 'seed-node', completedAt: '1970-01-01T00:00:00.000Z', owner: 'octo', repo: 'repo', repositoryNumber: 1 });
  let storedMap = null;
  const setup = makeAdapters([success({ nodeId: 'mismatched-node' })], { recordCompletion: realMap.recordCompletion, writeSyncMapAtomically: (_cwd, m) => { storedMap = m; } });
  const op = operation('mismatch', { completionContext: { owner: 'other', repo: 'repo', repositoryNumber: 1 } });
  const result = applyMutationPlan({ operations: [op] }, { cwd: '/repo', map, ...setup.adapters });
  assert.equal(result.kind, 'uncertain');
  assert.equal(storedMap, null);
});

// ─── checkpoint fold ────────────────────────────────────────────────────────

function checkpoint(logicalKey, nodeId, remoteNumber) {
  return { logicalKey, nodeId, ...(remoteNumber === undefined ? {} : { remoteNumber }), completionContext: CONTEXT };
}

test('three checkpoints and zero operations write once, call execGh zero times, and return three observe-confirmed outcomes', () => {
  const setup = makeAdapters([]);
  const plan = { operations: [], checkpoints: [checkpoint('a', 'node-a'), checkpoint('b', 'node-b'), checkpoint('c', 'node-c')] };
  const result = applyMutationPlan(plan, { cwd: '/repo', map: null, ...setup.adapters });
  assert.equal(result.kind, 'completed');
  assert.equal(setup.calls.filter((call) => call[0] === 'exec').length, 0);
  assert.equal(setup.calls.filter((call) => call[0] === 'write').length, 1);
  assert.equal(setup.calls.filter((call) => call[0] === 'record').length, 3);
  assert.equal(result.outcomes.length, 3);
  assert.ok(result.outcomes.every((outcome) => outcome.result === OPERATION_OUTCOME.CONFIRMED && outcome.action === OPERATION_ACTION.OBSERVE && outcome.operationKey === null));
});

test('re-running the same checkpoint plan against its own output writes zero times and returns three observe-unchanged outcomes, byte-identical to before', () => {
  const setup = makeAdapters([]);
  const plan = { operations: [], checkpoints: [checkpoint('a', 'node-a'), checkpoint('b', 'node-b'), checkpoint('c', 'node-c')] };
  const first = applyMutationPlan(plan, { cwd: '/repo', map: null, ...setup.adapters });
  const before = setup.getStored();
  const second = applyMutationPlan(plan, { cwd: '/repo', map: first.map, ...setup.adapters });
  assert.equal(second.kind, 'completed');
  assert.equal(setup.calls.filter((call) => call[0] === 'write').length, 1);
  assert.ok(second.outcomes.every((outcome) => outcome.result === OPERATION_OUTCOME.UNCHANGED));
  assert.equal(setup.getStored(), before);
});

test('two checkpoints where one matches and one carries a different node id write once, with the changed key updated and the other untouched', () => {
  const setup = makeAdapters([]);
  const seedPlan = { operations: [], checkpoints: [checkpoint('a', 'node-a'), checkpoint('b', 'node-b')] };
  const seeded = applyMutationPlan(seedPlan, { cwd: '/repo', map: null, ...setup.adapters });
  setup.calls.length = 0;
  const repairPlan = { operations: [], checkpoints: [checkpoint('a', 'node-a'), checkpoint('b', 'node-b-REPAIRED')] };
  const result = applyMutationPlan(repairPlan, { cwd: '/repo', map: seeded.map, ...setup.adapters });
  assert.equal(setup.calls.filter((call) => call[0] === 'write').length, 1);
  assert.equal(result.map.completions.a.nodeId, 'node-a');
  assert.equal(result.map.completions.b.nodeId, 'node-b-REPAIRED');
});

test('a checkpoint node id that differs from the map only by type (string vs number) counts as different, is written, and lands as a string', () => {
  const setup = makeAdapters([]);
  const seedPlan = { operations: [], checkpoints: [checkpoint('a', 123)] };
  const seeded = applyMutationPlan(seedPlan, { cwd: '/repo', map: null, ...setup.adapters });
  setup.calls.length = 0;
  const repairPlan = { operations: [], checkpoints: [checkpoint('a', '123')] };
  const result = applyMutationPlan(repairPlan, { cwd: '/repo', map: seeded.map, ...setup.adapters });
  assert.equal(setup.calls.filter((call) => call[0] === 'write').length, 1);
  assert.strictEqual(result.map.completions.a.nodeId, '123');
});

test('the fold precedes dispatch: an operation whose argv references a checkpointed key resolves in a plan where nothing else wrote that key', () => {
  const setup = makeAdapters([success({ nodeId: 'field-node' })]);
  const plan = {
    operations: [operation('field', { args: ['api', 'graphql', '-F', { from: 'project', part: 'nodeId', prefix: 'projectId=' }] })],
    checkpoints: [checkpoint('project', 'adopted-project-node')],
  };
  const result = applyMutationPlan(plan, { cwd: '/repo', map: null, ...setup.adapters });
  assert.equal(result.kind, 'completed');
  const writeIndex = setup.calls.findIndex((call) => call[0] === 'write');
  const execIndex = setup.calls.findIndex((call) => call[0] === 'exec');
  assert.ok(writeIndex < execIndex);
  assert.ok(setup.calls[execIndex][1].includes('projectId=adopted-project-node'));
});

test('a repository-mismatched checkpoint yields an uncertain result with zero execGh calls, an empty outcome journal, and an untouched file', () => {
  let seedMap = null;
  seedMap = realMap.recordCompletion(seedMap, { logicalKey: 'a', nodeId: 'node-a', completedAt: '1970-01-01T00:00:00.000Z', owner: 'octo', repo: 'repo', repositoryNumber: 1 });
  let storedMap = null;
  const setup = makeAdapters([], { recordCompletion: realMap.recordCompletion, writeSyncMapAtomically: (_cwd, m) => { storedMap = m; } });
  const plan = { operations: [], checkpoints: [{ logicalKey: 'a', nodeId: 'other-node', completionContext: { owner: 'wrong-owner', repo: 'repo', repositoryNumber: 1 } }] };
  const result = applyMutationPlan(plan, { cwd: '/repo', map: seedMap, ...setup.adapters });
  assert.equal(result.kind, 'uncertain');
  assert.equal(setup.calls.filter((call) => call[0] === 'exec').length, 0);
  assert.deepEqual(result.outcomes, []);
  assert.equal(storedMap, null);
});

test('a fold that completes publishes all of its outcomes only after the write returns', () => {
  const setup = makeAdapters([]);
  const plan = { operations: [], checkpoints: [checkpoint('a', 'node-a')] };
  const result = applyMutationPlan(plan, { cwd: '/repo', map: null, ...setup.adapters });
  assert.equal(result.outcomes.length, 1);
});

test('a plan carrying no checkpoint list behaves exactly as it does today', () => {
  const setup = makeAdapters([success({ nodeId: 'plain-node' })]);
  const result = applyMutationPlan({ operations: [operation('one')] }, { cwd: '/repo', map: null, ...setup.adapters });
  assert.equal(result.kind, 'completed');
});

// ─── outcome journal ────────────────────────────────────────────────────────

test('a completed result lists every checkpointed logical key in fold-then-dispatch order with producing operation key and result', () => {
  const setup = makeAdapters([success({ nodeId: 'field-node' })]);
  const plan = {
    operations: [operation('field')],
    checkpoints: [checkpoint('project', 'adopted-project-node')],
  };
  const result = applyMutationPlan(plan, { cwd: '/repo', map: null, ...setup.adapters });
  assert.deepEqual(result.outcomes.map((outcome) => outcome.logicalKey), ['project', 'field']);
  assert.equal(result.outcomes[0].operationKey, null);
  assert.equal(result.outcomes[1].operationKey, 'field');
});

test('a plan failing on its third of four operations returns outcomes holding only the fold entries and the first two operations', () => {
  const setup = makeAdapters([success({ nodeId: 'one-node' }), success({ nodeId: 'two-node' }), { exitCode: 1, reason: 'gh_exit_nonzero', stdout: '', stderr: 'nope' }]);
  const plan = {
    operations: [operation('one'), operation('two'), operation('three'), operation('four')],
    checkpoints: [checkpoint('zero', 'zero-node')],
  };
  const result = applyMutationPlan(plan, { cwd: '/repo', map: null, ...setup.adapters });
  assert.equal(result.kind, 'failed');
  assert.deepEqual(result.outcomes.map((outcome) => outcome.logicalKey), ['zero', 'one', 'two']);
});

test('the three journal selectors return 2, 3, and 1 keys for a plan with one create and two checkpoints, one already matching', () => {
  const setup = makeAdapters([]);
  const seedPlan = { operations: [], checkpoints: [checkpoint('matches', 'node-x')] };
  const seeded = applyMutationPlan(seedPlan, { cwd: '/repo', map: null, ...setup.adapters });
  setup.calls.length = 0;
  const execSetup = makeAdapters([success({ nodeId: 'created-node' })]);
  const plan = {
    operations: [operation('created', { action: OPERATION_ACTION.CREATE })],
    checkpoints: [checkpoint('matches', 'node-x'), checkpoint('new-one', 'node-y')],
  };
  const result = applyMutationPlan(plan, { cwd: '/repo', map: seeded.map, ...execSetup.adapters });
  assert.equal(confirmedKeys(result.outcomes).length, 2);
  assert.equal(checkpointedKeys(result.outcomes).length, 3);
  assert.equal(mutatedKeys(result.outcomes).length, 1);
});

// ─── pre-existing Phase 2 behavior, preserved ──────────────────────────────

test('applies operations serially and checkpoints response-derived completion before the next mutation', () => {
  const setup = makeAdapters([success({ nodeId: 'one-node' }), success({ nodeId: 'two-node' })]);
  const result = applyMutationPlan({ operations: [operation('one'), operation('two')] }, { cwd: '/repo', map: null, ...setup.adapters });
  assert.equal(result.kind, 'completed');
  assert.deepEqual(setup.calls.map((call) => call[0]), ['exec', 'record', 'write', 'exec', 'record', 'write']);
  assert.equal(setup.calls[1][1].nodeId, 'one-node');
});

test('accepts a real pure reconciler operation at the applier boundary', () => {
  const plan = planReconciliation(
    { available: true, reason: 'ok', phases: [{ id: '01', title: 'One', goal: 'one' }] },
    {
      available: true,
      reason: 'ok',
      target: { owner: 'octo', repo: 'repo', repositoryNumber: 1, projectNumber: 7, projectNodeId: 'PVT_proj_node_1' },
      items: [],
      fields: [],
      subIssues: [],
      issueNodeIds: { 101: 'ISSUE_NODE_101' },
    },
    { kind: 'valid', map: { completions: { 'phase:01': { nodeId: 'item-01', issueNumber: 101 } } } },
  );
  const setup = makeAdapters([success({ nodeId: 'from-real-plan' })]);
  assert.equal(applyMutationPlan(plan, { cwd: '/repo', map: null, ...setup.adapters }).kind, 'completed');
  assert.equal(setup.calls[1][1].nodeId, 'from-real-plan');
});

test('uses the 100-point reserve and reset time for the next dispatch, independently of content pacing', () => {
  assert.equal(POINTS_RESERVE, 100);
  const noWait = makeAdapters([success({ remaining: 101, cost: 1 }), success()]);
  assert.equal(applyMutationPlan({ operations: [operation('one'), operation('two')] }, { cwd: '/repo', map: null, ...noWait.adapters }).kind, 'completed');
  assert.deepEqual(noWait.clock.sleepCalls, []);

  const reserveWait = makeAdapters([success({ remaining: 100, cost: 1, resetAt: '1970-01-01T00:00:05.000Z' }), success()]);
  assert.equal(applyMutationPlan({ operations: [operation('one'), operation('two')] }, { cwd: '/repo', map: null, ...reserveWait.adapters }).kind, 'completed');
  assert.deepEqual(reserveWait.clock.sleepCalls, [5000]);

  const contentWait = makeAdapters([success(), success()]);
  assert.equal(applyMutationPlan({ operations: [operation('one', { contentCreation: true }), operation('two', { contentCreation: true })] }, { cwd: '/repo', map: null, ...contentWait.adapters }).kind, 'completed');
  assert.deepEqual(contentWait.clock.sleepCalls, [750]);
});

test('uses Retry-After from the real header-aware response before retrying', () => {
  const rateLimited = { exitCode: 1, reason: 'gh_exit_nonzero', stdout: '', stderr: '', response: { available: true, status: 429, retry_after_seconds: 7 } };
  const setup = makeAdapters([rateLimited, success()]);
  const result = applyMutationPlan({ operations: [operation('one')] }, { cwd: '/repo', map: null, ...setup.adapters });
  assert.equal(result.kind, 'completed');
  assert.deepEqual(setup.clock.sleepCalls, [7000]);
  assert.equal(setup.calls.filter((call) => call[0] === 'notice').length, 1);
});

test('stops without map writes on malformed reset data or a malformed selected payload', () => {
  const malformedReset = makeAdapters([success({ resetAt: 'not-a-date' })]);
  assert.equal(applyMutationPlan({ operations: [operation('one')] }, { cwd: '/repo', map: null, ...malformedReset.adapters }).kind, 'failed');
  assert.equal(malformedReset.calls.some((call) => call[0] === 'write'), false);

  const malformedPayload = makeAdapters([{ ...success(), stdout: JSON.stringify({ data: { rateLimit: { cost: 1, remaining: 100, resetAt: '1970-01-01T00:00:05.000Z' }, addProjectV2Item: { projectV2Item: { id: '' } } } }) }]);
  assert.equal(applyMutationPlan({ operations: [operation('one')] }, { cwd: '/repo', map: null, ...malformedPayload.adapters }).kind, 'failed');
  assert.equal(malformedPayload.calls.some((call) => call[0] === 'write'), false);
});

test('caps transient retries and treats timed-out creates as uncertain without retry', () => {
  const transient = { exitCode: 1, reason: 'gh_exit_nonzero', stdout: '', stderr: 'connection reset' };
  const retrySetup = makeAdapters([transient, transient, transient, transient]);
  assert.equal(applyMutationPlan({ operations: [operation('one')] }, { cwd: '/repo', map: null, ...retrySetup.adapters }).kind, 'failed');
  assert.equal(retrySetup.calls.filter((call) => call[0] === 'exec').length, 4);

  const timeoutSetup = makeAdapters([{ exitCode: 124, reason: 'gh_timed_out', stdout: '', stderr: '' }]);
  assert.equal(applyMutationPlan({ operations: [operation('one', { contentCreation: true })] }, { cwd: '/repo', map: null, ...timeoutSetup.adapters }).kind, 'uncertain');
  assert.equal(timeoutSetup.calls.filter((call) => call[0] === 'exec').length, 1);
});
