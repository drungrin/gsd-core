'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  planBootstrap,
  planProject,
  planStatusOptionMerge,
  optionInputArgv,
  BOOTSTRAP_LOGICAL_KEY,
  BOOTSTRAP_OPERATION_REASON,
  BOOTSTRAP_PASS,
  GSD_STATUS_OPTIONS,
  STATUS_FIELD_NAME,
  DEFAULT_PROJECT_TITLE_SUFFIX,
  CREATE_PROJECT_DOCUMENT,
  LINK_PROJECT_DOCUMENT,
} = require('../gsd-core/bin/lib/github-sync-bootstrap-plan.cjs');
const { applyMutationPlan } = require('../gsd-core/bin/lib/github-sync-apply.cjs');
const { resolveArgv } = require('../gsd-core/bin/lib/github-sync-operation.cjs');
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

// ─── planBootstrap wiring: planProject drives the structure pass ──────────

describe('planBootstrap structure pass wiring (plan 03-03)', () => {
  const target = { owner: 'octo', repo: 'gsd-core', repositoryNumber: 1, projectNumber: null };

  test('an unset project number produces the create-and-link structure plan', () => {
    const plan = planBootstrap({
      desired: { available: true },
      remote: projectRemote(),
      strictMap: { kind: 'absent' },
      target,
    }, { pass: BOOTSTRAP_PASS.STRUCTURE });
    assert.equal(plan.operations.length, 2);
    assert.equal(plan.blocked.length, 0);
  });

  test('when planProject blocks, the structure pass reports zero operations and zero checkpoints', () => {
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

  test('neither mutation document selects a rateLimit field (live-verified in plan 03-02: Mutation has no such field)', () => {
    assert.doesNotMatch(CREATE_PROJECT_DOCUMENT, /rateLimit/);
    assert.doesNotMatch(LINK_PROJECT_DOCUMENT, /rateLimit/);
  });
});
