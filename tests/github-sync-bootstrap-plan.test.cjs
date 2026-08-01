'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  planBootstrap,
  planStatusOptionMerge,
  optionInputArgv,
  BOOTSTRAP_LOGICAL_KEY,
  BOOTSTRAP_OPERATION_REASON,
  BOOTSTRAP_PASS,
  GSD_STATUS_OPTIONS,
  STATUS_FIELD_NAME,
} = require('../gsd-core/bin/lib/github-sync-bootstrap-plan.cjs');
const { applyMutationPlan } = require('../gsd-core/bin/lib/github-sync-apply.cjs');
const realMap = require('../gsd-core/bin/lib/github-sync-map.cjs');

const CONTEXT = { owner: 'octo', repo: 'repo', repositoryNumber: 1 };

function opt(id, name, color = 'GRAY', description = '') {
  return { id, name, color, description };
}

function statusField(options) {
  return { id: 'PVTF_status', name: STATUS_FIELD_NAME, dataType: 'SINGLE_SELECT', options };
}

function remoteResolved(options) {
  return { available: true, projectOutcome: 'resolved', statusField: statusField(options) };
}

// ─── optionInputArgv ────────────────────────────────────────────────────────

describe('optionInputArgv', () => {
  test('each element emits its name assignment before any other assignment for that element', () => {
    const argv = optionInputArgv('options', [opt(undefined, 'Todo', 'GRAY', ''), opt(undefined, 'Blocked', 'RED', '')]);
    const nameIndexes = argv.reduce((acc, entry, index) => { if (entry.startsWith('options[][name]=')) acc.push(index); return acc; }, []);
    assert.equal(nameIndexes.length, 2);
    assert.ok(nameIndexes[0] < nameIndexes[1]);
  });

  test('an id-less element followed by an id-bearing element followed by a third: the id index sits strictly between its own name and the next name', () => {
    const argv = optionInputArgv('options', [opt(undefined, 'Todo'), opt('abc123', 'In Review'), opt(undefined, 'Parked')]);
    const nameIndexes = [];
    let idIndex = -1;
    argv.forEach((entry, index) => {
      if (entry.startsWith('options[][name]=')) nameIndexes.push(index);
      if (entry.startsWith('options[][id]=')) idIndex = index;
    });
    assert.equal(nameIndexes.length, 3);
    assert.ok(idIndex > nameIndexes[1]);
    assert.ok(idIndex < nameIndexes[2]);
  });

  test('the reverse order (id-bearing then id-less) produces the same per-element grouping', () => {
    const argv = optionInputArgv('options', [opt('abc123', 'In Review'), opt(undefined, 'Todo'), opt(undefined, 'Parked')]);
    const nameIndexes = [];
    let idIndex = -1;
    argv.forEach((entry, index) => {
      if (entry.startsWith('options[][name]=')) nameIndexes.push(index);
      if (entry.startsWith('options[][id]=')) idIndex = index;
    });
    assert.equal(nameIndexes.length, 3);
    assert.ok(idIndex > nameIndexes[0]);
    assert.ok(idIndex < nameIndexes[1]);
  });

  test('every value-bearing entry is preceded by the raw-value flag, and no typed-value flag appears anywhere', () => {
    const argv = optionInputArgv('options', [opt('abc', 'Todo', 'GRAY', 'd')]);
    for (let i = 0; i < argv.length; i += 2) {
      assert.equal(argv[i], '-f');
    }
    assert.ok(!argv.includes('-F'));
  });
});

// ─── planStatusOptionMerge ──────────────────────────────────────────────────

describe('planStatusOptionMerge', () => {
  test('three existing GSD options plus two missing: outgoing array has 5 entries, existing carry exact remote fields, missing carry no id', () => {
    const remote = remoteResolved([
      opt('id-todo', 'Todo', 'GRAY', ''),
      opt('id-inprogress', 'In Progress', 'BLUE', ''),
      opt('id-done', 'Done', 'GREEN', ''),
    ]);
    const result = planStatusOptionMerge(remote, { kind: 'absent' }, CONTEXT);
    assert.equal(result.kind, 'operation');
    const merged = extractMerged(result.operation);
    assert.equal(merged.length, 5);
    assert.equal(merged.find((e) => e.name === 'Todo').id, 'id-todo');
    assert.equal(merged.find((e) => e.name === 'Blocked').id, undefined);
    assert.equal(merged.find((e) => e.name === 'Deferred').id, undefined);
  });

  test('a custom option is preserved after the five GSD options, in original relative order', () => {
    const remote = remoteResolved([
      opt('id-todo', 'Todo'), opt('id-inprogress', 'In Progress'), opt('id-done', 'Done'),
      opt('id-review', 'In Review', 'PURPLE', 'custom'),
    ]);
    const result = planStatusOptionMerge(remote, { kind: 'absent' }, CONTEXT);
    const merged = extractMerged(result.operation);
    assert.equal(merged.length, 6);
    assert.equal(merged[5].name, 'In Review');

    const remoteTwo = remoteResolved([
      opt('id-todo', 'Todo'), opt('id-review', 'In Review'), opt('id-parked', 'Parked'),
    ]);
    const resultTwo = planStatusOptionMerge(remoteTwo, { kind: 'absent' }, CONTEXT);
    const mergedTwo = extractMerged(resultTwo.operation);
    assert.deepEqual(mergedTwo.slice(5).map((e) => e.name), ['In Review', 'Parked']);
  });

  test('zero remote options: outgoing array is exactly the five GSD options in D-19 order, none carrying an id', () => {
    const remote = remoteResolved([]);
    const result = planStatusOptionMerge(remote, { kind: 'absent' }, CONTEXT);
    const merged = extractMerged(result.operation);
    assert.deepEqual(merged.map((e) => e.name), GSD_STATUS_OPTIONS.map((o) => o.name));
    assert.ok(merged.every((e) => e.id === undefined));
  });

  test('a resolved project with no Status field returns blocked with zero operations and zero checkpoints', () => {
    const remote = { available: true, projectOutcome: 'resolved', statusField: null };
    const result = planStatusOptionMerge(remote, { kind: 'absent' }, CONTEXT);
    assert.equal(result.kind, 'blocked');
    assert.equal(result.reason, BOOTSTRAP_OPERATION_REASON.MISSING_STATUS_FIELD);
  });

  test('an unset project outcome returns a noop, not blocked, so planBootstrap reaches planProject instead of dying here', () => {
    const remote = { available: true, projectOutcome: 'unset', statusField: null };
    const result = planStatusOptionMerge(remote, { kind: 'absent' }, CONTEXT);
    assert.equal(result.kind, 'noop');
    assert.equal(result.reason, BOOTSTRAP_OPERATION_REASON.PROJECT_UNSET);

    const plan = planBootstrap({
      desired: { available: true },
      remote,
      strictMap: { kind: 'absent' },
      target: { owner: 'octo', repo: 'repo', repositoryNumber: 1, projectNumber: null },
    }, { pass: BOOTSTRAP_PASS.OPTIONS });
    assert.deepEqual(plan.blocked, []);
    assert.equal(plan.operations.length, 0);
    assert.equal(plan.checkpoints.length, 0);
    assert.equal(plan.noops.length, 1);
  });

  test('a remote option name exactly equal to a GSD name merges once with the existing id — no duplicate', () => {
    const remote = remoteResolved([opt('id-todo', 'Todo'), opt('id-inprogress', 'In Progress'), opt('id-blocked', 'Blocked'), opt('id-done', 'Done'), opt('id-deferred', 'Deferred')]);
    const result = planStatusOptionMerge(remote, { kind: 'absent' }, CONTEXT);
    // fully converged (identical id/name/color/description at every index) -> checkpoints, not an operation
    assert.equal(result.kind, 'converged');
    assert.equal(result.checkpoints.length, 5);
  });

  test('D-17: an option renamed on the remote is matched by its stored map id, not re-created under the GSD name', () => {
    const remote = remoteResolved([opt('id-todo-renamed', 'ToDo (renamed)'), opt('id-inprogress', 'In Progress'), opt('id-done', 'Done')]);
    const strictMap = { kind: 'valid', map: { completions: { 'option:status:todo': { nodeId: 'id-todo-renamed' } } } };
    const result = planStatusOptionMerge(remote, strictMap, CONTEXT);
    const merged = extractMerged(result.operation);
    const todoEntry = merged.find((e) => e.id === 'id-todo-renamed');
    assert.equal(todoEntry.name, 'ToDo (renamed)');
    assert.equal(merged.filter((e) => e.id === 'id-todo-renamed').length, 1);
  });

  test('HIGH-B convergence: an already-correct board (five GSD options plus one custom, identical order) yields zero operations and five checkpoints', () => {
    const remote = remoteResolved([
      opt('id-todo', 'Todo', 'GRAY', ''), opt('id-inprogress', 'In Progress', 'BLUE', ''),
      opt('id-blocked', 'Blocked', 'RED', ''), opt('id-done', 'Done', 'GREEN', ''),
      opt('id-deferred', 'Deferred', 'YELLOW', ''), opt('id-review', 'In Review', 'PURPLE', 'custom'),
    ]);
    const result = planStatusOptionMerge(remote, { kind: 'absent' }, CONTEXT);
    assert.equal(result.kind, 'converged');
    assert.equal(result.checkpoints.length, 5);
    assert.deepEqual(result.checkpoints.map((c) => c.nodeId).sort(), ['id-blocked', 'id-deferred', 'id-done', 'id-inprogress', 'id-todo'].sort());
  });

  test('the negative of convergence: the remote returns the five GSD options out of D-19 order — one operation, zero checkpoints (merge always echoes verbatim per D-18, so a real value divergence at a fixed slot can only arise from order, never from a stale cosmetic)', () => {
    const remote = remoteResolved([
      opt('id-inprogress', 'In Progress', 'BLUE', ''), opt('id-todo', 'Todo', 'GRAY', ''),
      opt('id-blocked', 'Blocked', 'RED', ''), opt('id-done', 'Done', 'GREEN', ''),
      opt('id-deferred', 'Deferred', 'YELLOW', ''),
    ]);
    const result = planStatusOptionMerge(remote, { kind: 'absent' }, CONTEXT);
    assert.equal(result.kind, 'operation');
    assert.equal(result.checkpoints, undefined);
  });

  test('a converged input missing one GSD option is not converged: one operation, zero checkpoints', () => {
    const remote = remoteResolved([
      opt('id-todo', 'Todo'), opt('id-inprogress', 'In Progress'), opt('id-blocked', 'Blocked'), opt('id-done', 'Done'),
    ]);
    const result = planStatusOptionMerge(remote, { kind: 'absent' }, CONTEXT);
    assert.equal(result.kind, 'operation');
  });

  test('the emitted operation each-capture key map has exactly 5 entries, none named after the custom option', () => {
    const remote = remoteResolved([opt('id-todo', 'Todo'), opt('id-review', 'In Review')]);
    const result = planStatusOptionMerge(remote, { kind: 'absent' }, CONTEXT);
    const capture = result.operation.captures[0];
    assert.equal(Object.keys(capture.keyMap).length, 5);
    assert.equal(capture.keyMap['In Review'], undefined);
  });

  test('the emitted operation declares GraphQL transport, update action, no points budget, and no content creation', () => {
    const remote = remoteResolved([]);
    const result = planStatusOptionMerge(remote, { kind: 'absent' }, CONTEXT);
    assert.equal(result.operation.transport, 'graphql');
    assert.equal(result.operation.action, 'update');
    // Live-verified during Task 2's A1 proof (2026-08-01, gh 2.96.0): `rateLimit`
    // does not exist on GitHub's `Mutation` type. A declared points budget would
    // require selecting a field the live schema rejects, so this operation
    // declares none — see the SECURITY/schema comment on STATUS_MERGE_DOCUMENT.
    assert.equal(result.operation.hasPointsBudget, false);
    assert.equal(result.operation.contentCreation, false);
  });

  test('the merged-write document never selects rateLimit — live-verified not to exist on the Mutation type (2026-08-01, gh 2.96.0)', () => {
    const remote = remoteResolved([]);
    const result = planStatusOptionMerge(remote, { kind: 'absent' }, CONTEXT);
    const query = result.operation.args.find((arg) => typeof arg === 'string' && arg.startsWith('query='));
    assert.doesNotMatch(query, /rateLimit/);
  });
});

function extractMerged(operation) {
  const argv = operation.args;
  const merged = [];
  let current = null;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const pair = argv[i + 1];
    if (flag !== '-f' || typeof pair !== 'string' || !pair.startsWith('options[]')) continue;
    const [key, value] = pair.slice('options[]['.length).split(']=');
    if (key === 'name') { current = { name: value }; merged.push(current); }
    else if (current) current[key] = value;
  }
  return merged;
}

// ─── planBootstrap gates ────────────────────────────────────────────────────

describe('planBootstrap', () => {
  const target = { owner: 'octo', repo: 'repo', repositoryNumber: 1, projectNumber: 7 };

  test('three-gate ordering: desired unavailable first', () => {
    const plan = planBootstrap({
      desired: { available: false, reason: 'local_unavailable' },
      remote: { available: false, projectOutcome: 'unavailable', statusField: null },
      strictMap: { kind: 'blocking', reason: 'invalid_schema' },
      target,
    }, { pass: BOOTSTRAP_PASS.OPTIONS });
    assert.deepEqual(plan.operations, []);
    assert.deepEqual(plan.checkpoints, []);
    assert.equal(plan.blocked[0].reason, BOOTSTRAP_OPERATION_REASON.DESIRED_UNAVAILABLE);
  });

  test('three-gate ordering: remote unavailable second', () => {
    const plan = planBootstrap({
      desired: { available: true },
      remote: { available: false, projectOutcome: 'unavailable', statusField: null },
      strictMap: { kind: 'blocking', reason: 'invalid_schema' },
      target,
    }, { pass: BOOTSTRAP_PASS.OPTIONS });
    assert.deepEqual(plan.operations, []);
    assert.deepEqual(plan.checkpoints, []);
    assert.equal(plan.uncertain[0].reason, BOOTSTRAP_OPERATION_REASON.REMOTE_UNAVAILABLE);
  });

  test('three-gate ordering: map blocking third', () => {
    const plan = planBootstrap({
      desired: { available: true },
      remote: { available: true, projectOutcome: 'unset', statusField: null },
      strictMap: { kind: 'blocking', reason: 'invalid_schema' },
      target,
    }, { pass: BOOTSTRAP_PASS.OPTIONS });
    assert.deepEqual(plan.operations, []);
    assert.deepEqual(plan.checkpoints, []);
    assert.equal(plan.blocked[0].reason, BOOTSTRAP_OPERATION_REASON.MAP_BLOCKING);
  });

  test('remote-unavailable gate fires on the available flag alone, never on an unset/absent project outcome', () => {
    for (const projectOutcome of ['unset', 'absent']) {
      const plan = planBootstrap({
        desired: { available: true },
        remote: { available: true, projectOutcome, statusField: null },
        strictMap: { kind: 'absent' },
        target,
      }, { pass: BOOTSTRAP_PASS.OPTIONS });
      assert.deepEqual(plan.uncertain, []);
    }
  });

  test('the structure pass emits zero option operations; the options pass emits zero structure operations (disjoint passes)', () => {
    const remote = remoteResolved([]);
    const structurePlan = planBootstrap({ desired: { available: true }, remote, strictMap: { kind: 'absent' }, target }, { pass: BOOTSTRAP_PASS.STRUCTURE });
    assert.deepEqual(structurePlan.operations, []);
    const optionsPlan = planBootstrap({ desired: { available: true }, remote, strictMap: { kind: 'absent' }, target }, { pass: BOOTSTRAP_PASS.OPTIONS });
    assert.equal(optionsPlan.operations.length, 1);
  });

  test('every emitted operation and checkpoint carries a completion context matching the resolved target, and folds through the real recordCompletion without throwing', () => {
    const remote = remoteResolved([opt('id-todo', 'Todo'), opt('id-inprogress', 'In Progress'), opt('id-blocked', 'Blocked'), opt('id-done', 'Done'), opt('id-deferred', 'Deferred')]);
    const plan = planBootstrap({ desired: { available: true }, remote, strictMap: { kind: 'absent' }, target }, { pass: BOOTSTRAP_PASS.OPTIONS });
    assert.equal(plan.checkpoints.length, 5);
    for (const checkpoint of plan.checkpoints) {
      assert.deepEqual(checkpoint.completionContext, { owner: 'octo', repo: 'repo', repositoryNumber: 1 });
      assert.doesNotThrow(() => realMap.recordCompletion(null, {
        logicalKey: checkpoint.logicalKey, nodeId: checkpoint.nodeId, completedAt: '2026-01-01T00:00:00.000Z',
        owner: checkpoint.completionContext.owner, repo: checkpoint.completionContext.repo, repositoryNumber: checkpoint.completionContext.repositoryNumber,
      }));
    }
  });
});

// ─── BOOTSTRAP_LOGICAL_KEY sanity against the locked catalog ───────────────

test('BOOTSTRAP_LOGICAL_KEY reproduces the reserved catalog locked at plan 03-01 Task 1', () => {
  assert.equal(BOOTSTRAP_LOGICAL_KEY.project(), 'project');
  assert.equal(BOOTSTRAP_LOGICAL_KEY.projectLink(), 'project-link');
  assert.equal(BOOTSTRAP_LOGICAL_KEY.field('GSD ID'), 'field:gsd-id');
  assert.equal(BOOTSTRAP_LOGICAL_KEY.field('Status'), 'field:status');
  assert.equal(BOOTSTRAP_LOGICAL_KEY.statusOption('In Progress'), 'option:status:in-progress');
  assert.equal(BOOTSTRAP_LOGICAL_KEY.label('gsd-phase'), 'label:gsd-phase');
  assert.equal(BOOTSTRAP_LOGICAL_KEY.milestone('v1.0'), 'milestone:v1-0');
});

// ─── end-to-end through the real applier ───────────────────────────────────

test('a converged plan folds through the real applyMutationPlan and writes zero times on the second run', () => {
  const remote = remoteResolved([opt('id-todo', 'Todo'), opt('id-inprogress', 'In Progress'), opt('id-blocked', 'Blocked'), opt('id-done', 'Done'), opt('id-deferred', 'Deferred')]);
  const plan = planBootstrap({
    desired: { available: true }, remote, strictMap: { kind: 'absent' },
    target: { owner: 'octo', repo: 'repo', repositoryNumber: 1, projectNumber: 7 },
  }, { pass: BOOTSTRAP_PASS.OPTIONS });

  const writes = [];
  const first = applyMutationPlan(plan, {
    cwd: '/repo', map: null,
    recordCompletion: realMap.recordCompletion,
    writeSyncMapAtomically: (_cwd, map) => { writes.push(map); },
    clock: { now: () => 0, nowIso: () => '2026-01-01T00:00:00.000Z', sleep: () => {} },
    execGh: () => { throw new Error('must not dispatch on a converged plan'); },
  });
  assert.equal(first.kind, 'completed');
  assert.equal(writes.length, 1);
  assert.equal(Object.keys(first.map.completions).length, 5);

  const second = applyMutationPlan(plan, {
    cwd: '/repo', map: first.map,
    recordCompletion: realMap.recordCompletion,
    writeSyncMapAtomically: (_cwd, map) => { writes.push(map); },
    clock: { now: () => 0, nowIso: () => '2026-01-01T00:00:00.000Z', sleep: () => {} },
    execGh: () => { throw new Error('must not dispatch on a converged plan'); },
  });
  assert.equal(second.kind, 'completed');
  assert.equal(writes.length, 1);
});
