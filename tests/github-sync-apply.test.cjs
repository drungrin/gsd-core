'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeClock } = require('./helpers/clock.cjs');
const { applyMutationPlan } = require('../gsd-core/bin/lib/github-sync-apply.cjs');

function operation(key, kind = 'update') {
  return {
    kind,
    logicalKey: key,
    args: ['api', 'graphql', '-f', `query=mutation { # ${key} }`],
    completion: { logicalKey: key, nodeId: `node-${key}`, owner: 'octo', repo: 'repo', repositoryNumber: 1 },
  };
}

function success() {
  return { exitCode: 0, reason: 'ok', stdout: JSON.stringify({ data: { rateLimit: { cost: 1, remaining: 4999 } } }), stderr: '' };
}

function makeAdapters(results, overrides = {}) {
  const calls = [];
  const clock = makeFakeClock(0);
  return {
    calls,
    clock,
    adapters: {
      execGh(args) { calls.push(['exec', args.at(-1)]); return results.shift() ?? success(); },
      recordCompletion(map, completion) { calls.push(['record', completion.logicalKey]); return { version: '1', repository: { owner: 'octo', repo: 'repo', number: 1 }, completions: { ...(map?.completions ?? {}), [completion.logicalKey]: completion } }; },
      writeSyncMapAtomically(_cwd, map) { calls.push(['write', Object.keys(map.completions).join(',')]); },
      clock,
      random: () => 0,
      notice(message) { calls.push(['notice', message]); },
      ...overrides,
    },
  };
}

test('applies operations serially and checkpoints each confirmation before the next mutation', () => {
  const setup = makeAdapters([success(), success()]);
  const result = applyMutationPlan({ operations: [operation('one'), operation('two')] }, { cwd: '/repo', map: null, ...setup.adapters });
  assert.equal(result.kind, 'completed');
  assert.deepEqual(setup.calls.map((call) => call[0]), ['exec', 'record', 'write', 'exec', 'record', 'write']);
});

test('retries only a retryable rate response, honoring Retry-After before jittered backoff', () => {
  const rateLimited = { exitCode: 1, reason: 'gh_exit_nonzero', stdout: '', stderr: '', response: { available: true, status: 429, retry_after_seconds: 7 } };
  const setup = makeAdapters([rateLimited, success()]);
  const result = applyMutationPlan({ operations: [operation('one')] }, { cwd: '/repo', map: null, ...setup.adapters });
  assert.equal(result.kind, 'completed');
  assert.deepEqual(setup.clock.sleepCalls, [7000]);
  assert.equal(setup.calls.filter((call) => call[0] === 'notice').length, 1);
});

test('caps transient retries at three and stops before any later operation', () => {
  const transient = { exitCode: 1, reason: 'gh_exit_nonzero', stdout: '', stderr: 'connection reset' };
  const setup = makeAdapters([transient, transient, transient, transient]);
  const result = applyMutationPlan({ operations: [operation('one'), operation('two')] }, { cwd: '/repo', map: null, ...setup.adapters });
  assert.deepEqual(result, { kind: 'failed', logicalKey: 'one', remediation: 'Retry the sync after resolving the reported GitHub failure.' });
  assert.equal(setup.calls.filter((call) => call[0] === 'exec').length, 4);
});

test('paces content creates independently and treats a timed-out create as uncertain without retry', () => {
  const timeout = { exitCode: 124, reason: 'gh_timed_out', stdout: '', stderr: '' };
  const setup = makeAdapters([success(), timeout]);
  const result = applyMutationPlan({ operations: [operation('one', 'create'), operation('two', 'create')] }, { cwd: '/repo', map: null, ...setup.adapters });
  assert.deepEqual(result, { kind: 'uncertain', logicalKey: 'two', remediation: 'Re-read GitHub and reconcile before retrying this content create.' });
  assert.deepEqual(setup.clock.sleepCalls, [750]);
  assert.equal(setup.calls.filter((call) => call[0] === 'exec').length, 2);
});

test('a confirmed mutation with a checkpoint failure is uncertain and prevents later mutations', () => {
  const setup = makeAdapters([success(), success()], { writeSyncMapAtomically() { throw new Error('disk full'); } });
  const result = applyMutationPlan({ operations: [operation('one'), operation('two')] }, { cwd: '/repo', map: null, ...setup.adapters });
  assert.deepEqual(result, { kind: 'uncertain', logicalKey: 'one', remediation: 'Repair the local sync map before running sync again.' });
  assert.equal(setup.calls.filter((call) => call[0] === 'exec').length, 1);
});
