'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeClock } = require('./helpers/clock.cjs');
const { applyMutationPlan, POINTS_RESERVE, parseRateLimit, decodeConfirmedCompletion } = require('../gsd-core/bin/lib/github-sync-apply.cjs');
const { planReconciliation } = require('../gsd-core/bin/lib/github-sync-reconcile.cjs');

function operation(key, kind = 'update') {
  return {
    kind,
    logicalKey: key,
    args: ['api', 'graphql', '-f', `query=mutation { # ${key} }`],
    completionContext: { owner: 'octo', repo: 'repo', repositoryNumber: 1 },
    responsePayloadKey: 'addProjectV2Item',
    contentCreation: kind === 'create',
  };
}

function success({ cost = 1, remaining = 4999, resetAt = '1970-01-01T00:00:10.000Z', nodeId = 'node-ok', issueNumber = 3 } = {}) {
  return {
    exitCode: 0,
    reason: 'ok',
    stdout: JSON.stringify({ data: {
      rateLimit: { cost, remaining, resetAt },
      addProjectV2Item: { projectV2Item: { id: nodeId, content: { number: issueNumber } } },
    } }),
    stderr: '',
  };
}

function makeAdapters(results, overrides = {}) {
  const calls = [];
  const clock = makeFakeClock(0);
  return {
    calls,
    clock,
    adapters: {
      execGh(args) { calls.push(['exec', args.at(-1)]); return results.shift() ?? success(); },
      recordCompletion(map, completion) { calls.push(['record', completion]); return { version: '1', repository: { owner: 'octo', repo: 'repo', number: 1 }, completions: { ...(map?.completions ?? {}), [completion.logicalKey]: completion } }; },
      writeSyncMapAtomically(_cwd, map) { calls.push(['write', Object.keys(map.completions).join(',')]); },
      clock,
      random: () => 0,
      notice(message) { calls.push(['notice', message]); },
      ...overrides,
    },
  };
}

test('decoders accept only strict rateLimit and response-selected completion data', () => {
  const result = success({ nodeId: 'project-item-1', issueNumber: 9 });
  assert.deepEqual(parseRateLimit(result), { cost: 1, remaining: 4999, resetAt: '1970-01-01T00:00:10.000Z' });
  assert.deepEqual(decodeConfirmedCompletion(operation('one'), result, '1970-01-01T00:00:00.000Z'), {
    logicalKey: 'one', nodeId: 'project-item-1', issueNumber: 9, completedAt: '1970-01-01T00:00:00.000Z', owner: 'octo', repo: 'repo', repositoryNumber: 1,
  });
  assert.equal(parseRateLimit({ ...result, stdout: JSON.stringify({ data: { rateLimit: { cost: -1, remaining: 1, resetAt: 'nope' } } }) }), null);
  assert.equal(decodeConfirmedCompletion(operation('one'), { ...result, stdout: JSON.stringify({ data: { rateLimit: result, addProjectV2Item: { projectV2Item: { id: '' } } } }) }, 'now'), null);
});

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
  assert.equal(applyMutationPlan({ operations: [operation('one', 'create'), operation('two', 'create')] }, { cwd: '/repo', map: null, ...contentWait.adapters }).kind, 'completed');
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
  assert.equal(applyMutationPlan({ operations: [operation('one', 'create')] }, { cwd: '/repo', map: null, ...timeoutSetup.adapters }).kind, 'uncertain');
  assert.equal(timeoutSetup.calls.filter((call) => call[0] === 'exec').length, 1);
});
