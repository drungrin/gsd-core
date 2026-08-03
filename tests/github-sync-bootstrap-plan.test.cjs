'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  planBootstrap,
  planProject,
  planStatusOptionMerge,
  planFields,
  planAutonomousOptions,
  planLabels,
  planMilestones,
  planViews,
  parseMilestoneVersionToken,
  validateFatalConditions,
  optionInputArgv,
  viewFieldIdsArgv,
  BOOTSTRAP_LOGICAL_KEY,
  BOOTSTRAP_OPERATION_REASON,
  BOOTSTRAP_PASS,
  BOOTSTRAP_STAGE,
  GSD_STATUS_OPTIONS,
  GSD_FIELDS,
  GSD_AUTONOMOUS_OPTIONS,
  GSD_LABELS,
  GSD_VIEWS,
  VIEW_LAYOUT,
  STATUS_FIELD_NAME,
  DEFAULT_PROJECT_TITLE_SUFFIX,
  CREATE_PROJECT_DOCUMENT,
  LINK_PROJECT_DOCUMENT,
  CREATE_FIELD_TEXT_DOCUMENT,
  CREATE_FIELD_NUMBER_DOCUMENT,
  CREATE_FIELD_SINGLE_SELECT_DOCUMENT,
  RENAME_FIELD_DOCUMENT,
  CREATE_VIEW_WITH_FIELDS_DOCUMENT,
  UPDATE_VIEW_SHAPE_WITH_FILTER_DOCUMENT,
} = require('../gsd-core/bin/lib/github-sync-bootstrap-plan.cjs');
const { applyMutationPlan } = require('../gsd-core/bin/lib/github-sync-apply.cjs');
const { resolveArgv, decodeCompletions, ARGV_REF_PART: TOP_ARGV_REF_PART } = require('../gsd-core/bin/lib/github-sync-operation.cjs');
const realMap = require('../gsd-core/bin/lib/github-sync-map.cjs');
const bootstrapRemote = require('../gsd-core/bin/lib/github-sync-bootstrap-remote.cjs');

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

function field(id, name, dataType, options = null) {
  return { id, name, dataType, options };
}

/** A resolved remote carrying an arbitrary field list, Status omitted unless passed explicitly. */
function remoteWithFields(fields, overrides = {}) {
  return { available: true, projectOutcome: 'resolved', statusField: null, fields, ...overrides };
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

  test('LIVE FINDING regression (plan 03-03 -> 03-04): the remote returns the five GSD options out of D-19 declaration order — convergence, not an operation, because every option still matches by name/id and a positional read order is not a content divergence', () => {
    const remote = remoteResolved([
      opt('id-inprogress', 'In Progress', 'BLUE', ''), opt('id-todo', 'Todo', 'GRAY', ''),
      opt('id-blocked', 'Blocked', 'RED', ''), opt('id-done', 'Done', 'GREEN', ''),
      opt('id-deferred', 'Deferred', 'YELLOW', ''),
    ]);
    const result = planStatusOptionMerge(remote, { kind: 'absent' }, CONTEXT);
    assert.equal(result.kind, 'converged');
    assert.equal(result.checkpoints.length, 5);
  });

  test('LIVE FINDING regression, exact reported shape (plan 03-03, board #9, 2026-08-01): a creation-order remote read — the three original defaults first, a tail custom option, then Blocked/Deferred last (the order they were actually minted in, which differs from GSD_STATUS_OPTIONS declaration order) — converges with zero operations and five checkpoints carrying the pre-existing ids verbatim, never re-minting Blocked/Deferred/the custom option', () => {
    const remote = remoteResolved([
      opt('f75ad846', 'Todo', 'GRAY', ''),
      opt('47fc9ee4', 'In Progress', 'BLUE', ''),
      opt('98236657', 'Done', 'GREEN', ''),
      opt('3f45dd5b', 'In Review', 'PINK', ''),
      opt('bac73137', 'Blocked', 'RED', ''),
      opt('db539d19', 'Deferred', 'YELLOW', ''),
    ]);
    const result = planStatusOptionMerge(remote, { kind: 'absent' }, CONTEXT);
    assert.equal(result.kind, 'converged');
    assert.equal(result.checkpoints.length, 5);
    const byKey = Object.fromEntries(result.checkpoints.map((c) => [c.logicalKey, c.nodeId]));
    assert.equal(byKey['option:status:blocked'], 'bac73137');
    assert.equal(byKey['option:status:deferred'], 'db539d19');
    assert.equal(byKey['option:status:todo'], 'f75ad846');
    assert.equal(byKey['option:status:in-progress'], '47fc9ee4');
    assert.equal(byKey['option:status:done'], '98236657');
  });

  test('duplicate remote ids never claim convergence, even when every other field matches', () => {
    const remote = remoteResolved([
      opt('dup-id', 'Todo', 'GRAY', ''), opt('dup-id', 'In Progress', 'BLUE', ''),
      opt('id-blocked', 'Blocked', 'RED', ''), opt('id-done', 'Done', 'GREEN', ''),
      opt('id-deferred', 'Deferred', 'YELLOW', ''),
    ]);
    const result = planStatusOptionMerge(remote, { kind: 'absent' }, CONTEXT);
    assert.notEqual(result.kind, 'converged');
  });

  test('two GSD options whose stored ids both point at the same remote entry (a corrupted/duplicated map) never produce two merged entries sharing one id', () => {
    // "Blocked" and "Deferred" both carry a stored id pointing at the same
    // remote option ("Something", never renamed to either GSD name) —
    // without the already-claimed guard, both GSD slots would independently
    // resolve to that one remote entry and the outgoing array would carry
    // the same id twice, which a full-replace write cannot honor for both.
    const remote = remoteResolved([
      opt('id-todo', 'Todo'), opt('id-inprogress', 'In Progress'),
      opt('id-x', 'Something'), opt('id-done', 'Done'),
    ]);
    const strictMap = {
      kind: 'valid',
      map: { completions: { 'option:status:blocked': { nodeId: 'id-x' }, 'option:status:deferred': { nodeId: 'id-x' } } },
    };
    const result = planStatusOptionMerge(remote, strictMap, CONTEXT);
    assert.equal(result.kind, 'operation');
    const merged = extractMerged(result.operation);
    const ids = merged.map((e) => e.id).filter((id) => id !== undefined);
    assert.equal(new Set(ids).size, ids.length, 'no id may appear on two merged entries');
    assert.equal(ids.filter((id) => id === 'id-x').length, 1, 'id-x is claimed exactly once');
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

// ─── BOOTSTRAP_LOGICAL_KEY.autonomousOption (plan 05-04 Task 1) ────────────

describe('BOOTSTRAP_LOGICAL_KEY.autonomousOption', () => {
  test('Yes and No slug to the two reserved autonomous option keys', () => {
    assert.equal(BOOTSTRAP_LOGICAL_KEY.autonomousOption('Yes'), 'option:autonomous:yes');
    assert.equal(BOOTSTRAP_LOGICAL_KEY.autonomousOption('No'), 'option:autonomous:no');
  });

  test('uses the same slug helper as statusOption: a mixed-case, punctuated input slugs identically for both generators', () => {
    const input = ' Some Custom, Option! ';
    const statusSlug = BOOTSTRAP_LOGICAL_KEY.statusOption(input).slice('option:status:'.length);
    const autonomousSlug = BOOTSTRAP_LOGICAL_KEY.autonomousOption(input).slice('option:autonomous:'.length);
    assert.equal(autonomousSlug, statusSlug);
    assert.equal(autonomousSlug, 'some-custom-option');
  });
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

// ─── planProject ────────────────────────────────────────────────────────────

const { ARGV_REF_PART } = require('../gsd-core/bin/lib/github-sync-operation.cjs');

function projectRepo(overrides = {}) {
  return { nodeId: 'R_1', ownerNodeId: 'O_1', ownerLogin: 'octo', linkState: null, ...overrides };
}
function projectRemote(overrides = {}) {
  return { available: true, projectOutcome: 'unset', repository: projectRepo(), projectNodeId: null, statusField: null, ...overrides };
}
function projectTarget(projectNumber) {
  return { owner: 'octo', repo: 'gsd-core', repositoryNumber: 1, projectNumber };
}
/** Both GSD labels already present, matched exactly — the fixture pre-existing structure-pass-wiring tests use to isolate their own (non-label) assertions from plan 03-05 Task 3's label stage. */
function bothGsdLabelsAdopted() {
  return [{ nodeId: 'L_gsd_phase', name: 'gsd:phase' }, { nodeId: 'L_gsd_plan', name: 'gsd:plan' }];
}
function findArg(operation, prefix) {
  return operation.args.find((arg) => typeof arg === 'string' && arg.startsWith(prefix));
}

describe('planProject', () => {
  // ── create path ──
  test('a null project number emits exactly two operations in order — create then link — and zero checkpoints, under distinct logical keys', () => {
    const result = planProject(projectRemote(), { kind: 'absent' }, projectTarget(null), null, CONTEXT);
    assert.equal(result.operations.length, 2);
    assert.equal(result.checkpoints.length, 0);
    assert.equal(result.blocked.length, 0);
    assert.equal(result.operations[0].logicalKey, BOOTSTRAP_LOGICAL_KEY.project());
    assert.equal(result.operations[1].logicalKey, BOOTSTRAP_LOGICAL_KEY.projectLink());
    assert.notEqual(result.operations[0].logicalKey, result.operations[1].logicalKey);
  });

  test("the link operation's argv carries a reference entry whose from-key is the project key, resolving against a map holding a project completion", () => {
    const result = planProject(projectRemote(), { kind: 'absent' }, projectTarget(null), null, CONTEXT);
    const linkOp = result.operations[1];
    const ref = linkOp.args.find((arg) => typeof arg === 'object' && arg !== null);
    assert.ok(ref, 'the link operation must carry a reference entry, not a literal project id');
    assert.equal(ref.from, BOOTSTRAP_LOGICAL_KEY.project());
    assert.equal(ref.part, ARGV_REF_PART.NODE_ID);
    const resolved = resolveArgv(linkOp.args, { [BOOTSTRAP_LOGICAL_KEY.project()]: { nodeId: 'PVT_created' } });
    assert.equal(resolved.ok, true);
    assert.ok(resolved.argv.includes(`${ref.prefix}PVT_created`));
  });

  test("resolving the link operation's argv against a map with no project completion returns an unresolved result naming the project key", () => {
    const result = planProject(projectRemote(), { kind: 'absent' }, projectTarget(null), null, CONTEXT);
    const linkOp = result.operations[1];
    const resolved = resolveArgv(linkOp.args, {});
    assert.equal(resolved.ok, false);
    assert.equal(resolved.missingLogicalKey, BOOTSTRAP_LOGICAL_KEY.project());
  });

  test("the create operation's input carries only an owner id and a title — no repository id", () => {
    const result = planProject(projectRemote(), { kind: 'absent' }, projectTarget(null), null, CONTEXT);
    const createOp = result.operations[0];
    assert.ok(findArg(createOp, 'ownerId='));
    assert.ok(findArg(createOp, 'title='));
    assert.equal(createOp.args.some((arg) => typeof arg === 'string' && arg.startsWith('repositoryId=')), false);
    assert.equal(findArg(createOp, 'ownerId='), 'ownerId=O_1', 'the owner id must be the repository OWNER node id, not a viewer id');
  });

  test('title comes from the configured project title when present and non-empty, otherwise defaults to "<repo> Roadmap"', () => {
    const configured = planProject(projectRemote(), { kind: 'absent' }, projectTarget(null), 'My Custom Title', CONTEXT);
    assert.equal(findArg(configured.operations[0], 'title='), 'title=My Custom Title');

    const defaulted = planProject(projectRemote(), { kind: 'absent' }, projectTarget(null), null, CONTEXT);
    assert.equal(findArg(defaulted.operations[0], 'title='), `title=gsd-core${DEFAULT_PROJECT_TITLE_SUFFIX}`);

    const emptyString = planProject(projectRemote(), { kind: 'absent' }, projectTarget(null), '', CONTEXT);
    assert.equal(findArg(emptyString.operations[0], 'title='), `title=gsd-core${DEFAULT_PROJECT_TITLE_SUFFIX}`);
  });

  test('every string variable in both create-path operations rides the raw -f flag; no typed -F flag appears anywhere', () => {
    const result = planProject(projectRemote(), { kind: 'absent' }, projectTarget(null), null, CONTEXT);
    for (const operation of result.operations) {
      assert.equal(operation.args.includes('-F'), false, `${operation.logicalKey} must never use the typed -F flag`);
      for (let i = 0; i < operation.args.length; i++) {
        const entry = operation.args[i];
        const isValueEntry = (typeof entry === 'string' && entry.includes('=')) || (typeof entry === 'object' && entry !== null);
        if (!isValueEntry) continue;
        assert.equal(operation.args[i - 1], '-f', `${operation.logicalKey}'s value entry at index ${i} must be preceded by the raw -f flag`);
      }
    }
  });

  test('the create operation declares content creation true (a comment at the flag records why), and the link operation declares it false', () => {
    const result = planProject(projectRemote(), { kind: 'absent' }, projectTarget(null), null, CONTEXT);
    assert.equal(result.operations[0].contentCreation, true);
    assert.equal(result.operations[1].contentCreation, false);
  });

  test("the create operation's node capture declares a number path ending at the project's number (BOOT-06's remote-number slot)", () => {
    const result = planProject(projectRemote(), { kind: 'absent' }, projectTarget(null), null, CONTEXT);
    const capture = result.operations[0].captures[0];
    assert.equal(capture.kind, 'node');
    assert.equal(capture.numberPath, 'createProjectV2.projectV2.number');
    assert.equal(capture.nodeIdPath, 'createProjectV2.projectV2.id');
  });

  test('the link operation declares the link action and a single node capture whose node-id path walks the link payload, the repository, and the id', () => {
    const result = planProject(projectRemote(), { kind: 'absent' }, projectTarget(null), null, CONTEXT);
    const linkOp = result.operations[1];
    assert.equal(linkOp.action, 'link');
    assert.equal(linkOp.captures.length, 1);
    assert.equal(linkOp.captures[0].nodeIdPath, 'linkProjectV2ToRepository.repository.id');
  });

  test('the create operation declares the GraphQL transport, the create action, and a points-budget flag', () => {
    const result = planProject(projectRemote(), { kind: 'absent' }, projectTarget(null), null, CONTEXT);
    assert.equal(result.operations[0].transport, 'graphql');
    assert.equal(result.operations[0].action, 'create');
    assert.equal(typeof result.operations[0].hasPointsBudget, 'boolean');
  });

  // ── adopt path (HIGH-A / HIGH-C) ──
  test('HIGH-A: an adopted, LINKED board emits zero operations and two checkpoints, under the project key and the link key', () => {
    const remote = projectRemote({
      projectOutcome: 'resolved',
      projectNodeId: 'PVT_adopted',
      repository: projectRepo({ linkState: 'linked' }),
    });
    const result = planProject(remote, { kind: 'absent' }, projectTarget(9), null, CONTEXT);
    assert.equal(result.operations.length, 0);
    assert.equal(result.checkpoints.length, 2);
    assert.deepEqual(result.checkpoints.map((c) => c.logicalKey).sort(), [BOOTSTRAP_LOGICAL_KEY.project(), BOOTSTRAP_LOGICAL_KEY.projectLink()].sort());
  });

  test('adoption emits zero operations even when the remote title differs from the configured title (D-15, no rename)', () => {
    const remote = projectRemote({ projectOutcome: 'resolved', projectNodeId: 'PVT_adopted', repository: projectRepo({ linkState: 'linked' }) });
    const result = planProject(remote, { kind: 'absent' }, projectTarget(9), 'A Totally Different Title', CONTEXT);
    assert.equal(result.operations.length, 0);
  });

  test('HIGH-C: an adopted board the remote reports UNLINKED emits exactly one operation (the link key) and one project checkpoint', () => {
    const remote = projectRemote({ projectOutcome: 'resolved', projectNodeId: 'PVT_adopted', repository: projectRepo({ linkState: 'unlinked' }) });
    const result = planProject(remote, { kind: 'absent' }, projectTarget(9), null, CONTEXT);
    assert.equal(result.operations.length, 1);
    assert.equal(result.operations[0].logicalKey, BOOTSTRAP_LOGICAL_KEY.projectLink());
    assert.equal(result.checkpoints.length, 1);
    assert.equal(result.checkpoints[0].logicalKey, BOOTSTRAP_LOGICAL_KEY.project());
  });

  test('indeterminate link state with no link completion in the map emits the link operation; the same input with a link completion emits zero operations', () => {
    const remote = projectRemote({ projectOutcome: 'resolved', projectNodeId: 'PVT_adopted', repository: projectRepo({ linkState: 'indeterminate' }) });
    const noCompletion = planProject(remote, { kind: 'absent' }, projectTarget(9), null, CONTEXT);
    assert.equal(noCompletion.operations.length, 1);
    assert.equal(noCompletion.operations[0].logicalKey, BOOTSTRAP_LOGICAL_KEY.projectLink());

    const withCompletion = planProject(remote, {
      kind: 'valid',
      map: { completions: { [BOOTSTRAP_LOGICAL_KEY.projectLink()]: { nodeId: 'R_already_linked' } } },
    }, projectTarget(9), null, CONTEXT);
    assert.equal(withCompletion.operations.length, 0);
    assert.equal(withCompletion.checkpoints.length, 1);
  });

  test("the project checkpoint's node id is the exact remote string and its remote number equals the target's project number, neither coerced", () => {
    const remote = projectRemote({ projectOutcome: 'resolved', projectNodeId: 'PVT_exact_string', repository: projectRepo({ linkState: 'linked' }) });
    const result = planProject(remote, { kind: 'absent' }, projectTarget(42), null, CONTEXT);
    const projectCheckpoint = result.checkpoints.find((c) => c.logicalKey === BOOTSTRAP_LOGICAL_KEY.project());
    assert.strictEqual(projectCheckpoint.nodeId, 'PVT_exact_string');
    assert.strictEqual(projectCheckpoint.remoteNumber, 42);
    assert.equal(typeof projectCheckpoint.nodeId, 'string');
    assert.equal(typeof projectCheckpoint.remoteNumber, 'number');
  });

  // ── refuse path (D-04) ──
  test('a non-resolving project number yields zero operations, zero checkpoints, one blocked entry reasoned for a project not found, detail carrying the attempted number', () => {
    const remote = projectRemote({ projectOutcome: 'absent', repository: projectRepo() });
    const result = planProject(remote, { kind: 'absent' }, projectTarget(404), null, CONTEXT);
    assert.equal(result.operations.length, 0);
    assert.equal(result.checkpoints.length, 0);
    assert.equal(result.blocked.length, 1);
    assert.equal(result.blocked[0].reason, BOOTSTRAP_OPERATION_REASON.PROJECT_NOT_FOUND);
    assert.match(result.blocked[0].detail, /404/);
  });

  test('the repository document resolving with an absent or non-string owner id yields zero operations, zero checkpoints, one blocked entry reasoned for an unresolvable owner', () => {
    for (const repository of [null, projectRepo({ ownerNodeId: '' }), projectRepo({ ownerNodeId: undefined })]) {
      const result = planProject(projectRemote({ repository }), { kind: 'absent' }, projectTarget(null), null, CONTEXT);
      assert.equal(result.operations.length, 0);
      assert.equal(result.checkpoints.length, 0);
      assert.equal(result.blocked[0].reason, BOOTSTRAP_OPERATION_REASON.OWNER_UNRESOLVABLE);
    }
  });

  // ── every operation/checkpoint carries the completion context planBootstrap built ──
  test('every operation and checkpoint planProject emits carries the supplied completion context byte-identically, never derived from target independently', () => {
    const context = { owner: 'zzz-owner', repo: 'zzz-repo', repositoryNumber: 999 };
    const createResult = planProject(projectRemote(), { kind: 'absent' }, projectTarget(null), null, context);
    for (const op of createResult.operations) assert.deepEqual(op.completionContext, context);

    const adoptResult = planProject(
      projectRemote({ projectOutcome: 'resolved', projectNodeId: 'PVT_x', repository: projectRepo({ linkState: 'linked' }) }),
      { kind: 'absent' }, projectTarget(9), null, context,
    );
    for (const checkpoint of adoptResult.checkpoints) assert.deepEqual(checkpoint.completionContext, context);
  });
});

// ─── GSD_FIELDS sanity ──────────────────────────────────────────────────────

test('GSD_FIELDS carries the five D-20 declarations, in create order, with the exact required types', () => {
  assert.deepEqual(GSD_FIELDS.map((f) => f.name), ['GSD ID', 'Phase', 'Requirements', 'Wave', 'Autonomous']);
  assert.deepEqual(GSD_FIELDS.map((f) => f.dataType), ['TEXT', 'TEXT', 'TEXT', 'NUMBER', 'SINGLE_SELECT']);
});

test('GSD_AUTONOMOUS_OPTIONS (D-22) carries exactly Yes and No, in that order', () => {
  assert.deepEqual(GSD_AUTONOMOUS_OPTIONS.map((o) => o.name), ['Yes', 'No']);
});

// ─── planFields ─────────────────────────────────────────────────────────────

describe('planFields', () => {
  // ── create path ──
  test('an empty board (no GSD fields) emits exactly five create operations, in GSD_FIELDS order, under their own reserved field keys', () => {
    const result = planFields(remoteWithFields([]), { kind: 'absent' }, CONTEXT);
    assert.equal(result.operations.length, 5);
    assert.deepEqual(result.operations.map((o) => o.logicalKey), GSD_FIELDS.map((f) => BOOTSTRAP_LOGICAL_KEY.field(f.name)));
    assert.equal(result.checkpoints.length, 0);
    assert.equal(result.blocked.length, 0);
  });

  test('each create operation carries the D-20 type: TEXT for GSD ID/Phase/Requirements, NUMBER for Wave, SINGLE_SELECT with Yes/No for Autonomous', () => {
    const result = planFields(remoteWithFields([]), { kind: 'absent' }, CONTEXT);
    const byName = Object.fromEntries(GSD_FIELDS.map((f, i) => [f.name, result.operations[i]]));
    for (const name of ['GSD ID', 'Phase', 'Requirements']) {
      const query = byName[name].args.find((a) => typeof a === 'string' && a.startsWith('query='));
      assert.match(query, /github-sync-bootstrap:createFieldText/);
    }
    const waveQuery = byName.Wave.args.find((a) => typeof a === 'string' && a.startsWith('query='));
    assert.match(waveQuery, /github-sync-bootstrap:createFieldNumber/);
    const autonomousQuery = byName.Autonomous.args.find((a) => typeof a === 'string' && a.startsWith('query='));
    assert.match(autonomousQuery, /github-sync-bootstrap:createFieldSingleSelect/);
    const autonomousMerged = extractMerged(byName.Autonomous);
    assert.deepEqual(autonomousMerged.map((e) => e.name), ['Yes', 'No']);
  });

  test("the Autonomous option array's element boundaries are name-first (no id migrates across elements)", () => {
    const result = planFields(remoteWithFields([]), { kind: 'absent' }, CONTEXT);
    const autonomousOp = result.operations.find((o) => o.logicalKey === BOOTSTRAP_LOGICAL_KEY.field('Autonomous'));
    const nameIndexes = [];
    autonomousOp.args.forEach((entry, index) => {
      if (typeof entry === 'string' && entry.startsWith('options[][name]=')) nameIndexes.push(index);
    });
    assert.equal(nameIndexes.length, 2);
    assert.ok(nameIndexes[0] < nameIndexes[1]);
  });

  test('each create operation\'s argv carries exactly one reference entry whose from-key is the project key and whose part is the node-id part', () => {
    const result = planFields(remoteWithFields([]), { kind: 'absent' }, CONTEXT);
    for (const operation of result.operations) {
      const refs = operation.args.filter((a) => typeof a === 'object' && a !== null);
      assert.equal(refs.length, 1, `${operation.logicalKey} must carry exactly one reference entry`);
      assert.equal(refs[0].from, BOOTSTRAP_LOGICAL_KEY.project());
      assert.equal(refs[0].part, TOP_ARGV_REF_PART.NODE_ID);
    }
  });

  test('every field create declares content creation true', () => {
    const result = planFields(remoteWithFields([]), { kind: 'absent' }, CONTEXT);
    for (const operation of result.operations) assert.equal(operation.contentCreation, true);
  });

  // ── adopt path (HIGH-A analogue) ──
  test('HIGH-A: a board already carrying all five correct fields emits zero operations and six checkpoints — the five GSD field keys plus the built-in Status field key', () => {
    const fields = [
      field('F_id', 'GSD ID', 'TEXT'), field('F_phase', 'Phase', 'TEXT'), field('F_req', 'Requirements', 'TEXT'),
      field('F_wave', 'Wave', 'NUMBER'), field('F_auto', 'Autonomous', 'SINGLE_SELECT', []),
    ];
    const remote = remoteWithFields(fields, { statusField: field('F_status', 'Status', 'SINGLE_SELECT', []) });
    const result = planFields(remote, { kind: 'absent' }, CONTEXT);
    assert.equal(result.operations.length, 0);
    assert.equal(result.checkpoints.length, 6);
    const expectedKeys = [...GSD_FIELDS.map((f) => BOOTSTRAP_LOGICAL_KEY.field(f.name)), BOOTSTRAP_LOGICAL_KEY.field('Status')];
    assert.deepEqual(result.checkpoints.map((c) => c.logicalKey).sort(), expectedKeys.sort());
  });

  test('every field checkpoint node id is the exact remote string, never coerced', () => {
    const fields = [field('F_id', 'GSD ID', 'TEXT'), field(42, 'Phase', 'TEXT')];
    // 42 is intentionally the wrong JS type to prove the checkpoint carries
    // whatever the remote gave verbatim, never coerced across types.
    const result = planFields(remoteWithFields(fields), { kind: 'absent' }, CONTEXT);
    const idCheckpoint = result.checkpoints.find((c) => c.logicalKey === BOOTSTRAP_LOGICAL_KEY.field('GSD ID'));
    assert.strictEqual(idCheckpoint.nodeId, 'F_id');
    assert.equal(typeof idCheckpoint.nodeId, 'string');
  });

  // Fields for all five GSD declarations except GSD ID, which each test below
  // overrides — isolates the GSD ID branch under test without the other four
  // (legitimately missing) declarations spuriously contributing create
  // operations of their own.
  function otherFourFields() {
    return [
      field('F_phase', 'Phase', 'TEXT'), field('F_req', 'Requirements', 'TEXT'),
      field('F_wave', 'Wave', 'NUMBER'), field('F_auto', 'Autonomous', 'SINGLE_SELECT', []),
    ];
  }

  test('a remote field matched by name whose id is absent from the map is adopted by name: zero operations, a checkpoint carrying the observed id', () => {
    const fields = [field('F_id', 'GSD ID', 'TEXT'), ...otherFourFields()];
    const result = planFields(remoteWithFields(fields), { kind: 'absent' }, CONTEXT);
    assert.equal(result.operations.length, 0);
    const idCheckpoint = result.checkpoints.find((c) => c.logicalKey === BOOTSTRAP_LOGICAL_KEY.field('GSD ID'));
    assert.equal(idCheckpoint.nodeId, 'F_id');
  });

  test('stale-id repair: the map holds a field completion pointing at an id no remote field carries; a remote field carries the canonical name and a different id — zero operations, one checkpoint carrying the NEW id, and folding it through the real recordCompletion repairs the stale entry', () => {
    const fields = [field('F_id_new', 'GSD ID', 'TEXT'), ...otherFourFields()];
    const strictMap = { kind: 'valid', map: { completions: { [BOOTSTRAP_LOGICAL_KEY.field('GSD ID')]: { nodeId: 'F_id_stale' } } } };
    const result = planFields(remoteWithFields(fields), strictMap, CONTEXT);
    assert.equal(result.operations.length, 0);
    const idCheckpoint = result.checkpoints.find((c) => c.logicalKey === BOOTSTRAP_LOGICAL_KEY.field('GSD ID'));
    assert.equal(idCheckpoint.nodeId, 'F_id_new');

    let map = realMap.recordCompletion(null, {
      logicalKey: BOOTSTRAP_LOGICAL_KEY.field('GSD ID'), nodeId: 'F_id_stale', completedAt: '2026-01-01T00:00:00.000Z',
      owner: CONTEXT.owner, repo: CONTEXT.repo, repositoryNumber: CONTEXT.repositoryNumber,
    });
    map = realMap.recordCompletion(map, {
      logicalKey: idCheckpoint.logicalKey, nodeId: idCheckpoint.nodeId, completedAt: '2026-01-01T00:00:01.000Z',
      owner: CONTEXT.owner, repo: CONTEXT.repo, repositoryNumber: CONTEXT.repositoryNumber,
    });
    assert.equal(map.completions[BOOTSTRAP_LOGICAL_KEY.field('GSD ID')].nodeId, 'F_id_new');
  });

  // ── rename path (D-23) ──
  test('a field matched by stored id whose remote name differs emits exactly one rename operation restoring the canonical name, zero create operations, zero checkpoints for that field', () => {
    const fields = [field('F_id', 'GSD ID (renamed)', 'TEXT'), ...otherFourFields()];
    const strictMap = { kind: 'valid', map: { completions: { [BOOTSTRAP_LOGICAL_KEY.field('GSD ID')]: { nodeId: 'F_id' } } } };
    const result = planFields(remoteWithFields(fields), strictMap, CONTEXT);
    const idOps = result.operations.filter((o) => o.logicalKey === BOOTSTRAP_LOGICAL_KEY.field('GSD ID'));
    assert.equal(idOps.length, 1);
    const renameOp = idOps[0];
    assert.equal(renameOp.action, 'update');
    const nameArg = renameOp.args.find((a) => typeof a === 'string' && a.startsWith('name='));
    assert.equal(nameArg, 'name=GSD ID');
    const fieldIdArg = renameOp.args.find((a) => typeof a === 'string' && a.startsWith('fieldId='));
    assert.equal(fieldIdArg, 'fieldId=F_id');
    assert.equal(result.checkpoints.some((c) => c.logicalKey === BOOTSTRAP_LOGICAL_KEY.field('GSD ID')), false);
    assert.equal(result.operations.filter((o) => o.kind === 'create-field').length, 0);
  });

  test('the rename operation declares content creation false', () => {
    const fields = [field('F_id', 'GSD ID (renamed)', 'TEXT'), ...otherFourFields()];
    const strictMap = { kind: 'valid', map: { completions: { [BOOTSTRAP_LOGICAL_KEY.field('GSD ID')]: { nodeId: 'F_id' } } } };
    const result = planFields(remoteWithFields(fields), strictMap, CONTEXT);
    assert.equal(result.operations[0].contentCreation, false);
  });

  test('the rename case with the wrong dataType is a mismatch, not a rename: identity is followed but a wrong type is still refused', () => {
    const fields = [field('F_id', 'GSD ID (renamed)', 'NUMBER'), ...otherFourFields()];
    const strictMap = { kind: 'valid', map: { completions: { [BOOTSTRAP_LOGICAL_KEY.field('GSD ID')]: { nodeId: 'F_id' } } } };
    const result = planFields(remoteWithFields(fields), strictMap, CONTEXT);
    assert.equal(result.operations.length, 0);
    assert.equal(result.blocked.length, 1);
    assert.equal(result.blocked[0].reason, BOOTSTRAP_OPERATION_REASON.FIELD_TYPE_MISMATCH);
  });

  // ── refuse path (D-21) ──
  test('a Wave field whose remote dataType is TEXT yields exactly one blocked entry reasoned for a field type mismatch, detail naming Wave/TEXT/NUMBER', () => {
    const fields = [field('F_wave', 'Wave', 'TEXT')];
    const result = planFields(remoteWithFields(fields), { kind: 'absent' }, CONTEXT);
    assert.equal(result.blocked.length, 1);
    assert.equal(result.blocked[0].reason, BOOTSTRAP_OPERATION_REASON.FIELD_TYPE_MISMATCH);
    assert.match(result.blocked[0].detail, /Wave/);
    assert.match(result.blocked[0].detail, /TEXT/);
    assert.match(result.blocked[0].detail, /NUMBER/);
  });

  test('no emitted operation ever references the field-deletion mutation, across every case in this suite', () => {
    const cases = [
      remoteWithFields([]),
      remoteWithFields([field('F_id', 'GSD ID', 'TEXT'), field('F_phase', 'Phase', 'TEXT')]),
      remoteWithFields([field('F_wave', 'Wave', 'TEXT')]),
      remoteWithFields([field('F_id', 'GSD ID (renamed)', 'TEXT')], {}),
    ];
    for (const remote of cases) {
      const result = planFields(remote, { kind: 'absent' }, CONTEXT);
      for (const operation of result.operations) {
        for (const arg of operation.args) {
          if (typeof arg === 'string') assert.doesNotMatch(arg, /deleteProjectV2Field/);
        }
      }
    }
  });

  // ── Status field checkpoint ──
  test('the built-in Status field, when present in the remote snapshot, is checkpointed under the field namespace using the exported field-name constant', () => {
    const result = planFields(remoteWithFields([], { statusField: field('F_status', 'Status', 'SINGLE_SELECT', []) }), { kind: 'absent' }, CONTEXT);
    const statusCheckpoint = result.checkpoints.find((c) => c.logicalKey === BOOTSTRAP_LOGICAL_KEY.field(STATUS_FIELD_NAME));
    assert.ok(statusCheckpoint, 'the Status field must be checkpointed under field:status');
    assert.equal(statusCheckpoint.nodeId, 'F_status');
  });

  test('no Status field in the snapshot means no Status checkpoint', () => {
    const result = planFields(remoteWithFields([]), { kind: 'absent' }, CONTEXT);
    assert.equal(result.checkpoints.some((c) => c.logicalKey === BOOTSTRAP_LOGICAL_KEY.field(STATUS_FIELD_NAME)), false);
  });

  // ── action declarations (cycle-4 non-HIGH #2) ──
  test('each of the five field creates declares the create action, and the rename declares the update action', () => {
    const createResult = planFields(remoteWithFields([]), { kind: 'absent' }, CONTEXT);
    for (const operation of createResult.operations) assert.equal(operation.action, 'create');

    const renameFields = [field('F_id', 'GSD ID (renamed)', 'TEXT')];
    const strictMap = { kind: 'valid', map: { completions: { [BOOTSTRAP_LOGICAL_KEY.field('GSD ID')]: { nodeId: 'F_id' } } } };
    const renameResult = planFields(remoteWithFields(renameFields), strictMap, CONTEXT);
    assert.equal(renameResult.operations[0].action, 'update');
  });

  // ── completion context ──
  test('every operation and checkpoint planFields emits carries the supplied completion context verbatim', () => {
    const context = { owner: 'zzz', repo: 'zzz-repo', repositoryNumber: 999 };
    const createResult = planFields(remoteWithFields([]), { kind: 'absent' }, context);
    for (const op of createResult.operations) assert.deepEqual(op.completionContext, context);

    const adoptResult = planFields(
      remoteWithFields([field('F_id', 'GSD ID', 'TEXT')], { statusField: field('F_status', 'Status', 'SINGLE_SELECT', []) }),
      { kind: 'absent' }, context,
    );
    for (const checkpoint of adoptResult.checkpoints) {
      assert.deepEqual(checkpoint.completionContext, context);
      assert.doesNotThrow(() => realMap.recordCompletion(null, {
        logicalKey: checkpoint.logicalKey, nodeId: checkpoint.nodeId, completedAt: '2026-01-01T00:00:00.000Z',
        owner: checkpoint.completionContext.owner, repo: checkpoint.completionContext.repo, repositoryNumber: checkpoint.completionContext.repositoryNumber,
      }));
    }
  });
});

// ─── planViews ──────────────────────────────────────────────────────────────

function remoteView(id, name, layout, filter = null) {
  return { id, name, layout, filter };
}

/** A resolved remote carrying an arbitrary views list plus a fields list (Status by default so the one D-08 spec this plan ships, Backlog, always resolves). */
function remoteWithViews(views, fields = [field('PVTSSF_status', 'Status', 'SINGLE_SELECT', [])]) {
  return { available: true, projectOutcome: 'resolved', statusField: null, fields, views };
}

describe('BOOTSTRAP_LOGICAL_KEY.view', () => {
  test('slugs a view name into the reserved view: namespace', () => {
    assert.equal(BOOTSTRAP_LOGICAL_KEY.view('Backlog'), 'view:backlog');
  });
});

describe('viewFieldIdsArgv', () => {
  test('encodes each field id as its own bracket-suffixed raw -f entry, in order', () => {
    const argv = viewFieldIdsArgv('fieldIds', ['F_status', 'F_phase']);
    assert.deepEqual(argv, ['-f', 'fieldIds[]=F_status', '-f', 'fieldIds[]=F_phase']);
  });

  test('an empty field id list produces no argv entries', () => {
    assert.deepEqual(viewFieldIdsArgv('fieldIds', []), []);
  });
});

describe('GSD_VIEWS', () => {
  test('this plan declares exactly one view: Backlog, TABLE layout, the -status:Done filter, Status visible', () => {
    assert.equal(GSD_VIEWS.length, 1);
    assert.deepEqual(GSD_VIEWS[0], { name: 'Backlog', layout: VIEW_LAYOUT.TABLE, filter: '-status:Done', visibleFieldNames: ['Status'] });
  });
});

describe('planViews', () => {
  test('an empty views list with a resolvable Status field emits exactly two operations: create-view then update-view, both keyed view:backlog', () => {
    const result = planViews(remoteWithViews([]), { kind: 'absent' }, CONTEXT);
    assert.equal(result.operations.length, 2);
    assert.equal(result.operations[0].kind, 'create-view');
    assert.equal(result.operations[0].logicalKey, BOOTSTRAP_LOGICAL_KEY.view('Backlog'));
    assert.equal(result.operations[1].kind, 'update-view');
    assert.equal(result.operations[1].logicalKey, BOOTSTRAP_LOGICAL_KEY.view('Backlog'));
    assert.equal(result.checkpoints.length, 0);
    assert.equal(result.blocked.length, 0);
  });

  test('the create-view argv carries name=Backlog, layout=TABLE_LAYOUT, an ArgvRef to the project key, and the Status field id through the visibleFieldIds encoding', () => {
    const result = planViews(remoteWithViews([]), { kind: 'absent' }, CONTEXT);
    const createOp = result.operations[0];
    assert.ok(createOp.args.includes('name=Backlog'));
    assert.ok(createOp.args.includes('layout=TABLE_LAYOUT'));
    const projectRef = createOp.args.find((a) => typeof a === 'object' && a !== null && a.from === BOOTSTRAP_LOGICAL_KEY.project());
    assert.ok(projectRef, 'must carry an ArgvRef to the project key');
    assert.equal(projectRef.part, TOP_ARGV_REF_PART.NODE_ID);
    assert.equal(projectRef.prefix, 'projectId=');
    assert.ok(createOp.args.includes('fieldIds[]=PVTSSF_status'));
  });

  test('the create-view operation carries exactly one node capture: logicalKey view:backlog, nodeIdPath createProjectV2View.projectV2View.id', () => {
    const result = planViews(remoteWithViews([]), { kind: 'absent' }, CONTEXT);
    const createOp = result.operations[0];
    assert.equal(createOp.captures.length, 1);
    assert.equal(createOp.captures[0].kind, 'node');
    assert.equal(createOp.captures[0].logicalKey, BOOTSTRAP_LOGICAL_KEY.view('Backlog'));
    assert.equal(createOp.captures[0].nodeIdPath, 'createProjectV2View.projectV2View.id');
  });

  test('the update-view argv carries filter=-status:Done and resolves viewId through an ArgvRef from view:backlog (never a literal) when created in the same plan', () => {
    const result = planViews(remoteWithViews([]), { kind: 'absent' }, CONTEXT);
    const updateOp = result.operations[1];
    assert.ok(updateOp.args.includes('filter=-status:Done'));
    const viewIdRef = updateOp.args.find((a) => typeof a === 'object' && a !== null && typeof a.from === 'string' && a.prefix === 'viewId=');
    assert.ok(viewIdRef, 'must carry a viewId ArgvRef');
    assert.equal(viewIdRef.from, BOOTSTRAP_LOGICAL_KEY.view('Backlog'));
    assert.equal(viewIdRef.part, TOP_ARGV_REF_PART.NODE_ID);
    assert.equal(updateOp.args.some((a) => typeof a === 'string' && a.startsWith('viewId=')), false);
  });

  test('every operation and checkpoint planViews emits carries stage: BOOTSTRAP_STAGE.VIEWS', () => {
    const created = planViews(remoteWithViews([]), { kind: 'absent' }, CONTEXT);
    for (const op of created.operations) assert.equal(op.stage, BOOTSTRAP_STAGE.VIEWS);

    const converged = planViews(remoteWithViews([remoteView('PVTV_1', 'Backlog', 'TABLE_LAYOUT', '-status:Done')]), { kind: 'absent' }, CONTEXT);
    for (const cp of converged.checkpoints) assert.equal(cp.stage, BOOTSTRAP_STAGE.VIEWS);
  });

  test('a remote view already matching name, layout, and filter emits zero operations and one checkpoint keyed view:backlog carrying its observed node id', () => {
    const result = planViews(remoteWithViews([remoteView('PVTV_1', 'Backlog', 'TABLE_LAYOUT', '-status:Done')]), { kind: 'absent' }, CONTEXT);
    assert.equal(result.operations.length, 0);
    assert.equal(result.checkpoints.length, 1);
    assert.equal(result.checkpoints[0].logicalKey, BOOTSTRAP_LOGICAL_KEY.view('Backlog'));
    assert.equal(result.checkpoints[0].nodeId, 'PVTV_1');
  });

  test('a sync map holding view:backlog -> an id present in the remote views list under a different name resolves by id and emits one update-view restoring the name, never a second create', () => {
    const strictMap = { kind: 'valid', map: { completions: { [BOOTSTRAP_LOGICAL_KEY.view('Backlog')]: { nodeId: 'PVTV_renamed' } } } };
    const remote = remoteWithViews([remoteView('PVTV_renamed', 'Something Else', 'TABLE_LAYOUT', '-status:Done')]);
    const result = planViews(remote, strictMap, CONTEXT);
    assert.equal(result.operations.length, 1);
    assert.equal(result.operations[0].kind, 'update-view');
    assert.equal(result.operations.filter((o) => o.kind === 'create-view').length, 0);
    const nameArg = result.operations[0].args.find((a) => typeof a === 'string' && a.startsWith('name='));
    assert.equal(nameArg, 'name=Backlog');
    const viewIdArg = result.operations[0].args.find((a) => typeof a === 'string' && a.startsWith('viewId='));
    assert.equal(viewIdArg, 'viewId=PVTV_renamed');
  });

  test('no field named Status on the remote emits zero view operations and one blocked entry, never a create that silently omits the field', () => {
    const result = planViews(remoteWithViews([], []), { kind: 'absent' }, CONTEXT);
    assert.equal(result.operations.length, 0);
    assert.equal(result.checkpoints.length, 0);
    assert.equal(result.blocked.length, 1);
    assert.equal(result.blocked[0].reason, BOOTSTRAP_OPERATION_REASON.VIEW_FIELD_UNRESOLVED);
  });

  test('every operation and checkpoint planViews emits carries the supplied completion context verbatim', () => {
    const context = { owner: 'zzz', repo: 'zzz-repo', repositoryNumber: 999 };
    const created = planViews(remoteWithViews([]), { kind: 'absent' }, context);
    for (const op of created.operations) assert.deepEqual(op.completionContext, context);
    const converged = planViews(remoteWithViews([remoteView('PVTV_1', 'Backlog', 'TABLE_LAYOUT', '-status:Done')]), { kind: 'absent' }, context);
    for (const cp of converged.checkpoints) assert.deepEqual(cp.completionContext, context);
  });
});

describe('mutation document parity: view documents (D-06)', () => {
  test('CREATE_VIEW_WITH_FIELDS_DOCUMENT carries no filter variable (RESEARCH Pitfall 2: only update can set filter)', () => {
    assert.doesNotMatch(CREATE_VIEW_WITH_FIELDS_DOCUMENT, /\bfilter\b/);
  });

  test('neither view document selects rateLimit', () => {
    assert.doesNotMatch(CREATE_VIEW_WITH_FIELDS_DOCUMENT, /rateLimit/);
    assert.doesNotMatch(UPDATE_VIEW_SHAPE_WITH_FILTER_DOCUMENT, /rateLimit/);
  });

  test('CREATE_VIEW_WITH_FIELDS_DOCUMENT is byte-identical to BOOTSTRAP_DOCUMENTS.createViewWithFields', () => {
    assert.equal(CREATE_VIEW_WITH_FIELDS_DOCUMENT, bootstrapRemote.BOOTSTRAP_DOCUMENTS.createViewWithFields);
  });

  test('UPDATE_VIEW_SHAPE_WITH_FILTER_DOCUMENT is byte-identical to BOOTSTRAP_DOCUMENTS.updateViewShapeWithFilter', () => {
    assert.equal(UPDATE_VIEW_SHAPE_WITH_FILTER_DOCUMENT, bootstrapRemote.BOOTSTRAP_DOCUMENTS.updateViewShapeWithFilter);
  });
});

// ─── validateFatalConditions ────────────────────────────────────────────────

describe('validateFatalConditions', () => {
  test('a correctly-typed board yields zero fatal blocks', () => {
    const fields = [field('F_id', 'GSD ID', 'TEXT'), field('F_wave', 'Wave', 'NUMBER')];
    assert.deepEqual(validateFatalConditions(remoteWithFields(fields), { kind: 'absent' }), []);
  });

  test('a single wrong-typed GSD field yields exactly one fatal block reasoned for a field type mismatch', () => {
    const fields = [field('F_wave', 'Wave', 'TEXT')];
    const blocked = validateFatalConditions(remoteWithFields(fields), { kind: 'absent' });
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].reason, BOOTSTRAP_OPERATION_REASON.FIELD_TYPE_MISMATCH);
  });

  test('an empty remote field list yields zero fatal blocks (nothing to mismatch against yet)', () => {
    assert.deepEqual(validateFatalConditions(remoteWithFields([]), { kind: 'absent' }), []);
  });

  test('never references the field-deletion mutation — it returns diagnostic data only, no operations at all', () => {
    const fields = [field('F_wave', 'Wave', 'TEXT')];
    const blocked = validateFatalConditions(remoteWithFields(fields), { kind: 'absent' });
    assert.equal(Array.isArray(blocked), true);
    for (const entry of blocked) assert.equal(typeof entry.detail === 'string' || entry.detail === undefined, true);
  });
});

// ─── planAutonomousOptions (plan 03-04 Task 3) ──────────────────────────────

function autonomousField(id, options) {
  return field(id, 'Autonomous', 'SINGLE_SELECT', options);
}

describe('planAutonomousOptions', () => {
  test('Autonomous exists with exactly Yes and No: zero operations, two checkpoints — one per declared option (Phase 5 Pitfall 1)', () => {
    const remote = remoteWithFields([autonomousField('F_auto', [opt('id-yes', 'Yes', 'GREEN', ''), opt('id-no', 'No', 'RED', '')])]);
    const result = planAutonomousOptions(remote, { kind: 'absent' }, CONTEXT);
    assert.equal(result.operations.length, 0);
    assert.equal(result.checkpoints.length, 2);
  });

  test('each converged checkpoint carries the matched remote option\'s own node id, the reserved autonomousOption key, and the supplied completion context', () => {
    const remote = remoteWithFields([autonomousField('F_auto', [opt('id-yes', 'Yes', 'GREEN', ''), opt('id-no', 'No', 'RED', '')])]);
    const result = planAutonomousOptions(remote, { kind: 'absent' }, CONTEXT);
    const byKey = Object.fromEntries(result.checkpoints.map((c) => [c.logicalKey, c]));
    assert.equal(byKey[BOOTSTRAP_LOGICAL_KEY.autonomousOption('Yes')].nodeId, 'id-yes');
    assert.equal(byKey[BOOTSTRAP_LOGICAL_KEY.autonomousOption('No')].nodeId, 'id-no');
    for (const checkpoint of result.checkpoints) assert.deepEqual(checkpoint.completionContext, CONTEXT);
  });

  test('Autonomous exists with Yes, No, and an extra Maybe option: one operation, outgoing array has exactly Yes and No, Maybe pruned (D-22)', () => {
    const remote = remoteWithFields([autonomousField('F_auto', [
      opt('id-yes', 'Yes', 'GREEN', ''), opt('id-no', 'No', 'RED', ''), opt('id-maybe', 'Maybe', 'PURPLE', ''),
    ])]);
    const result = planAutonomousOptions(remote, { kind: 'absent' }, CONTEXT);
    assert.equal(result.operations.length, 1);
    const merged = extractMerged(result.operations[0]);
    assert.equal(merged.length, 2);
    assert.equal(merged.some((e) => e.name === 'Maybe'), false);
  });

  test('the extras case echoes the existing Yes and No ids verbatim', () => {
    const remote = remoteWithFields([autonomousField('F_auto', [
      opt('id-yes', 'Yes', 'GREEN', ''), opt('id-no', 'No', 'RED', ''), opt('id-maybe', 'Maybe', 'PURPLE', ''),
    ])]);
    const result = planAutonomousOptions(remote, { kind: 'absent' }, CONTEXT);
    const merged = extractMerged(result.operations[0]);
    assert.equal(merged.find((e) => e.name === 'Yes').id, 'id-yes');
    assert.equal(merged.find((e) => e.name === 'No').id, 'id-no');
  });

  test('Autonomous exists with only Yes: one operation, outgoing array is Yes (with id) then No (no id key), name-first element ordering preserved', () => {
    const remote = remoteWithFields([autonomousField('F_auto', [opt('id-yes', 'Yes', 'GREEN', '')])]);
    const result = planAutonomousOptions(remote, { kind: 'absent' }, CONTEXT);
    const merged = extractMerged(result.operations[0]);
    assert.deepEqual(merged.map((e) => e.name), ['Yes', 'No']);
    assert.equal(merged[0].id, 'id-yes');
    assert.equal(merged[1].id, undefined);
  });

  test('Autonomous does not exist in the snapshot: zero operations, zero checkpoints', () => {
    const remote = remoteWithFields([field('F_id', 'GSD ID', 'TEXT')]);
    const result = planAutonomousOptions(remote, { kind: 'absent' }, CONTEXT);
    assert.equal(result.operations.length, 0);
    assert.equal(result.checkpoints.length, 0);
  });

  test("the emitted operation's logical key is the Autonomous field's reserved key, it carries exactly two captures (one node under field:autonomous, one each whose keyMap has the two option keys), and the mutation branch itself emits zero checkpoints (checkpoints are the converged branch's own shape)", () => {
    const remote = remoteWithFields([autonomousField('F_auto', [opt('id-yes', 'Yes', 'GREEN', '')])]);
    const result = planAutonomousOptions(remote, { kind: 'absent' }, CONTEXT);
    const operation = result.operations[0];
    assert.equal(operation.logicalKey, BOOTSTRAP_LOGICAL_KEY.field('Autonomous'));
    assert.equal(operation.captures.length, 2);
    const nodeCapture = operation.captures.find((c) => c.kind === 'node');
    const eachCapture = operation.captures.find((c) => c.kind === 'each');
    assert.equal(nodeCapture.logicalKey, BOOTSTRAP_LOGICAL_KEY.field('Autonomous'));
    assert.deepEqual(eachCapture.keyMap, {
      Yes: BOOTSTRAP_LOGICAL_KEY.autonomousOption('Yes'),
      No: BOOTSTRAP_LOGICAL_KEY.autonomousOption('No'),
    });
    assert.equal(eachCapture.listPath, 'updateProjectV2Field.projectV2Field.options');
    assert.equal(eachCapture.matchPath, 'name');
    assert.equal(eachCapture.nodeIdPath, 'id');
    assert.equal(result.checkpoints.length, 0);
  });

  test('a response option whose name is not a declared GSD option contributes no completion — the each-capture keyMap is closed (GSD checkpoints only what GSD declares)', () => {
    const remote = remoteWithFields([autonomousField('F_auto', [
      opt('id-yes', 'Yes', 'GREEN', ''), opt('id-no', 'No', 'RED', ''), opt('id-maybe', 'Maybe', 'PURPLE', ''),
    ])]);
    const result = planAutonomousOptions(remote, { kind: 'absent' }, CONTEXT);
    const operation = result.operations[0];
    const eachCapture = operation.captures.find((c) => c.kind === 'each');
    // Maybe is pruned from the outgoing merged array (D-22) and is also
    // absent from the capture's own keyMap — a doubly-closed control: even
    // if a remote somehow still echoed it back, the keyMap alone would
    // refuse to mint a completion for it.
    assert.equal(eachCapture.keyMap.Maybe, undefined);
    const response = { data: { updateProjectV2Field: { projectV2Field: { id: 'F_auto', options: [
      { id: 'id-yes', name: 'Yes' }, { id: 'id-no', name: 'No' }, { id: 'id-maybe', name: 'Maybe' },
    ] } } } };
    const decoded = decodeCompletions(operation, response.data, '2026-01-01T00:00:00.000Z');
    assert.equal(decoded.length, 3); // one node completion (field:autonomous) + two option completions (Maybe skipped)
    assert.equal(decoded.some((d) => d.nodeId === 'id-maybe'), false);
  });

  test('applying the mutation-branch operation against a mocked response containing both options records two option completions plus the field completion', () => {
    const remote = remoteWithFields([autonomousField('F_auto', [opt('id-yes', 'Yes', 'GREEN', '')])]);
    const result = planAutonomousOptions(remote, { kind: 'absent' }, CONTEXT);
    const operation = result.operations[0];
    const response = { updateProjectV2Field: { projectV2Field: { id: 'F_auto', options: [
      { id: 'id-yes', name: 'Yes' }, { id: 'id-no', name: 'No' },
    ] } } };
    const decoded = decodeCompletions(operation, response, '2026-01-01T00:00:00.000Z');
    assert.equal(decoded.length, 3);
    const byKey = Object.fromEntries(decoded.map((d) => [d.logicalKey, d.nodeId]));
    assert.equal(byKey[BOOTSTRAP_LOGICAL_KEY.field('Autonomous')], 'F_auto');
    assert.equal(byKey[BOOTSTRAP_LOGICAL_KEY.autonomousOption('Yes')], 'id-yes');
    assert.equal(byKey[BOOTSTRAP_LOGICAL_KEY.autonomousOption('No')], 'id-no');
  });

  test('the operation declares its producing stage explicitly (the autonomous/options stage), even though its logical key carries the field prefix', () => {
    const remote = remoteWithFields([autonomousField('F_auto', [opt('id-yes', 'Yes', 'GREEN', '')])]);
    const result = planAutonomousOptions(remote, { kind: 'absent' }, CONTEXT);
    const operation = result.operations[0];
    assert.equal(operation.stage, BOOTSTRAP_STAGE.AUTONOMOUS);
    assert.notEqual(operation.stage, BOOTSTRAP_STAGE.FIELDS);
    assert.ok(operation.logicalKey.startsWith('field:'), 'the logical key must still carry the field: prefix');
  });

  test('content creation is true when the outgoing array mints a new option and false when it only prunes', () => {
    const pruneOnly = remoteWithFields([autonomousField('F_auto', [opt('id-yes', 'Yes', 'GREEN', ''), opt('id-no', 'No', 'RED', ''), opt('id-maybe', 'Maybe', 'PURPLE', '')])]);
    const pruneResult = planAutonomousOptions(pruneOnly, { kind: 'absent' }, CONTEXT);
    assert.equal(pruneResult.operations[0].contentCreation, false);

    const addsOne = remoteWithFields([autonomousField('F_auto', [opt('id-yes', 'Yes', 'GREEN', '')])]);
    const addResult = planAutonomousOptions(addsOne, { kind: 'absent' }, CONTEXT);
    assert.equal(addResult.operations[0].contentCreation, true);
  });

  test('the update action, no points budget, GraphQL transport', () => {
    const remote = remoteWithFields([autonomousField('F_auto', [opt('id-yes', 'Yes', 'GREEN', '')])]);
    const result = planAutonomousOptions(remote, { kind: 'absent' }, CONTEXT);
    assert.equal(result.operations[0].action, 'update');
    assert.equal(result.operations[0].transport, 'graphql');
    assert.equal(result.operations[0].hasPointsBudget, false);
  });

  test('a direct comparison: the same remote option list diverges between planStatusOptionMerge (keeps the unknown extra) and planAutonomousOptions (drops it)', () => {
    const options = [opt('id-a', 'Todo', 'GRAY', ''), opt('id-extra', 'Extra', 'PURPLE', '')];
    const statusRemote = { available: true, projectOutcome: 'resolved', statusField: statusField(options) };
    const statusResult = planStatusOptionMerge(statusRemote, { kind: 'absent' }, CONTEXT);
    const statusMerged = extractMerged(statusResult.operation);
    assert.ok(statusMerged.some((e) => e.name === 'Extra'), 'Status preserves the unknown extra');

    const autoOptions = [opt('id-yes', 'Yes', 'GREEN', ''), opt('id-extra', 'Extra', 'PURPLE', '')];
    const autoRemote = remoteWithFields([autonomousField('F_auto', autoOptions)]);
    const autoResult = planAutonomousOptions(autoRemote, { kind: 'absent' }, CONTEXT);
    const autoMerged = extractMerged(autoResult.operations[0]);
    assert.equal(autoMerged.some((e) => e.name === 'Extra'), false, 'Autonomous drops the unknown extra');
  });
});

// ─── planLabels (plan 03-05 Task 3) ────────────────────────────────────────

function remoteLabel(nodeId, name) {
  return { nodeId, name };
}

describe('planLabels', () => {
  test('an empty repo (no GSD labels) emits two create operations, gsd:phase then gsd:plan, under their own reserved label keys, and zero checkpoints', () => {
    const result = planLabels({ available: true, labels: [] }, { kind: 'absent' }, CONTEXT);
    assert.equal(result.operations.length, 2);
    assert.deepEqual(result.operations.map((o) => o.logicalKey), GSD_LABELS.map((l) => BOOTSTRAP_LOGICAL_KEY.label(l.name)));
    assert.equal(result.checkpoints.length, 0);
  });

  test('the repo already has gsd:phase with an exactly matching name: one create for gsd:plan only, one noop, one adoption checkpoint carrying its node id', () => {
    const result = planLabels({ available: true, labels: [remoteLabel('L_phase', 'gsd:phase')] }, { kind: 'absent' }, CONTEXT);
    assert.equal(result.operations.length, 1);
    assert.equal(result.operations[0].logicalKey, BOOTSTRAP_LOGICAL_KEY.label('gsd:plan'));
    assert.equal(result.noops.length, 1);
    assert.equal(result.checkpoints.length, 1);
    assert.equal(result.checkpoints[0].logicalKey, BOOTSTRAP_LOGICAL_KEY.label('gsd:phase'));
    assert.equal(result.checkpoints[0].nodeId, 'L_phase');
  });

  test('the repo already has both labels exactly: zero operations, two noops, two adoption checkpoints', () => {
    const remote = { available: true, labels: [remoteLabel('L_phase', 'gsd:phase'), remoteLabel('L_plan', 'gsd:plan')] };
    const result = planLabels(remote, { kind: 'absent' }, CONTEXT);
    assert.equal(result.operations.length, 0);
    assert.equal(result.noops.length, 2);
    assert.equal(result.checkpoints.length, 2);
  });

  test("T-03-32 / case-variant convergence: a label spelled GSD:Phase yields zero create operations for it, one noop whose detail names the observed spelling, and one checkpoint carrying its node id under GSD's own reserved key", () => {
    const result = planLabels({ available: true, labels: [remoteLabel('L_variant', 'GSD:Phase')] }, { kind: 'absent' }, CONTEXT);
    assert.equal(result.operations.some((o) => o.logicalKey === BOOTSTRAP_LOGICAL_KEY.label('gsd:phase')), false);
    const variantNoop = result.noops.find((n) => n.detail);
    assert.ok(variantNoop, 'the case-variant branch must record a noop with a detail');
    assert.match(variantNoop.detail, /GSD:Phase/);
    const checkpoint = result.checkpoints.find((c) => c.logicalKey === BOOTSTRAP_LOGICAL_KEY.label('gsd:phase'));
    assert.ok(checkpoint, 'the case-variant label must still be checkpointed under GSD\'s reserved key');
    assert.equal(checkpoint.nodeId, 'L_variant');
    // gsd:plan is still genuinely missing -> its own create operation.
    assert.equal(result.operations.length, 1);
    assert.equal(result.operations[0].logicalKey, BOOTSTRAP_LOGICAL_KEY.label('gsd:plan'));
  });

  test('a three-round test against a permanently case-variant repository (cycle-2 non-HIGH #4): rounds two and three each emit zero label operations', () => {
    const remote = { available: true, labels: [remoteLabel('L_variant', 'GSD:Phase'), remoteLabel('L_plan', 'gsd:plan')] };
    let strictMap = { kind: 'absent' };
    for (let round = 1; round <= 3; round += 1) {
      const result = planLabels(remote, strictMap, CONTEXT);
      if (round > 1) assert.equal(result.operations.length, 0, `round ${round} must emit zero label operations`);
      let map = strictMap.kind === 'valid' ? strictMap.map : null;
      for (const checkpoint of result.checkpoints) {
        map = realMap.recordCompletion(map, {
          logicalKey: checkpoint.logicalKey, nodeId: checkpoint.nodeId, completedAt: '2026-01-01T00:00:00.000Z',
          owner: CONTEXT.owner, repo: CONTEXT.repo, repositoryNumber: CONTEXT.repositoryNumber,
        });
      }
      strictMap = { kind: 'valid', map };
    }
  });

  test('a label differing from gsd:phase by more than case is ignored entirely: no operation, no noop, no checkpoint for it, and both GSD labels still plan a create', () => {
    const result = planLabels({ available: true, labels: [remoteLabel('L_other', 'gsd-phase')] }, { kind: 'absent' }, CONTEXT);
    assert.equal(result.operations.length, 2);
    assert.equal(result.checkpoints.length, 0);
    assert.equal(result.noops.length, 0);
  });

  test('planLabels never emits an operation that would edit or remove an existing label — POST is the only HTTP method value appearing in any emitted argv', () => {
    const cases = [
      { available: true, labels: [] },
      { available: true, labels: [remoteLabel('L_phase', 'gsd:phase')] },
      { available: true, labels: [remoteLabel('L_variant', 'GSD:Phase')] },
    ];
    for (const remote of cases) {
      const result = planLabels(remote, { kind: 'absent' }, CONTEXT);
      for (const operation of result.operations) {
        assert.equal(operation.action, 'create');
        const methods = operation.args.filter((arg, index) => operation.args[index - 1] === '-X');
        for (const method of methods) assert.equal(method, 'POST');
      }
    }
  });

  test('every emitted label create declares the REST transport, the create action, no points budget, and content creation true', () => {
    const result = planLabels({ available: true, labels: [] }, { kind: 'absent' }, CONTEXT);
    for (const operation of result.operations) {
      assert.equal(operation.transport, 'rest');
      assert.equal(operation.action, 'create');
      assert.equal(operation.hasPointsBudget, false);
      assert.equal(operation.contentCreation, true);
    }
  });

  test('every argv entry carrying a string value is immediately preceded by the raw-value flag', () => {
    const result = planLabels({ available: true, labels: [] }, { kind: 'absent' }, CONTEXT);
    for (const operation of result.operations) {
      for (let i = 0; i < operation.args.length; i += 1) {
        const entry = operation.args[i];
        if (typeof entry !== 'string' || entry === 'api' || entry === operation.args[1] || entry === '-X' || entry === 'POST' || entry === '-f') continue;
        assert.equal(operation.args[i - 1], '-f', `${entry} must be preceded by -f`);
      }
    }
  });

  test('every operation and checkpoint planLabels emits carries the supplied completion context verbatim, and folds through the real recordCompletion without throwing', () => {
    const context = { owner: 'zzz', repo: 'zzz-repo', repositoryNumber: 999 };
    const createResult = planLabels({ available: true, labels: [] }, { kind: 'absent' }, context);
    for (const op of createResult.operations) assert.deepEqual(op.completionContext, context);

    const adoptResult = planLabels({ available: true, labels: [remoteLabel('L_phase', 'gsd:phase'), remoteLabel('L_plan', 'gsd:plan')] }, { kind: 'absent' }, context);
    for (const checkpoint of adoptResult.checkpoints) {
      assert.deepEqual(checkpoint.completionContext, context);
      assert.doesNotThrow(() => realMap.recordCompletion(null, {
        logicalKey: checkpoint.logicalKey, nodeId: checkpoint.nodeId, completedAt: '2026-01-01T00:00:00.000Z',
        owner: checkpoint.completionContext.owner, repo: checkpoint.completionContext.repo, repositoryNumber: checkpoint.completionContext.repositoryNumber,
      }));
    }
  });
});

// ─── parseMilestoneVersionToken (plan 03-05 Task 3) ────────────────────────

describe('parseMilestoneVersionToken', () => {
  test('returns the whole token for a well-formed leading version', () => {
    assert.equal(parseMilestoneVersionToken('v1.0 — name'), 'v1.0');
  });

  test('returns null when the token is not in the leading position', () => {
    assert.equal(parseMilestoneVersionToken('prefix v1.0 — name'), null);
  });

  test('tolerates leading ASCII whitespace', () => {
    assert.equal(parseMilestoneVersionToken('  v1.0 — name'), 'v1.0');
  });

  test('parses a double-digit minor and a three-segment version whole', () => {
    assert.equal(parseMilestoneVersionToken('v1.10 — name'), 'v1.10');
    assert.equal(parseMilestoneVersionToken('v1.2.3 — name'), 'v1.2.3');
  });
});

// ─── planMilestones (plan 03-05 Task 3) ────────────────────────────────────

const MILESTONE_EM_DASH = '—';
function milestoneTitle(version, name) {
  return `${version} ${MILESTONE_EM_DASH} ${name}`;
}
function desiredMilestoneFixture(version, name, archived = false) {
  return { version, name, title: milestoneTitle(version, name), description: `desc for ${version}`, archived };
}
function remoteMilestone(nodeId, title, number, state) {
  return { nodeId, name: title, number, state };
}

describe('planMilestones', () => {
  test('one archived and one current desired milestone, repo has none: two create operations; archived carries the closed state, current carries the open state (D-25)', () => {
    const desired = { available: true, milestones: [desiredMilestoneFixture('v0.9', 'archived', true), desiredMilestoneFixture('v1.0', 'current', false)] };
    const result = planMilestones(desired, { available: true, milestones: [] }, { kind: 'absent' }, CONTEXT);
    assert.equal(result.operations.length, 2);
    const archivedOp = result.operations.find((o) => o.logicalKey === BOOTSTRAP_LOGICAL_KEY.milestone('v0.9'));
    const currentOp = result.operations.find((o) => o.logicalKey === BOOTSTRAP_LOGICAL_KEY.milestone('v1.0'));
    assert.equal(findArg(archivedOp, 'state='), 'state=closed');
    assert.equal(findArg(currentOp, 'state='), 'state=open');
  });

  test("a remote milestone whose leading version token matches a desired version but whose name portion differs: zero operations, one noop, one checkpoint carrying its node id and its number, title never rewritten", () => {
    const desired = { available: true, milestones: [desiredMilestoneFixture('v1.0', 'current', false)] };
    const remote = { available: true, milestones: [remoteMilestone('M_1', 'v1.0 — a different name', 3, 'open')] };
    const result = planMilestones(desired, remote, { kind: 'absent' }, CONTEXT);
    assert.equal(result.operations.length, 0);
    assert.equal(result.noops.length, 1);
    assert.equal(result.checkpoints.length, 1);
    assert.equal(result.checkpoints[0].nodeId, 'M_1');
    assert.equal(result.checkpoints[0].remoteNumber, 3);
  });

  test('a milestone whose stored completion holds a node id is resolved by that id first, falling back to the version token (D-17/D-23)', () => {
    const desired = { available: true, milestones: [desiredMilestoneFixture('v1.0', 'current', false)] };
    const remote = { available: true, milestones: [remoteMilestone('M_stale', 'v1.0 — old title', 3, 'open')] };
    const strictMap = { kind: 'valid', map: { completions: { [BOOTSTRAP_LOGICAL_KEY.milestone('v1.0')]: { nodeId: 'M_stale' } } } };
    const result = planMilestones(desired, remote, strictMap, CONTEXT);
    assert.equal(result.checkpoints[0].nodeId, 'M_stale');
  });

  test('no emitted milestone operation carries a due-date field of any kind (D-27)', () => {
    // planner-discipline-allow: due
    const desired = { available: true, milestones: [desiredMilestoneFixture('v1.0', 'current', false)] };
    const result = planMilestones(desired, { available: true, milestones: [] }, { kind: 'absent' }, CONTEXT);
    for (const operation of result.operations) {
      for (const arg of operation.args) {
        if (typeof arg === 'string') assert.doesNotMatch(arg, /due/i);
      }
    }
  });

  test("no emitted milestone operation updates an existing milestone's description (D-27's set-once rule) — a matched milestone produces zero operations", () => {
    const desired = { available: true, milestones: [desiredMilestoneFixture('v1.0', 'current', false)] };
    const remote = { available: true, milestones: [remoteMilestone('M_1', 'v1.0 — current', 3, 'open')] };
    const result = planMilestones(desired, remote, { kind: 'absent' }, CONTEXT);
    assert.equal(result.operations.length, 0);
  });

  test('planMilestones never emits an operation carrying an HTTP method other than POST', () => {
    const desired = { available: true, milestones: [desiredMilestoneFixture('v1.0', 'current', false)] };
    const result = planMilestones(desired, { available: true, milestones: [] }, { kind: 'absent' }, CONTEXT);
    for (const operation of result.operations) {
      const methods = operation.args.filter((arg, index) => operation.args[index - 1] === '-X');
      for (const method of methods) assert.equal(method, 'POST');
    }
  });

  test('every label and milestone operation declares a single node capture whose node-id path addresses the response body\'s own node-id scalar — with a number path for milestones only', () => {
    const labelResult = planLabels({ available: true, labels: [] }, { kind: 'absent' }, CONTEXT);
    for (const operation of labelResult.operations) {
      assert.equal(operation.captures.length, 1);
      assert.equal(operation.captures[0].kind, 'node');
      assert.equal(operation.captures[0].nodeIdPath, 'node_id');
      assert.equal(operation.captures[0].numberPath, undefined);
    }
    const desired = { available: true, milestones: [desiredMilestoneFixture('v1.0', 'current', false)] };
    const milestoneResult = planMilestones(desired, { available: true, milestones: [] }, { kind: 'absent' }, CONTEXT);
    for (const operation of milestoneResult.operations) {
      assert.equal(operation.captures[0].nodeIdPath, 'node_id');
      assert.equal(operation.captures[0].numberPath, 'number');
    }
  });

  test('every string value rides the raw-value flag; a milestone title containing an em-dash and a description containing arbitrary ROADMAP heading text survive verbatim', () => {
    const desired = { available: true, milestones: [{ version: 'v1.0', name: 'x', title: 'v1.0 — name with — em dash', description: '## arbitrary ROADMAP heading text', archived: false }] };
    const result = planMilestones(desired, { available: true, milestones: [] }, { kind: 'absent' }, CONTEXT);
    const operation = result.operations[0];
    const titleIndex = operation.args.findIndex((arg) => typeof arg === 'string' && arg.startsWith('title='));
    assert.equal(operation.args[titleIndex - 1], '-f');
    assert.equal(operation.args[titleIndex], `title=${desired.milestones[0].title}`);
    const descriptionIndex = operation.args.findIndex((arg) => typeof arg === 'string' && arg.startsWith('description='));
    assert.equal(operation.args[descriptionIndex - 1], '-f');
    assert.equal(operation.args[descriptionIndex], `description=${desired.milestones[0].description}`);
  });

  test('planBootstrap translates every member of the remote-layer reason enum to a member of the operation-layer reason enum', () => {
    for (const remoteReason of Object.values(bootstrapRemote.BOOTSTRAP_REMOTE_REASON)) {
      const plan = planBootstrap({
        desired: { available: true },
        remote: { available: false, reason: remoteReason, projectOutcome: 'unavailable', statusField: null },
        strictMap: { kind: 'absent' },
        target: { owner: 'octo', repo: 'repo', repositoryNumber: 1, projectNumber: 7 },
      }, { pass: BOOTSTRAP_PASS.OPTIONS });
      assert.equal(plan.operations.length, 0);
      const operationReasons = Object.values(BOOTSTRAP_OPERATION_REASON);
      assert.ok(
        operationReasons.includes(plan.uncertain[0].reason),
        `reason "${plan.uncertain[0].reason}" for remote reason "${remoteReason}" is not a member of BOOTSTRAP_OPERATION_REASON`,
      );
    }
  });

  test('every operation and checkpoint planLabels and planMilestones emit carry the completion context planBootstrap supplied, and folding any checkpoint through the real recordCompletion does not throw', () => {
    const target = { owner: 'octo', repo: 'repo', repositoryNumber: 1, projectNumber: 9 };
    const remote = {
      available: true, projectOutcome: 'resolved',
      repository: { nodeId: 'R_1', ownerNodeId: 'O_1', ownerLogin: 'octo', linkState: 'linked' },
      projectNodeId: 'PVT_1', statusField: null,
      fields: [
        { id: 'F_id', name: 'GSD ID', dataType: 'TEXT', options: null },
        { id: 'F_phase', name: 'Phase', dataType: 'TEXT', options: null },
        { id: 'F_req', name: 'Requirements', dataType: 'TEXT', options: null },
        { id: 'F_wave', name: 'Wave', dataType: 'NUMBER', options: null },
        { id: 'F_auto', name: 'Autonomous', dataType: 'SINGLE_SELECT', options: [] },
      ],
      labels: [remoteLabel('L_phase', 'gsd:phase')],
      milestones: [remoteMilestone('M_1', 'v1.0 — current', 3, 'open')],
    };
    const desired = { available: true, milestones: [desiredMilestoneFixture('v1.0', 'current', false)] };
    const plan = planBootstrap({ desired, remote, strictMap: { kind: 'absent' }, target }, { pass: BOOTSTRAP_PASS.STRUCTURE });
    for (const item of [...plan.operations, ...plan.checkpoints]) {
      assert.deepEqual(item.completionContext, { owner: 'octo', repo: 'repo', repositoryNumber: 1 });
    }
    for (const checkpoint of plan.checkpoints) {
      assert.doesNotThrow(() => realMap.recordCompletion(null, {
        logicalKey: checkpoint.logicalKey, nodeId: checkpoint.nodeId,
        ...(checkpoint.remoteNumber === undefined ? {} : { issueNumber: checkpoint.remoteNumber }),
        completedAt: '2026-01-01T00:00:00.000Z',
        owner: checkpoint.completionContext.owner, repo: checkpoint.completionContext.repo, repositoryNumber: checkpoint.completionContext.repositoryNumber,
      }));
    }
  });
});

// ─── planBootstrap wiring: planProject drives the structure pass ──────────

describe('planBootstrap structure pass wiring (plan 03-03)', () => {
  const target = { owner: 'octo', repo: 'gsd-core', repositoryNumber: 1, projectNumber: null };

  test('an unset project number produces the create-and-link structure plan (project ops lead; plan 03-04 Task 2 appends field creates after them)', () => {
    const plan = planBootstrap({
      desired: { available: true },
      remote: projectRemote(),
      strictMap: { kind: 'absent' },
      target,
    }, { pass: BOOTSTRAP_PASS.STRUCTURE });
    assert.equal(plan.operations[0].logicalKey, BOOTSTRAP_LOGICAL_KEY.project());
    assert.equal(plan.operations[1].logicalKey, BOOTSTRAP_LOGICAL_KEY.projectLink());
    assert.equal(plan.blocked.length, 0);
  });

  test('when planProject blocks, the structure pass reports zero operations and zero checkpoints — planFields never runs (Shape)', () => {
    const plan = planBootstrap({
      desired: { available: true },
      remote: projectRemote({ repository: null }),
      strictMap: { kind: 'absent' },
      target,
    }, { pass: BOOTSTRAP_PASS.STRUCTURE });
    assert.equal(plan.operations.length, 0);
    assert.equal(plan.checkpoints.length, 0);
    assert.equal(plan.blocked[0].reason, BOOTSTRAP_OPERATION_REASON.OWNER_UNRESOLVABLE);
  });

  test('planBootstrap threads a configured projectTitle through to planProject', () => {
    const plan = planBootstrap({
      desired: { available: true },
      remote: projectRemote(),
      strictMap: { kind: 'absent' },
      target,
      projectTitle: 'Configured Title',
    }, { pass: BOOTSTRAP_PASS.STRUCTURE });
    assert.equal(findArg(plan.operations[0], 'title='), 'title=Configured Title');
  });

  // ── plan 03-04 Task 2: planFields runs after planProject in the structure pass ──

  test('the structure pass runs planFields after planProject: on an unset project with an empty field list, 2 project operations followed by 5 field operations', () => {
    // Labels present exactly (plan 03-05 Task 3's own stage) so this test's
    // narrow focus — field-create ordering after the project ops — stays
    // isolated from the label stage's own behavior, covered separately below.
    const plan = planBootstrap({
      desired: { available: true },
      remote: projectRemote({ fields: [], labels: bothGsdLabelsAdopted() }),
      strictMap: { kind: 'absent' },
      target,
    }, { pass: BOOTSTRAP_PASS.STRUCTURE });
    assert.equal(plan.operations.length, 7);
    assert.equal(plan.operations[0].logicalKey, BOOTSTRAP_LOGICAL_KEY.project());
    assert.equal(plan.operations[1].logicalKey, BOOTSTRAP_LOGICAL_KEY.projectLink());
    assert.deepEqual(plan.operations.slice(2).map((o) => o.logicalKey), GSD_FIELDS.map((f) => BOOTSTRAP_LOGICAL_KEY.field(f.name)));
  });

  test('an adopted, fully-fielded, fully-labeled board produces zero structure operations and ten checkpoints (project, link, five fields, Status, two labels)', () => {
    const adoptedTarget = { ...target, projectNumber: 9 };
    const fields = [
      { id: 'F_id', name: 'GSD ID', dataType: 'TEXT', options: null },
      { id: 'F_phase', name: 'Phase', dataType: 'TEXT', options: null },
      { id: 'F_req', name: 'Requirements', dataType: 'TEXT', options: null },
      { id: 'F_wave', name: 'Wave', dataType: 'NUMBER', options: null },
      { id: 'F_auto', name: 'Autonomous', dataType: 'SINGLE_SELECT', options: [] },
    ];
    const remote = projectRemote({
      projectOutcome: 'resolved', projectNodeId: 'PVT_adopted', repository: projectRepo({ linkState: 'linked' }),
      fields, statusField: { id: 'F_status', name: 'Status', dataType: 'SINGLE_SELECT', options: [] },
      labels: bothGsdLabelsAdopted(),
    });
    const plan = planBootstrap({ desired: { available: true }, remote, strictMap: { kind: 'absent' }, target: adoptedTarget }, { pass: BOOTSTRAP_PASS.STRUCTURE });
    assert.equal(plan.operations.length, 0);
    assert.equal(plan.checkpoints.length, 10);
  });

  test('the structure pass runs planLabels then planMilestones after planFields: project, link, five fields, two labels, one milestone, in that order', () => {
    const desired = { available: true, milestones: [{ version: 'v1.0', name: 'current', title: 'v1.0 — current', description: '', archived: false }] };
    const plan = planBootstrap({
      desired,
      remote: projectRemote({ fields: [] }),
      strictMap: { kind: 'absent' },
      target,
    }, { pass: BOOTSTRAP_PASS.STRUCTURE });
    assert.deepEqual(plan.operations.map((o) => o.logicalKey), [
      BOOTSTRAP_LOGICAL_KEY.project(),
      BOOTSTRAP_LOGICAL_KEY.projectLink(),
      ...GSD_FIELDS.map((f) => BOOTSTRAP_LOGICAL_KEY.field(f.name)),
      ...GSD_LABELS.map((l) => BOOTSTRAP_LOGICAL_KEY.label(l.name)),
      BOOTSTRAP_LOGICAL_KEY.milestone('v1.0'),
    ]);
  });
});

// ─── planBootstrap run-fatal suppression (D-21, plan 03-04 Task 2) ─────────

describe('planBootstrap run-fatal suppression', () => {
  // An adopted project (never absent — see the plan's own note on why an
  // absent project and a writable Status merge are mutually exclusive
  // inputs) with one missing field (so planFields would create), Status
  // needing an added option (so planStatusOptionMerge would write), plus one
  // wrong-typed field.
  function fatalTarget() {
    return { owner: 'octo', repo: 'repo', repositoryNumber: 1, projectNumber: 9 };
  }
  function fatalRemote({ mismatch }) {
    // Status is a member of `fields` here (not merely the separate
    // `statusField` alias) — mirrors readBootstrapRemoteState's real shape,
    // where `statusField` is derived by finding Status inside `fields`, and
    // is what plan 06-01's planViews resolves its visibleFieldNames against.
    const statusField = { id: 'F_status', name: 'Status', dataType: 'SINGLE_SELECT', options: [opt('id-todo', 'Todo', 'GRAY', '')] };
    const fields = [
      { id: 'F_id', name: 'GSD ID', dataType: 'TEXT', options: null },
      // Phase intentionally missing -> planFields would create it.
      { id: 'F_req', name: 'Requirements', dataType: 'TEXT', options: null },
      { id: 'F_wave', name: 'Wave', dataType: mismatch ? 'TEXT' : 'NUMBER', options: null },
      { id: 'F_auto', name: 'Autonomous', dataType: 'SINGLE_SELECT', options: [opt('id-yes', 'Yes', 'GREEN', ''), opt('id-no', 'No', 'RED', '')] },
      statusField,
    ];
    return {
      available: true, projectOutcome: 'resolved',
      repository: { nodeId: 'R_1', ownerNodeId: 'O_1', ownerLogin: 'octo', linkState: 'linked' },
      projectNodeId: 'PVT_adopted', fields,
      statusField,
    };
  }

  test('a wrong-typed field suppresses the entire run: zero operations and zero checkpoints in the structure pass and the options pass', () => {
    const remote = fatalRemote({ mismatch: true });
    const structurePlan = planBootstrap({ desired: { available: true }, remote, strictMap: { kind: 'absent' }, target: fatalTarget() }, { pass: BOOTSTRAP_PASS.STRUCTURE });
    assert.equal(structurePlan.operations.length, 0);
    assert.equal(structurePlan.checkpoints.length, 0);
    assert.equal(structurePlan.blocked.length, 1);
    assert.equal(structurePlan.blocked[0].reason, BOOTSTRAP_OPERATION_REASON.FIELD_TYPE_MISMATCH);

    const optionsPlan = planBootstrap({ desired: { available: true }, remote, strictMap: { kind: 'absent' }, target: fatalTarget() }, { pass: BOOTSTRAP_PASS.OPTIONS });
    assert.equal(optionsPlan.operations.length, 0);
    assert.equal(optionsPlan.checkpoints.length, 0);
    assert.equal(optionsPlan.blocked.length, 1);
    assert.equal(optionsPlan.blocked[0].reason, BOOTSTRAP_OPERATION_REASON.FIELD_TYPE_MISMATCH);
  });

  test('negative control: the identical input WITHOUT the wrong-typed field produces a non-empty operation list in both passes', () => {
    const remote = fatalRemote({ mismatch: false });
    const structurePlan = planBootstrap({ desired: { available: true }, remote, strictMap: { kind: 'absent' }, target: fatalTarget() }, { pass: BOOTSTRAP_PASS.STRUCTURE });
    assert.ok(structurePlan.operations.length > 0, 'structure pass must plan the missing Phase field');
    assert.equal(structurePlan.blocked.length, 0);

    const optionsPlan = planBootstrap({ desired: { available: true }, remote, strictMap: { kind: 'absent' }, target: fatalTarget() }, { pass: BOOTSTRAP_PASS.OPTIONS });
    assert.ok(optionsPlan.operations.length > 0, 'options pass must plan the missing Status option');
    assert.equal(optionsPlan.blocked.length, 0);
  });

  // ── plan 03-05 Task 3: the run-fatal criterion plan 03-04 could not carry ──
  // for the two stages that did not exist at wave 4. `fatalRemote` already
  // carries no `labels`/`milestones` (both default to empty via `?? []`), so
  // both stages would each emit a create absent the gate.

  test('the run-fatal gate now also suppresses labels and milestones (the two stages that did not exist at plan 03-04\'s wave): zero label and zero milestone operations, and zero checkpoints from either stage', () => {
    const desiredWithMilestone = {
      available: true,
      milestones: [{ version: 'v1.0', name: 'current', title: 'v1.0 — current', description: '', archived: false }],
    };
    const remote = fatalRemote({ mismatch: true });
    const structurePlan = planBootstrap({ desired: desiredWithMilestone, remote, strictMap: { kind: 'absent' }, target: fatalTarget() }, { pass: BOOTSTRAP_PASS.STRUCTURE });
    assert.equal(structurePlan.operations.filter((o) => o.stage === BOOTSTRAP_STAGE.LABELS).length, 0);
    assert.equal(structurePlan.operations.filter((o) => o.stage === BOOTSTRAP_STAGE.MILESTONES).length, 0);
    assert.equal(structurePlan.operations.length, 0);
    assert.equal(structurePlan.checkpoints.length, 0);
  });

  test('the identical input without the wrong-typed field emits both the label and the milestone stage\'s creates', () => {
    const desiredWithMilestone = {
      available: true,
      milestones: [{ version: 'v1.0', name: 'current', title: 'v1.0 — current', description: '', archived: false }],
    };
    const remote = fatalRemote({ mismatch: false });
    const structurePlan = planBootstrap({ desired: desiredWithMilestone, remote, strictMap: { kind: 'absent' }, target: fatalTarget() }, { pass: BOOTSTRAP_PASS.STRUCTURE });
    assert.ok(structurePlan.operations.some((o) => o.stage === BOOTSTRAP_STAGE.LABELS), 'the label stage must plan a create');
    assert.ok(structurePlan.operations.some((o) => o.stage === BOOTSTRAP_STAGE.MILESTONES), 'the milestone stage must plan a create');
  });
});

// ─── planBootstrap options pass wiring: planAutonomousOptions (plan 03-04 Task 3) ──

describe('planBootstrap options pass wiring', () => {
  const target = { owner: 'octo', repo: 'repo', repositoryNumber: 1, projectNumber: 7 };

  test('the options pass runs planStatusOptionMerge then planAutonomousOptions: both divergent inputs produce two operations, Status first', () => {
    const remote = {
      available: true, projectOutcome: 'resolved',
      statusField: statusField([opt('id-todo', 'Todo', 'GRAY', '')]),
      fields: [{ id: 'F_auto', name: 'Autonomous', dataType: 'SINGLE_SELECT', options: [opt('id-yes', 'Yes', 'GREEN', ''), opt('id-extra', 'Extra', 'PURPLE', '')] }],
    };
    const plan = planBootstrap({ desired: { available: true }, remote, strictMap: { kind: 'absent' }, target }, { pass: BOOTSTRAP_PASS.OPTIONS });
    assert.equal(plan.operations.length, 2);
    assert.equal(plan.operations[0].logicalKey, BOOTSTRAP_LOGICAL_KEY.field(STATUS_FIELD_NAME));
    assert.equal(plan.operations[1].logicalKey, BOOTSTRAP_LOGICAL_KEY.field('Autonomous'));
  });

  test('Autonomous absent from the snapshot: the options pass still plans the Status merge alone', () => {
    const remote = { available: true, projectOutcome: 'resolved', statusField: statusField([opt('id-todo', 'Todo', 'GRAY', '')]), fields: [] };
    const plan = planBootstrap({ desired: { available: true }, remote, strictMap: { kind: 'absent' }, target }, { pass: BOOTSTRAP_PASS.OPTIONS });
    assert.equal(plan.operations.length, 1);
    assert.equal(plan.operations[0].logicalKey, BOOTSTRAP_LOGICAL_KEY.field(STATUS_FIELD_NAME));
  });
});

describe('planBootstrap options pass: views wiring (plan 06-01)', () => {
  const target = { owner: 'octo', repo: 'repo', repositoryNumber: 1, projectNumber: 7 };

  test('merge.kind noop (unset project): the views stage contributes nothing yet — mirrors planStatusOptionMerge/planAutonomousOptions\' own "field/project genuinely does not exist yet" no-op, never a premature create', () => {
    const remote = {
      available: true, projectOutcome: 'unset', statusField: null,
      fields: [{ id: 'PVTSSF_status', name: 'Status', dataType: 'SINGLE_SELECT', options: [] }],
      views: [],
    };
    const plan = planBootstrap({ desired: { available: true }, remote, strictMap: { kind: 'absent' }, target }, { pass: BOOTSTRAP_PASS.OPTIONS });
    const viewOps = plan.operations.filter((o) => o.logicalKey === BOOTSTRAP_LOGICAL_KEY.view('Backlog'));
    assert.equal(viewOps.length, 0);
    assert.equal(plan.blocked.length, 0);
  });

  test('merge.kind operation (resolved project, Status divergent so the merge dispatches, a resolvable Status field): the views create+update operations fold in after autonomous', () => {
    const remote = {
      available: true, projectOutcome: 'resolved', statusField: statusField([]),
      fields: [{ id: 'PVTSSF_status', name: 'Status', dataType: 'SINGLE_SELECT', options: [] }],
      views: [],
    };
    const plan = planBootstrap({ desired: { available: true }, remote, strictMap: { kind: 'absent' }, target }, { pass: BOOTSTRAP_PASS.OPTIONS });
    const viewOps = plan.operations.filter((o) => o.logicalKey === BOOTSTRAP_LOGICAL_KEY.view('Backlog'));
    assert.equal(viewOps.length, 2);
    assert.equal(viewOps[0].kind, 'create-view');
    assert.equal(viewOps[1].kind, 'update-view');
  });

  test('merge.kind converged, remote already carries a converged Backlog view: the views stage folds in one checkpoint, zero operations', () => {
    const remote = {
      available: true, projectOutcome: 'resolved',
      statusField: statusField([opt('id-todo', 'Todo', 'GRAY', ''), opt('id-inprogress', 'In Progress', 'BLUE', ''), opt('id-blocked', 'Blocked', 'RED', ''), opt('id-done', 'Done', 'GREEN', ''), opt('id-deferred', 'Deferred', 'YELLOW', '')]),
      fields: [{ id: 'PVTSSF_status', name: 'Status', dataType: 'SINGLE_SELECT', options: [] }],
      views: [{ id: 'PVTV_1', name: 'Backlog', layout: 'TABLE_LAYOUT', filter: '-status:Done' }],
    };
    const plan = planBootstrap({ desired: { available: true }, remote, strictMap: { kind: 'absent' }, target }, { pass: BOOTSTRAP_PASS.OPTIONS });
    assert.equal(plan.operations.filter((o) => o.logicalKey === BOOTSTRAP_LOGICAL_KEY.view('Backlog')).length, 0);
    assert.ok(plan.checkpoints.some((c) => c.logicalKey === BOOTSTRAP_LOGICAL_KEY.view('Backlog') && c.nodeId === 'PVTV_1'));
  });

  test('a view whose declared field is unresolved contributes a blocked entry to the composed plan (Status merge itself dispatches fine; only the fields snapshot planViews reads from lacks Status)', () => {
    // statusField (planStatusOptionMerge's own input) is present and
    // divergent, so the merge dispatches an operation rather than blocking —
    // isolating planViews' own VIEW_FIELD_UNRESOLVED contribution from
    // planStatusOptionMerge's independent MISSING_STATUS_FIELD block.
    const remote = { available: true, projectOutcome: 'resolved', statusField: statusField([]), fields: [], views: [] };
    const plan = planBootstrap({ desired: { available: true }, remote, strictMap: { kind: 'absent' }, target }, { pass: BOOTSTRAP_PASS.OPTIONS });
    assert.ok(plan.blocked.some((b) => b.reason === BOOTSTRAP_OPERATION_REASON.VIEW_FIELD_UNRESOLVED));
  });
});

// ─── planBootstrap options pass: autonomous checkpoints on every merge.kind ──
// branch (plan 05-04 Task 1, closing 05-RESEARCH.md Pitfall 1) ──────────────

describe('planBootstrap options pass: autonomous checkpoints thread through every merge.kind branch', () => {
  const target = { owner: 'octo', repo: 'repo', repositoryNumber: 1, projectNumber: 7 };

  test('merge.kind noop (unset project): the options pass still surfaces the two autonomous checkpoints (converged Autonomous field, independent of Status)', () => {
    const remote = {
      available: true, projectOutcome: 'unset', statusField: null,
      fields: [{ id: 'F_auto', name: 'Autonomous', dataType: 'SINGLE_SELECT', options: [opt('id-yes', 'Yes', 'GREEN', ''), opt('id-no', 'No', 'RED', '')] }],
    };
    const plan = planBootstrap({ desired: { available: true }, remote, strictMap: { kind: 'absent' }, target }, { pass: BOOTSTRAP_PASS.OPTIONS });
    assert.equal(plan.noops[0].reason, BOOTSTRAP_OPERATION_REASON.PROJECT_UNSET);
    assert.equal(plan.checkpoints.length, 2);
    assert.deepEqual(plan.checkpoints.map((c) => c.logicalKey).sort(), [BOOTSTRAP_LOGICAL_KEY.autonomousOption('No'), BOOTSTRAP_LOGICAL_KEY.autonomousOption('Yes')].sort());
  });

  test('merge.kind converged (Status also fully converged): the Status checkpoints and the autonomous checkpoints both surface, seven total', () => {
    const remote = {
      available: true, projectOutcome: 'resolved',
      statusField: statusField([opt('id-todo', 'Todo', 'GRAY', ''), opt('id-inprogress', 'In Progress', 'BLUE', ''), opt('id-blocked', 'Blocked', 'RED', ''), opt('id-done', 'Done', 'GREEN', ''), opt('id-deferred', 'Deferred', 'YELLOW', '')]),
      fields: [{ id: 'F_auto', name: 'Autonomous', dataType: 'SINGLE_SELECT', options: [opt('id-yes', 'Yes', 'GREEN', ''), opt('id-no', 'No', 'RED', '')] }],
    };
    const plan = planBootstrap({ desired: { available: true }, remote, strictMap: { kind: 'absent' }, target }, { pass: BOOTSTRAP_PASS.OPTIONS });
    assert.equal(plan.operations.length, 0);
    assert.equal(plan.checkpoints.length, 7);
    assert.ok(plan.checkpoints.some((c) => c.logicalKey === BOOTSTRAP_LOGICAL_KEY.autonomousOption('Yes')));
    assert.ok(plan.checkpoints.some((c) => c.logicalKey === BOOTSTRAP_LOGICAL_KEY.autonomousOption('No')));
    assert.ok(plan.checkpoints.some((c) => c.logicalKey === BOOTSTRAP_LOGICAL_KEY.statusOption('Todo')));
  });

  test('merge.kind operation (Status divergent, Autonomous independently converged): the Status write dispatches and the two autonomous checkpoints still surface — checkpoints are not exclusively a converged-branch concept', () => {
    const remote = {
      available: true, projectOutcome: 'resolved',
      statusField: statusField([opt('id-todo', 'Todo', 'GRAY', '')]), // missing four GSD options -> divergent -> operation branch
      fields: [{ id: 'F_auto', name: 'Autonomous', dataType: 'SINGLE_SELECT', options: [opt('id-yes', 'Yes', 'GREEN', ''), opt('id-no', 'No', 'RED', '')] }], // exactly Yes/No -> converged
    };
    const plan = planBootstrap({ desired: { available: true }, remote, strictMap: { kind: 'absent' }, target }, { pass: BOOTSTRAP_PASS.OPTIONS });
    assert.equal(plan.operations.length, 1);
    assert.equal(plan.operations[0].logicalKey, BOOTSTRAP_LOGICAL_KEY.field(STATUS_FIELD_NAME));
    assert.equal(plan.checkpoints.length, 2);
    assert.ok(plan.checkpoints.every((c) => c.logicalKey.startsWith('option:autonomous:')));
  });
});

// ─── differential parity: the local mutation documents match the ones ──────
// registered in github-sync-bootstrap-remote.cts's BOOTSTRAP_DOCUMENTS (cycle
// 2 actionable non-HIGH #2's parity principle, applied to the two mutation
// documents this task adds — duplicated rather than imported to preserve
// this module's zero-I/O-import architecture, per the note at their
// declaration).

describe('mutation document parity with github-sync-bootstrap-remote.cts', () => {
  test('CREATE_PROJECT_DOCUMENT is byte-identical to BOOTSTRAP_DOCUMENTS.createProject', () => {
    assert.equal(CREATE_PROJECT_DOCUMENT, bootstrapRemote.BOOTSTRAP_DOCUMENTS.createProject);
  });

  test('LINK_PROJECT_DOCUMENT is byte-identical to BOOTSTRAP_DOCUMENTS.linkProjectToRepository', () => {
    assert.equal(LINK_PROJECT_DOCUMENT, bootstrapRemote.BOOTSTRAP_DOCUMENTS.linkProjectToRepository);
  });

  test('CREATE_FIELD_TEXT_DOCUMENT is byte-identical to BOOTSTRAP_DOCUMENTS.createFieldText', () => {
    assert.equal(CREATE_FIELD_TEXT_DOCUMENT, bootstrapRemote.BOOTSTRAP_DOCUMENTS.createFieldText);
  });

  test('CREATE_FIELD_NUMBER_DOCUMENT is byte-identical to BOOTSTRAP_DOCUMENTS.createFieldNumber', () => {
    assert.equal(CREATE_FIELD_NUMBER_DOCUMENT, bootstrapRemote.BOOTSTRAP_DOCUMENTS.createFieldNumber);
  });

  test('CREATE_FIELD_SINGLE_SELECT_DOCUMENT is byte-identical to BOOTSTRAP_DOCUMENTS.createFieldSingleSelect', () => {
    assert.equal(CREATE_FIELD_SINGLE_SELECT_DOCUMENT, bootstrapRemote.BOOTSTRAP_DOCUMENTS.createFieldSingleSelect);
  });

  test('RENAME_FIELD_DOCUMENT is byte-identical to BOOTSTRAP_DOCUMENTS.renameField', () => {
    assert.equal(RENAME_FIELD_DOCUMENT, bootstrapRemote.BOOTSTRAP_DOCUMENTS.renameField);
  });

  test('neither mutation document selects a rateLimit field (live-verified in plan 03-02: Mutation has no such field)', () => {
    assert.doesNotMatch(CREATE_PROJECT_DOCUMENT, /rateLimit/);
    assert.doesNotMatch(LINK_PROJECT_DOCUMENT, /rateLimit/);
    assert.doesNotMatch(CREATE_FIELD_TEXT_DOCUMENT, /rateLimit/);
    assert.doesNotMatch(CREATE_FIELD_NUMBER_DOCUMENT, /rateLimit/);
    assert.doesNotMatch(CREATE_FIELD_SINGLE_SELECT_DOCUMENT, /rateLimit/);
    assert.doesNotMatch(RENAME_FIELD_DOCUMENT, /rateLimit/);
  });
});

// ─── bootstrap-fields.json fixture (plan 03-04 Task 1 option-a: live capture ──
// against board #10, 2026-08-02)

describe('bootstrap-fields.json fixture', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/github-sync/bootstrap-fields.json'), 'utf8'));

  test('the live-captured mismatch response decodes to a TEXT dataType for a field named Wave — the exact shape planFields diagnoses', () => {
    const node = fixture.mismatchResponse.data.createProjectV2Field.projectV2Field;
    assert.equal(node.name, 'Wave');
    assert.equal(node.dataType, 'TEXT');
  });

  test('the mismatch response decodes through the real decodeCompletions with a create-field operation shape', () => {
    const operation = { captures: [{ kind: 'node', logicalKey: BOOTSTRAP_LOGICAL_KEY.field('Wave'), nodeIdPath: 'createProjectV2Field.projectV2Field.id' }] };
    const decoded = decodeCompletions(operation, fixture.mismatchResponse.data, '2026-01-01T00:00:00.000Z');
    assert.equal(decoded[0].nodeId, fixture.mismatchResponse.data.createProjectV2Field.projectV2Field.id);
  });

  test('the (derived) create response decodes through the real decodeCompletions with a create-field operation shape', () => {
    const operation = { captures: [{ kind: 'node', logicalKey: BOOTSTRAP_LOGICAL_KEY.field('GSD ID'), nodeIdPath: 'createProjectV2Field.projectV2Field.id' }] };
    const decoded = decodeCompletions(operation, fixture.createResponse.data, '2026-01-01T00:00:00.000Z');
    assert.equal(decoded[0].nodeId, fixture.createResponse.data.createProjectV2Field.projectV2Field.id);
  });

  test('the (derived) rename response decodes through the real decodeCompletions with a rename-field operation shape', () => {
    const operation = { captures: [{ kind: 'node', logicalKey: BOOTSTRAP_LOGICAL_KEY.field('GSD ID'), nodeIdPath: 'updateProjectV2Field.projectV2Field.id' }] };
    const decoded = decodeCompletions(operation, fixture.renameResponse.data, '2026-01-01T00:00:00.000Z');
    assert.equal(decoded[0].nodeId, fixture.renameResponse.data.updateProjectV2Field.projectV2Field.id);
  });

  test('provenance names board #10, the capture date, and the gh version, and states plainly which bodies are derived', () => {
    assert.match(fixture.provenance, /#10/);
    assert.match(fixture.provenance, /2026-08-02/);
    assert.match(fixture.provenance, /2\.96\.0/);
    assert.match(fixture.provenance, /DERIVED/);
  });
});
