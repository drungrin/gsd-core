'use strict';

/**
 * End-to-end proof of BOOT-07: a second `init` plans zero operations across
 * every stage of both passes, and a first `init` against a fully populated
 * board with no map still records everything without mutating anything.
 *
 * Modeled on tests/github-sync-composition.test.cjs: real `applyMutationPlan`,
 * real `readSyncMapStrict`/`recordCompletion`/`writeSyncMapAtomically` against
 * a temp directory, and an injected `execGh` seam replaying canned responses
 * rather than spawning anything.
 *
 * This suite drives the two-pass sequence (structure pass -> apply ->
 * conditional re-read -> options pass -> apply) DIRECTLY, calling
 * `planBootstrap`/`applyMutationPlan` itself rather than the router. That is
 * a deliberate scope limit, not an oversight: it proves the *modelled*
 * sequence converges and threads its map correctly, but it cannot prove the
 * **router** does the same thing — a handler that forgot to thread the map
 * would not be caught here. That router-level gate lives in plan 03-02's
 * `tests/github-sync-command-router.test.cjs` cases (the HIGH-1 map-threading
 * tests already living there).
 *
 * A stateful `World` model stands in for the live GitHub board: the injected
 * `execGh` both answers each dispatched operation AND records its effect on
 * the board, so a later "re-read" is genuinely derived from what earlier
 * operations created — never a second hand-authored literal.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup } = require('./helpers.cjs');
const { makeFakeClock } = require('./helpers/clock.cjs');
const {
  planBootstrap,
  BOOTSTRAP_LOGICAL_KEY,
  BOOTSTRAP_OPERATION_REASON,
  BOOTSTRAP_PASS,
  BOOTSTRAP_STAGE,
  GSD_FIELDS,
  GSD_LABELS,
} = require('../gsd-core/bin/lib/github-sync-bootstrap-plan.cjs');
const { applyMutationPlan } = require('../gsd-core/bin/lib/github-sync-apply.cjs');
const { mutatedKeys } = require('../gsd-core/bin/lib/github-sync-operation.cjs');
const bootstrapRemoteMod = require('../gsd-core/bin/lib/github-sync-bootstrap-remote.cjs');
const bootstrapConfigMod = require('../gsd-core/bin/lib/github-sync-bootstrap-config.cjs');
const {
  readSyncMapStrict,
  recordCompletion,
  writeSyncMapAtomically,
  SYNC_MAP_FILE_NAME,
} = require('../gsd-core/bin/lib/github-sync-map.cjs');

// ─── shared response helpers ────────────────────────────────────────────────

function graphqlOk(dataObj) {
  return { exitCode: 0, reason: 'ok', stdout: JSON.stringify({ data: dataObj }), stderr: '' };
}
function restOk(bodyObj) {
  return { exitCode: 0, reason: 'ok', stdout: JSON.stringify(bodyObj), stderr: '' };
}
function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function argValue(args, prefix) {
  for (const entry of args) {
    if (typeof entry === 'string' && entry.startsWith(prefix)) return entry.slice(prefix.length);
  }
  return undefined;
}
function parseOptionArgv(args) {
  const options = [];
  let current = null;
  for (let i = 0; i + 1 < args.length; i += 1) {
    if (args[i] !== '-f') continue;
    const raw = args[i + 1];
    if (typeof raw !== 'string') continue;
    if (raw.startsWith('options[][name]=')) {
      current = { name: raw.slice('options[][name]='.length) };
      options.push(current);
    } else if (raw.startsWith('options[][id]=') && current) {
      current.id = raw.slice('options[][id]='.length);
    }
  }
  return options;
}

function fixedClock() {
  const clock = makeFakeClock(Date.parse('2026-08-01T00:00:00.000Z'));
  clock.nowIso = () => '2026-08-01T00:00:00.000Z';
  return clock;
}

// ─── the World model: a stateful stand-in for the live board ───────────────

function createWorld({ owner, repo, ownerNodeId = 'O_owner_1', repoNodeId = 'R_repo_1' }) {
  return {
    owner, repo, ownerNodeId, repoNodeId,
    project: null,
    linked: false,
    fields: [],
    labels: [],
    milestones: [],
    calls: [],
  };
}

/**
 * Answers every operation this phase's builders can dispatch AND records the
 * effect on `world`, so a later re-read (`remoteFromWorld`) reflects exactly
 * what earlier operations confirmed — never a second hand-authored literal
 * (the plan's own instruction for this suite).
 */
function worldExecGh(world) {
  return function execGh(args) {
    world.calls.push(args);
    const seq = world.calls.length;
    const queryArg = args.find((a) => typeof a === 'string' && a.startsWith('query='));
    if (queryArg) {
      if (queryArg.includes('github-sync-bootstrap:createProject')) {
        const title = argValue(args, 'title=');
        world.project = { id: `PVT_${slugify(world.repo)}_${seq}`, number: 900 + seq, title };
        // GitHub seeds every new board with a built-in Status field carrying
        // Todo/In Progress/Done — modeled here so the options pass has a
        // real bare Status field to merge against, exactly as D-16 assumes.
        world.fields.push({
          id: `PVTF_status_${seq}`,
          name: 'Status',
          dataType: 'SINGLE_SELECT',
          options: [
            { id: `OPT_todo_${seq}`, name: 'Todo', color: 'GRAY', description: '' },
            { id: `OPT_inprogress_${seq}`, name: 'In Progress', color: 'BLUE', description: '' },
            { id: `OPT_done_${seq}`, name: 'Done', color: 'GREEN', description: '' },
          ],
        });
        return graphqlOk({ createProjectV2: { projectV2: { id: world.project.id, number: world.project.number } } });
      }
      if (queryArg.includes('github-sync-bootstrap:linkProjectToRepository')) {
        world.linked = true;
        return graphqlOk({ linkProjectV2ToRepository: { repository: { id: world.repoNodeId } } });
      }
      if (queryArg.includes('github-sync-bootstrap:createFieldText') ||
          queryArg.includes('github-sync-bootstrap:createFieldNumber') ||
          queryArg.includes('github-sync-bootstrap:createFieldSingleSelect')) {
        const name = argValue(args, 'name=');
        const dataType = queryArg.includes('createFieldText')
          ? 'TEXT'
          : (queryArg.includes('createFieldNumber') ? 'NUMBER' : 'SINGLE_SELECT');
        const options = dataType === 'SINGLE_SELECT'
          ? parseOptionArgv(args).map((o, i) => ({ id: o.id ?? `OPT_${slugify(name)}_${i}_${seq}`, name: o.name, color: 'GREEN', description: '' }))
          : null;
        const fieldNode = { id: `PVTF_${slugify(name)}_${seq}`, name, dataType, options };
        world.fields.push(fieldNode);
        return graphqlOk({ createProjectV2Field: { projectV2Field: { id: fieldNode.id, name, dataType } } });
      }
      if (queryArg.includes('github-sync-bootstrap:renameField')) {
        const fieldId = argValue(args, 'fieldId=');
        const name = argValue(args, 'name=');
        const fieldNode = world.fields.find((f) => f.id === fieldId);
        if (fieldNode) fieldNode.name = name;
        return graphqlOk({ updateProjectV2Field: { projectV2Field: { id: fieldId, name, dataType: fieldNode ? fieldNode.dataType : 'TEXT' } } });
      }
      if (queryArg.includes('github-sync-bootstrap:updateSingleSelectOptions')) {
        const fieldId = argValue(args, 'fieldId=');
        const parsed = parseOptionArgv(args);
        const merged = parsed.map((o, i) => ({ id: o.id ?? `OPT_${slugify(o.name)}_${i}_${seq}`, name: o.name, color: 'GREEN', description: '' }));
        const fieldNode = world.fields.find((f) => f.id === fieldId);
        if (fieldNode) fieldNode.options = merged;
        return graphqlOk({ updateProjectV2Field: { projectV2Field: { id: fieldId, options: merged } } });
      }
      throw new Error(`worldExecGh: unrecognized query in test fixture: ${queryArg}`);
    }
    if (args[0] === 'api' && typeof args[1] === 'string') {
      const restApiPath = args[1];
      if (restApiPath.endsWith('/labels') && args.includes('POST')) {
        const name = argValue(args, 'name=');
        const nodeId = `L_${slugify(name)}_${seq}`;
        world.labels.push({ nodeId, name });
        return restOk({ node_id: nodeId, name });
      }
      if (restApiPath.endsWith('/milestones') && args.includes('POST')) {
        const title = argValue(args, 'title=');
        const stateArg = argValue(args, 'state=');
        const nodeId = `M_${slugify(title)}_${seq}`;
        const number = 500 + seq;
        world.milestones.push({ nodeId, name: title, number, state: stateArg });
        return restOk({ node_id: nodeId, number });
      }
    }
    throw new Error(`worldExecGh: unrecognized call in test fixture: ${JSON.stringify(args)}`);
  };
}

/** Wraps `worldExecGh` so a test can fail on the Nth dispatched operation. */
function worldExecGhFailingAt(world, failAtCall) {
  const base = worldExecGh(world);
  let count = 0;
  return function execGh(args) {
    count += 1;
    if (count === failAtCall) {
      world.calls.push(args);
      return { exitCode: 1, reason: 'gh_exit_nonzero', stdout: '', stderr: 'simulated failure' };
    }
    return base(args);
  };
}

/** Wraps `worldExecGh` so the Nth REST create call returns the recorded already-exists 422 shape instead of succeeding. */
function worldExecGhAlreadyExistsAt(world, failAtCall) {
  const base = worldExecGh(world);
  let count = 0;
  return function execGh(args) {
    count += 1;
    if (count === failAtCall) {
      world.calls.push(args);
      const resource = args[1] && args[1].endsWith('/labels') ? 'Label' : 'Milestone';
      return {
        exitCode: 1,
        reason: 'gh_exit_nonzero',
        stdout: JSON.stringify({ message: 'Validation Failed', errors: [{ resource, code: 'already_exists', field: 'name' }] }),
        stderr: '',
        response: { available: true, status: 422, retry_after_seconds: null },
      };
    }
    return base(args);
  };
}

/** A spy execGh that throws on any call — asserts zero dispatches. */
function forbiddenExecGh() {
  return () => { throw new Error('this run must dispatch zero execGh calls'); };
}

function remoteFromWorld(world, projectNumber) {
  const repository = {
    nodeId: world.repoNodeId,
    ownerNodeId: world.ownerNodeId,
    ownerLogin: world.owner,
    linkState: projectNumber === null ? null : (world.linked ? 'linked' : 'unlinked'),
  };
  const labels = world.labels.map((l) => ({ nodeId: l.nodeId, name: l.name }));
  const milestones = world.milestones.map((m) => ({ nodeId: m.nodeId, name: m.name, number: m.number, state: m.state }));
  if (projectNumber === null) {
    return { available: true, projectOutcome: 'unset', repository, projectNodeId: null, fields: [], statusField: null, labels, milestones };
  }
  if (!world.project || world.project.number !== projectNumber) {
    return { available: true, projectOutcome: 'absent', repository, projectNodeId: null, fields: [], statusField: null, labels, milestones };
  }
  const fields = world.fields.map((f) => ({ id: f.id, name: f.name, dataType: f.dataType, options: f.options }));
  const statusField = fields.find((f) => f.name === 'Status') ?? null;
  return { available: true, projectOutcome: 'resolved', repository, projectNodeId: world.project.id, fields, statusField, labels, milestones };
}

function repositoryIdentity(target) {
  return { owner: target.owner, repo: target.repo, number: target.repositoryNumber };
}

/**
 * Mirrors the router's `init` handler algorithm exactly (structure pass ->
 * apply -> conditional re-read on `mutatedKeys` -> options pass -> apply),
 * driving `planBootstrap`/`applyMutationPlan` directly so a convergence
 * failure names the stage, not the command.
 */
function runInitRound({ cwd, desired, world, target, projectTitle = null, execGh }) {
  const repository = repositoryIdentity(target);
  const strictMapBefore = readSyncMapStrict(cwd, repository);
  const remoteBefore = remoteFromWorld(world, target.projectNumber);
  let readCount = 1;

  const structurePlan = planBootstrap(
    { desired, remote: remoteBefore, strictMap: strictMapBefore, target, projectTitle },
    { pass: BOOTSTRAP_PASS.STRUCTURE },
  );
  if (structurePlan.blocked.length > 0 || structurePlan.uncertain.length > 0) {
    return { readCount, structurePlan, structureApply: null, remoteBefore };
  }
  const structureApply = applyMutationPlan(structurePlan, {
    cwd,
    map: strictMapBefore.kind === 'valid' ? strictMapBefore.map : null,
    clock: fixedClock(),
    execGh,
    recordCompletion,
    writeSyncMapAtomically,
  });
  if (structureApply.kind !== 'completed') {
    return { readCount, structurePlan, structureApply, remoteBefore };
  }

  const mutated = mutatedKeys(structureApply.outcomes ?? []);
  const projectMutated = mutated.includes(BOOTSTRAP_LOGICAL_KEY.project());
  const fieldMutated = mutated.some((key) => key.startsWith('field:'));
  const effectiveProjectNumber = projectMutated
    ? structureApply.map?.completions?.project?.issueNumber ?? target.projectNumber
    : target.projectNumber;

  let optionsRemote = remoteBefore;
  let reRead = false;
  if (projectMutated || fieldMutated) {
    reRead = true;
    readCount += 1;
    optionsRemote = remoteFromWorld(world, effectiveProjectNumber);
  }

  const optionsStrictMap = structureApply.map ? { kind: 'valid', map: structureApply.map } : { kind: 'absent' };
  const effectiveTarget = { ...target, projectNumber: effectiveProjectNumber };
  const optionsPlan = planBootstrap(
    { desired, remote: optionsRemote, strictMap: optionsStrictMap, target: effectiveTarget, projectTitle },
    { pass: BOOTSTRAP_PASS.OPTIONS },
  );
  if (optionsPlan.blocked.length > 0 || optionsPlan.uncertain.length > 0) {
    return { readCount, structurePlan, structureApply, optionsPlan, optionsApply: null, reRead, mutated, effectiveProjectNumber, remoteBefore, optionsRemote };
  }
  const optionsApply = applyMutationPlan(optionsPlan, {
    cwd,
    map: structureApply.map ?? null,
    clock: fixedClock(),
    execGh,
    recordCompletion,
    writeSyncMapAtomically,
  });
  return { readCount, structurePlan, structureApply, optionsPlan, optionsApply, reRead, mutated, effectiveProjectNumber, remoteBefore, optionsRemote };
}

// ─── fixtures ────────────────────────────────────────────────────────────

function desiredFixture() {
  return {
    available: true,
    milestones: [
      { version: 'v0.9', name: 'archived', title: 'v0.9 — archived', description: 'the previous milestone', archived: true },
      { version: 'v1.0', name: 'current', title: 'v1.0 — current', description: 'the current milestone', archived: false },
    ],
  };
}

function freshTarget() {
  return { owner: 'octo', repo: 'roadmap', repositoryNumber: 42, projectNumber: null };
}

function syncMapPath(cwd) {
  return path.join(cwd, '.planning', SYNC_MAP_FILE_NAME);
}

// ─── Fresh-board sequence ───────────────────────────────────────────────

describe('fresh-board sequence', () => {
  test('run 1 structure pass creates project, link, five fields, two labels, two milestones, in order, and zero option operations', (t) => {
    const cwd = createTempProject('bootstrap-composition-fresh-');
    t.after(() => cleanup(cwd));
    const world = createWorld({ owner: 'octo', repo: 'roadmap' });
    const execGh = worldExecGh(world);

    const round1 = runInitRound({ cwd, desired: desiredFixture(), world, target: freshTarget(), execGh });

    assert.deepEqual(round1.structurePlan.operations.map((o) => o.logicalKey), [
      BOOTSTRAP_LOGICAL_KEY.project(),
      BOOTSTRAP_LOGICAL_KEY.projectLink(),
      ...GSD_FIELDS.map((f) => BOOTSTRAP_LOGICAL_KEY.field(f.name)),
      ...GSD_LABELS.map((l) => BOOTSTRAP_LOGICAL_KEY.label(l.name)),
      BOOTSTRAP_LOGICAL_KEY.milestone('v0.9'),
      BOOTSTRAP_LOGICAL_KEY.milestone('v1.0'),
    ]);
    assert.equal(round1.structurePlan.operations.some((o) => o.logicalKey.startsWith('option:')), false);
    assert.equal(round1.structureApply.kind, 'completed');

    // The project and link completions live under two distinct logical
    // keys, each carrying a different node id.
    const projectCompletion = round1.structureApply.map.completions[BOOTSTRAP_LOGICAL_KEY.project()];
    const linkCompletion = round1.structureApply.map.completions[BOOTSTRAP_LOGICAL_KEY.projectLink()];
    assert.ok(projectCompletion);
    assert.ok(linkCompletion);
    assert.notEqual(projectCompletion.nodeId, linkCompletion.nodeId);

    // The link operation's argv resolved from the project completion the
    // create wrote moments earlier — proven by the world model recording the
    // link call only after `world.project` existed.
    assert.equal(world.linked, true);
  });

  test("run 1's fresh-create read carries a null project number and skips the project-scoped fields document (HIGH-4 gate)", () => {
    const calls = [];
    const execGh = (args) => {
      calls.push(args);
      const queryArg = args.find((a) => typeof a === 'string' && a.startsWith('query='));
      if (queryArg && queryArg.includes('github-sync-bootstrap:repository')) {
        return graphqlOk({ repository: { id: 'R_1', owner: { id: 'O_1', login: 'octo' }, projectsV2: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
      }
      if (args[0] === 'api' && typeof args[1] === 'string' && args[1].endsWith('/labels')) return restOk([]);
      if (args[0] === 'api' && typeof args[1] === 'string' && args[1].endsWith('/milestones')) return restOk([]);
      throw new Error(`unexpected call: ${JSON.stringify(args)}`);
    };
    const result = bootstrapRemoteMod.readBootstrapRemoteState({ cwd: process.cwd(), owner: 'octo', repo: 'roadmap', projectNumber: null, execGh });
    assert.equal(result.available, true);
    assert.equal(result.projectOutcome, 'unset');
    assert.deepEqual(result.fields, []);
    assert.equal(calls.some((args) => args.some((a) => typeof a === 'string' && a.includes('fieldsWithTypes'))), false);

    // The structure-pass plan built from this snapshot contains the project
    // create, not an unavailable/blocked read.
    const target = { owner: 'octo', repo: 'roadmap', repositoryNumber: 1, projectNumber: null };
    const structurePlan = planBootstrap(
      { desired: { available: true }, remote: result, strictMap: { kind: 'absent' }, target },
      { pass: BOOTSTRAP_PASS.STRUCTURE },
    );
    assert.equal(structurePlan.operations[0].logicalKey, BOOTSTRAP_LOGICAL_KEY.project());
    assert.equal(structurePlan.uncertain.length, 0);
    assert.equal(structurePlan.blocked.length, 0);
  });

  test("run 1's re-read boundary fires on the mutated project/field keys and carries the confirmed project number, not null", (t) => {
    const cwd = createTempProject('bootstrap-composition-reread-');
    t.after(() => cleanup(cwd));
    const world = createWorld({ owner: 'octo', repo: 'roadmap' });
    const execGh = worldExecGh(world);
    const round1 = runInitRound({ cwd, desired: desiredFixture(), world, target: freshTarget(), execGh });

    assert.ok(round1.mutated.includes(BOOTSTRAP_LOGICAL_KEY.project()));
    assert.ok(round1.mutated.some((k) => k.startsWith('field:')));
    assert.equal(round1.reRead, true);
    assert.equal(round1.readCount, 2);
    assert.equal(round1.effectiveProjectNumber, world.project.number);
    assert.notEqual(round1.effectiveProjectNumber, null);
  });

  test("run 1's map threading: after both applies, the file on disk carries the union of both passes' keys, and the options pass was handed the structure pass's returned map", (t) => {
    const cwd = createTempProject('bootstrap-composition-threading-');
    t.after(() => cleanup(cwd));
    const world = createWorld({ owner: 'octo', repo: 'roadmap' });
    const execGh = worldExecGh(world);
    const round1 = runInitRound({ cwd, desired: desiredFixture(), world, target: freshTarget(), execGh });

    assert.equal(round1.optionsApply.kind, 'completed');
    const onDisk = readSyncMapStrict(cwd, repositoryIdentity(freshTarget()));
    assert.equal(onDisk.kind, 'valid');
    const expectedKeys = [
      BOOTSTRAP_LOGICAL_KEY.project(),
      BOOTSTRAP_LOGICAL_KEY.projectLink(),
      ...GSD_FIELDS.map((f) => BOOTSTRAP_LOGICAL_KEY.field(f.name)),
      ...GSD_LABELS.map((l) => BOOTSTRAP_LOGICAL_KEY.label(l.name)),
      BOOTSTRAP_LOGICAL_KEY.milestone('v0.9'),
      BOOTSTRAP_LOGICAL_KEY.milestone('v1.0'),
      BOOTSTRAP_LOGICAL_KEY.statusOption('Todo'),
      BOOTSTRAP_LOGICAL_KEY.statusOption('In Progress'),
      BOOTSTRAP_LOGICAL_KEY.statusOption('Blocked'),
      BOOTSTRAP_LOGICAL_KEY.statusOption('Done'),
      BOOTSTRAP_LOGICAL_KEY.statusOption('Deferred'),
      // The freshly created Autonomous field already carries exactly
      // Yes/No (its own create call supplied both options), so the options
      // pass's re-read sees a converged field and records both option
      // completions — plan 05-04's fix (Phase 5 Pitfall 1).
      BOOTSTRAP_LOGICAL_KEY.autonomousOption('Yes'),
      BOOTSTRAP_LOGICAL_KEY.autonomousOption('No'),
    ];
    assert.deepEqual(Object.keys(onDisk.map.completions).sort(), expectedKeys.sort());

    // Every field-stage completion written this run traces to the structure
    // apply's returned map — a five-key file (structure pass keys only)
    // would fail the assertion above already, but this is the direct
    // "the options pass was handed the structure pass's own returned map"
    // check per this suite's stated purpose.
    for (const key of GSD_FIELDS.map((f) => BOOTSTRAP_LOGICAL_KEY.field(f.name))) {
      assert.ok(onDisk.map.completions[key], `${key} must survive into the file the options pass's apply wrote`);
    }
  });

  test("run 1's options pass emits exactly one Status merge operation and zero Autonomous operations, because the create response already supplied Yes/No", (t) => {
    const cwd = createTempProject('bootstrap-composition-options-');
    t.after(() => cleanup(cwd));
    const world = createWorld({ owner: 'octo', repo: 'roadmap' });
    const execGh = worldExecGh(world);
    const round1 = runInitRound({ cwd, desired: desiredFixture(), world, target: freshTarget(), execGh });

    assert.equal(round1.optionsPlan.operations.length, 1);
    assert.equal(round1.optionsPlan.operations[0].logicalKey, BOOTSTRAP_LOGICAL_KEY.field('Status'));
    assert.equal(round1.optionsPlan.operations.some((o) => o.logicalKey === BOOTSTRAP_LOGICAL_KEY.field('Autonomous')), false);
  });
});

// ─── Adopted-board case ─────────────────────────────────────────────────

/** A board a DIFFERENT tool built — described independently of any recorded fixture, ids appearing nowhere in any map. */
function adoptedBoardWorld() {
  const world = createWorld({ owner: 'acme', repo: 'product', ownerNodeId: 'O_acme', repoNodeId: 'R_acme_product' });
  world.project = { id: 'PVT_handbuilt_9', number: 9, title: 'Hand-built board' };
  world.linked = true;
  world.fields = [
    { id: 'PVTF_gsdid_h', name: 'GSD ID', dataType: 'TEXT', options: null },
    { id: 'PVTF_phase_h', name: 'Phase', dataType: 'TEXT', options: null },
    { id: 'PVTF_req_h', name: 'Requirements', dataType: 'TEXT', options: null },
    { id: 'PVTF_wave_h', name: 'Wave', dataType: 'NUMBER', options: null },
    {
      id: 'PVTF_auto_h', name: 'Autonomous', dataType: 'SINGLE_SELECT',
      options: [{ id: 'OPT_yes_h', name: 'Yes', color: 'GREEN', description: '' }, { id: 'OPT_no_h', name: 'No', color: 'RED', description: '' }],
    },
    {
      id: 'PVTF_status_h', name: 'Status', dataType: 'SINGLE_SELECT',
      options: [
        { id: 'OPT_todo_h', name: 'Todo', color: 'GRAY', description: '' },
        { id: 'OPT_inprogress_h', name: 'In Progress', color: 'BLUE', description: '' },
        { id: 'OPT_blocked_h', name: 'Blocked', color: 'RED', description: '' },
        { id: 'OPT_done_h', name: 'Done', color: 'GREEN', description: '' },
        { id: 'OPT_deferred_h', name: 'Deferred', color: 'YELLOW', description: '' },
      ],
    },
  ];
  world.labels = [{ nodeId: 'L_phase_h', name: 'gsd:phase' }, { nodeId: 'L_plan_h', name: 'gsd:plan' }];
  world.milestones = [
    { nodeId: 'M_archived_h', name: 'v0.9 — archived', number: 3, state: 'closed' },
    { nodeId: 'M_current_h', name: 'v1.0 — current', number: 4, state: 'open' },
  ];
  return world;
}

function adoptedTarget() {
  return { owner: 'acme', repo: 'product', repositoryNumber: 55, projectNumber: 9 };
}

describe('adopted-board case (BOOT-06 on the path where nothing is created)', () => {
  test('a first run against a fully populated remote board with an absent map dispatches zero mutations and records every reserved key', (t) => {
    const cwd = createTempProject('bootstrap-composition-adopted-');
    t.after(() => cleanup(cwd));
    const world = adoptedBoardWorld();
    const execGh = forbiddenExecGh();

    const round1 = runInitRound({ cwd, desired: desiredFixture(), world, target: adoptedTarget(), execGh });

    assert.equal(round1.structurePlan.operations.length, 0);
    assert.equal(round1.optionsPlan.operations.length, 0);
    assert.equal(world.calls.length, 0);
    // Nothing mutated -> the re-read boundary is not satisfied -> one read.
    assert.equal(round1.reRead, false);
    assert.equal(round1.readCount, 1);

    const onDisk = readSyncMapStrict(cwd, repositoryIdentity(adoptedTarget()));
    assert.equal(onDisk.kind, 'valid');
    const expectedKeys = [
      BOOTSTRAP_LOGICAL_KEY.project(),
      BOOTSTRAP_LOGICAL_KEY.projectLink(),
      ...GSD_FIELDS.map((f) => BOOTSTRAP_LOGICAL_KEY.field(f.name)),
      BOOTSTRAP_LOGICAL_KEY.field('Status'),
      ...GSD_LABELS.map((l) => BOOTSTRAP_LOGICAL_KEY.label(l.name)),
      BOOTSTRAP_LOGICAL_KEY.milestone('v0.9'),
      BOOTSTRAP_LOGICAL_KEY.milestone('v1.0'),
      BOOTSTRAP_LOGICAL_KEY.statusOption('Todo'),
      BOOTSTRAP_LOGICAL_KEY.statusOption('In Progress'),
      BOOTSTRAP_LOGICAL_KEY.statusOption('Blocked'),
      BOOTSTRAP_LOGICAL_KEY.statusOption('Done'),
      BOOTSTRAP_LOGICAL_KEY.statusOption('Deferred'),
      // adoptedBoardWorld's Autonomous field is already exactly Yes/No —
      // the converged branch now records both option completions instead
      // of nothing (plan 05-04, Phase 5 Pitfall 1).
      BOOTSTRAP_LOGICAL_KEY.autonomousOption('Yes'),
      BOOTSTRAP_LOGICAL_KEY.autonomousOption('No'),
    ];
    assert.deepEqual(Object.keys(onDisk.map.completions).sort(), expectedKeys.sort());

    const allOutcomes = [...(round1.structureApply.outcomes ?? []), ...(round1.optionsApply.outcomes ?? [])];
    assert.ok(allOutcomes.length > 0);
    for (const outcome of allOutcomes) {
      assert.equal(outcome.action, 'observe');
      assert.equal(outcome.result, 'confirmed');
    }
  });

  test('its second run plans zero operations, writes zero map entries, records every outcome as unchanged, and leaves the file byte-identical', (t) => {
    const cwd = createTempProject('bootstrap-composition-adopted-round2-');
    t.after(() => cleanup(cwd));
    const world = adoptedBoardWorld();
    runInitRound({ cwd, desired: desiredFixture(), world, target: adoptedTarget(), execGh: worldExecGh(world) });
    const beforeBytes = fs.readFileSync(syncMapPath(cwd), 'utf8');

    const round2 = runInitRound({ cwd, desired: desiredFixture(), world, target: adoptedTarget(), execGh: forbiddenExecGh() });

    assert.equal(round2.structurePlan.operations.length, 0);
    assert.equal(round2.optionsPlan.operations.length, 0);
    const allOutcomes = [...(round2.structureApply.outcomes ?? []), ...(round2.optionsApply.outcomes ?? [])];
    for (const outcome of allOutcomes) assert.equal(outcome.result, 'unchanged');

    const afterBytes = fs.readFileSync(syncMapPath(cwd), 'utf8');
    assert.equal(afterBytes, beforeBytes);
  });

  // ─── Phase 5 Pitfall 1 backfill proof (plan 05-04 Task 2) ────────────────
  //
  // Simulates the precise state a board bootstrapped BEFORE this fix is left
  // in: `field:autonomous` recorded (the old planAutonomousOptions's single
  // node capture), but no `option:autonomous:*` completions — the exact
  // shape UAT boards #9 and #10 are in after Phase 3 (05-RESEARCH.md
  // Pitfall 1 step 4). A plain `init` re-run must backfill both option
  // completions with zero mutations, and a second re-run must be a true
  // no-op.

  function seedLegacyAdoptedMap(cwd, world, repository) {
    const nowIso = '2026-08-01T00:00:00.000Z';
    const statusField = world.fields.find((f) => f.name === 'Status');
    const legacyEntries = [
      { logicalKey: BOOTSTRAP_LOGICAL_KEY.project(), nodeId: world.project.id, issueNumber: world.project.number },
      { logicalKey: BOOTSTRAP_LOGICAL_KEY.projectLink(), nodeId: world.repoNodeId },
      ...world.fields.filter((f) => f.name !== 'Status').map((f) => ({ logicalKey: BOOTSTRAP_LOGICAL_KEY.field(f.name), nodeId: f.id })),
      { logicalKey: BOOTSTRAP_LOGICAL_KEY.field('Status'), nodeId: statusField.id },
      ...world.labels.map((l) => ({ logicalKey: BOOTSTRAP_LOGICAL_KEY.label(l.name), nodeId: l.nodeId })),
      { logicalKey: BOOTSTRAP_LOGICAL_KEY.milestone('v0.9'), nodeId: world.milestones[0].nodeId, issueNumber: world.milestones[0].number },
      { logicalKey: BOOTSTRAP_LOGICAL_KEY.milestone('v1.0'), nodeId: world.milestones[1].nodeId, issueNumber: world.milestones[1].number },
      ...statusField.options.map((o) => ({ logicalKey: BOOTSTRAP_LOGICAL_KEY.statusOption(o.name), nodeId: o.id })),
      // Deliberately NO option:autonomous:* entries — the exact pre-fix gap.
    ];
    let seededMap = null;
    for (const entry of legacyEntries) {
      seededMap = recordCompletion(seededMap, {
        ...entry, completedAt: nowIso, owner: repository.owner, repo: repository.repo, repositoryNumber: repository.number,
      });
    }
    writeSyncMapAtomically(cwd, seededMap);
    return seededMap;
  }

  test('backfill: a board whose sync map holds field:autonomous but no option:autonomous:* completions records both option keys on a plain re-run, dispatching zero mutations', (t) => {
    const cwd = createTempProject('bootstrap-composition-adopted-backfill-');
    t.after(() => cleanup(cwd));
    const world = adoptedBoardWorld();
    const repository = repositoryIdentity(adoptedTarget());
    const seededMap = seedLegacyAdoptedMap(cwd, world, repository);
    assert.equal(seededMap.completions[BOOTSTRAP_LOGICAL_KEY.autonomousOption('Yes')], undefined);
    assert.equal(seededMap.completions[BOOTSTRAP_LOGICAL_KEY.autonomousOption('No')], undefined);
    assert.ok(seededMap.completions[BOOTSTRAP_LOGICAL_KEY.field('Autonomous')]);

    const round1 = runInitRound({ cwd, desired: desiredFixture(), world, target: adoptedTarget(), execGh: forbiddenExecGh() });

    assert.equal(round1.structurePlan.operations.length, 0);
    assert.equal(round1.optionsPlan.operations.length, 0);
    assert.equal(world.calls.length, 0, 'the backfill must dispatch zero mutations');

    const onDisk = readSyncMapStrict(cwd, repository);
    assert.equal(onDisk.kind, 'valid');
    assert.equal(onDisk.map.completions[BOOTSTRAP_LOGICAL_KEY.autonomousOption('Yes')].nodeId, 'OPT_yes_h');
    assert.equal(onDisk.map.completions[BOOTSTRAP_LOGICAL_KEY.autonomousOption('No')].nodeId, 'OPT_no_h');
    // No existing Autonomous option's identity changed across the backfill.
    assert.equal(onDisk.map.completions[BOOTSTRAP_LOGICAL_KEY.field('Autonomous')].nodeId, seededMap.completions[BOOTSTRAP_LOGICAL_KEY.field('Autonomous')].nodeId);
  });

  test('a second init immediately after the backfill also dispatches zero mutations and records the same keys — BOOT-07 unbroken by the widening', (t) => {
    const cwd = createTempProject('bootstrap-composition-adopted-backfill-round2-');
    t.after(() => cleanup(cwd));
    const world = adoptedBoardWorld();
    const repository = repositoryIdentity(adoptedTarget());
    seedLegacyAdoptedMap(cwd, world, repository);

    runInitRound({ cwd, desired: desiredFixture(), world, target: adoptedTarget(), execGh: forbiddenExecGh() });
    const afterBackfillKeys = Object.keys(readSyncMapStrict(cwd, repository).map.completions).sort();

    const round2 = runInitRound({ cwd, desired: desiredFixture(), world, target: adoptedTarget(), execGh: forbiddenExecGh() });

    assert.equal(round2.structurePlan.operations.length, 0);
    assert.equal(round2.optionsPlan.operations.length, 0);
    assert.equal(world.calls.length, 0);
    const onDiskRound2 = readSyncMapStrict(cwd, repository);
    assert.deepEqual(Object.keys(onDiskRound2.map.completions).sort(), afterBackfillKeys);
    assert.ok(afterBackfillKeys.includes(BOOTSTRAP_LOGICAL_KEY.autonomousOption('Yes')));
    assert.ok(afterBackfillKeys.includes(BOOTSTRAP_LOGICAL_KEY.autonomousOption('No')));
  });
});

// ─── Converged sequence ─────────────────────────────────────────────────

describe('converged sequence: run 2 against run 1s own output', () => {
  test('each pass returns zero operations and zero blocked/uncertain entries on the converged run; the structure pass carries a non-empty noops list', (t) => {
    const cwd = createTempProject('bootstrap-composition-converge-');
    t.after(() => cleanup(cwd));
    const world = createWorld({ owner: 'octo', repo: 'roadmap' });
    const execGh = worldExecGh(world);
    const round1 = runInitRound({ cwd, desired: desiredFixture(), world, target: freshTarget(), execGh });
    assert.equal(round1.optionsApply.kind, 'completed');

    const round2 = runInitRound({
      cwd, desired: desiredFixture(), world,
      target: { ...freshTarget(), projectNumber: round1.effectiveProjectNumber },
      execGh: worldExecGh(world),
    });

    assert.equal(round2.structurePlan.operations.length, 0);
    assert.equal(round2.structurePlan.blocked.length, 0);
    assert.equal(round2.structurePlan.uncertain.length, 0);
    assert.ok(round2.structurePlan.noops.length > 0, 'labels/milestones adoption noops must be non-empty');

    assert.equal(round2.optionsPlan.operations.length, 0);
    assert.equal(round2.optionsPlan.blocked.length, 0);
    assert.equal(round2.optionsPlan.uncertain.length, 0);
  });

  test("run 2's mutated-key list is empty, the re-read condition is therefore not satisfied, and the map reaches a fixpoint by round 3 (round 1's structure pass ran against the pre-creation snapshot, so it could not yet see or checkpoint the built-in Status field — round 2 is the first structure pass to observe it, and round 3 is the true byte-identical fixpoint)", (t) => {
    const cwd = createTempProject('bootstrap-composition-converge-noop-');
    t.after(() => cleanup(cwd));
    const world = createWorld({ owner: 'octo', repo: 'roadmap' });
    const round1 = runInitRound({ cwd, desired: desiredFixture(), world, target: freshTarget(), execGh: worldExecGh(world) });

    const round2 = runInitRound({
      cwd, desired: desiredFixture(), world,
      target: { ...freshTarget(), projectNumber: round1.effectiveProjectNumber },
      execGh: worldExecGh(world),
    });
    assert.deepEqual(round2.mutated, []);
    assert.equal(round2.reRead, false);
    assert.equal(round2.readCount, 1);
    const mapAfterRun2 = readSyncMapStrict(cwd, repositoryIdentity(freshTarget())).map;

    const round3 = runInitRound({
      cwd, desired: desiredFixture(), world,
      target: { ...freshTarget(), projectNumber: round1.effectiveProjectNumber },
      execGh: worldExecGh(world),
    });
    assert.deepEqual(round3.mutated, []);
    assert.equal(round3.reRead, false);
    assert.equal(round3.readCount, 1);
    const mapAfterRun3 = readSyncMapStrict(cwd, repositoryIdentity(freshTarget())).map;
    assert.deepEqual(mapAfterRun3, mapAfterRun2);
    assert.equal(mapAfterRun3.version, '1');
  });

  // Six focused per-stage convergence cases, each asserting exactly which
  // stage went quiet while at least one other stage still contributes
  // operations.
  const CONTEXT = { owner: 'octo', repo: 'repo', repositoryNumber: 1 };
  function adoptedRepository() {
    return { nodeId: 'R_1', ownerNodeId: 'O_1', ownerLogin: 'octo', linkState: 'linked' };
  }
  function convergedFields() {
    return [
      { id: 'F_id', name: 'GSD ID', dataType: 'TEXT', options: null },
      { id: 'F_phase', name: 'Phase', dataType: 'TEXT', options: null },
      { id: 'F_req', name: 'Requirements', dataType: 'TEXT', options: null },
      { id: 'F_wave', name: 'Wave', dataType: 'NUMBER', options: null },
      { id: 'F_auto', name: 'Autonomous', dataType: 'SINGLE_SELECT', options: [{ id: 'A1', name: 'Yes', color: 'GREEN', description: '' }, { id: 'A2', name: 'No', color: 'RED', description: '' }] },
    ];
  }
  function convergedStatus() {
    return {
      id: 'F_status', name: 'Status', dataType: 'SINGLE_SELECT',
      options: [
        { id: 'S1', name: 'Todo', color: 'GRAY', description: '' },
        { id: 'S2', name: 'In Progress', color: 'BLUE', description: '' },
        { id: 'S3', name: 'Blocked', color: 'RED', description: '' },
        { id: 'S4', name: 'Done', color: 'GREEN', description: '' },
        { id: 'S5', name: 'Deferred', color: 'YELLOW', description: '' },
      ],
    };
  }
  function convergedLabels() {
    return [{ nodeId: 'L1', name: 'gsd:phase' }, { nodeId: 'L2', name: 'gsd:plan' }];
  }
  function convergedMilestone() {
    return [{ nodeId: 'M1', name: 'v1.0 — current', number: 3, state: 'open' }];
  }
  const desiredOneMilestone = { available: true, milestones: [{ version: 'v1.0', name: 'current', title: 'v1.0 — current', description: '', archived: false }] };
  const target9 = { ...CONTEXT, projectNumber: 9 };

  test('project stage converged alone: zero project operations, non-zero field/label/milestone operations', () => {
    const remote = {
      available: true, projectOutcome: 'resolved', projectNodeId: 'PVT_x', repository: adoptedRepository(),
      fields: [], statusField: null, labels: [], milestones: [],
    };
    const plan = planBootstrap({ desired: desiredOneMilestone, remote, strictMap: { kind: 'absent' }, target: target9 }, { pass: BOOTSTRAP_PASS.STRUCTURE });
    assert.equal(plan.operations.some((o) => o.logicalKey === BOOTSTRAP_LOGICAL_KEY.project()), false);
    assert.equal(plan.operations.some((o) => o.logicalKey === BOOTSTRAP_LOGICAL_KEY.projectLink()), false);
    assert.ok(plan.operations.some((o) => o.logicalKey.startsWith('field:')));
    assert.ok(plan.operations.some((o) => o.logicalKey.startsWith('label:')));
    assert.ok(plan.operations.some((o) => o.logicalKey.startsWith('milestone:')));
  });

  test('fields stage converged alone: zero field operations, non-zero label/milestone operations', () => {
    const remote = {
      available: true, projectOutcome: 'resolved', projectNodeId: 'PVT_x', repository: adoptedRepository(),
      fields: convergedFields(), statusField: convergedStatus(), labels: [], milestones: [],
    };
    const plan = planBootstrap({ desired: desiredOneMilestone, remote, strictMap: { kind: 'absent' }, target: target9 }, { pass: BOOTSTRAP_PASS.STRUCTURE });
    assert.equal(plan.operations.filter((o) => o.stage === BOOTSTRAP_STAGE.FIELDS).length, 0);
    assert.ok(plan.operations.some((o) => o.logicalKey.startsWith('label:')));
    assert.ok(plan.operations.some((o) => o.logicalKey.startsWith('milestone:')));
  });

  test('labels stage converged alone: zero label operations, non-zero milestone operations', () => {
    const remote = {
      available: true, projectOutcome: 'resolved', projectNodeId: 'PVT_x', repository: adoptedRepository(),
      fields: convergedFields(), statusField: convergedStatus(), labels: convergedLabels(), milestones: [],
    };
    const plan = planBootstrap({ desired: desiredOneMilestone, remote, strictMap: { kind: 'absent' }, target: target9 }, { pass: BOOTSTRAP_PASS.STRUCTURE });
    assert.equal(plan.operations.filter((o) => o.stage === BOOTSTRAP_STAGE.LABELS).length, 0);
    assert.ok(plan.operations.some((o) => o.logicalKey.startsWith('milestone:')));
  });

  test('milestones stage converged alone: zero milestone operations, non-zero label operations', () => {
    const remote = {
      available: true, projectOutcome: 'resolved', projectNodeId: 'PVT_x', repository: adoptedRepository(),
      fields: convergedFields(), statusField: convergedStatus(), labels: [], milestones: convergedMilestone(),
    };
    const plan = planBootstrap({ desired: desiredOneMilestone, remote, strictMap: { kind: 'absent' }, target: target9 }, { pass: BOOTSTRAP_PASS.STRUCTURE });
    assert.equal(plan.operations.filter((o) => o.stage === BOOTSTRAP_STAGE.MILESTONES).length, 0);
    assert.ok(plan.operations.some((o) => o.logicalKey.startsWith('label:')));
  });

  test('status stage converged alone: zero status operations, non-zero autonomous operations', () => {
    const remote = {
      available: true, projectOutcome: 'resolved',
      statusField: convergedStatus(),
      fields: [{ id: 'F_auto', name: 'Autonomous', dataType: 'SINGLE_SELECT', options: [{ id: 'A1', name: 'Yes', color: 'GREEN', description: '' }, { id: 'A2', name: 'Extra', color: 'PURPLE', description: '' }] }],
    };
    const plan = planBootstrap({ desired: { available: true }, remote, strictMap: { kind: 'absent' }, target: target9 }, { pass: BOOTSTRAP_PASS.OPTIONS });
    assert.equal(plan.operations.some((o) => o.logicalKey === BOOTSTRAP_LOGICAL_KEY.field('Status')), false);
    assert.ok(plan.operations.some((o) => o.logicalKey === BOOTSTRAP_LOGICAL_KEY.field('Autonomous')));
  });

  test('autonomous stage converged alone: zero autonomous operations, non-zero status operations', () => {
    const remote = {
      available: true, projectOutcome: 'resolved',
      statusField: { id: 'F_status', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'S1', name: 'Todo', color: 'GRAY', description: '' }] },
      fields: [{ id: 'F_auto', name: 'Autonomous', dataType: 'SINGLE_SELECT', options: [{ id: 'A1', name: 'Yes', color: 'GREEN', description: '' }, { id: 'A2', name: 'No', color: 'RED', description: '' }] }],
    };
    const plan = planBootstrap({ desired: { available: true }, remote, strictMap: { kind: 'absent' }, target: target9 }, { pass: BOOTSTRAP_PASS.OPTIONS });
    assert.equal(plan.operations.some((o) => o.logicalKey === BOOTSTRAP_LOGICAL_KEY.field('Autonomous')), false);
    assert.ok(plan.operations.some((o) => o.logicalKey === BOOTSTRAP_LOGICAL_KEY.field('Status')));
  });
});

// ─── Drift cases that must still converge to zero ──────────────────────

describe('drift cases converge to zero', () => {
  test('a Status option renamed on the board but matched by stored id converges to zero operations (D-16/D-18: Status options are never reconciled after creation, so the rename is adopted, not repaired)', (t) => {
    const cwd = createTempProject('bootstrap-composition-drift-status-');
    t.after(() => cleanup(cwd));
    const world = createWorld({ owner: 'octo', repo: 'roadmap' });
    const round1 = runInitRound({ cwd, desired: desiredFixture(), world, target: freshTarget(), execGh: worldExecGh(world) });
    const statusFieldOnBoard = world.fields.find((f) => f.name === 'Status');
    const todoOption = statusFieldOnBoard.options.find((o) => o.name === 'Todo');
    todoOption.name = 'To Do (renamed on the board)';

    // isConverged compares by id, order-independent: the merge echoes the
    // matched remote option's fields VERBATIM (including its now-renamed
    // name), so the merged array and the remote already agree byte-for-byte
    // — a renamed Status option is adopted under its new name, never
    // repaired back to canonical, unlike a field (D-23).
    const round2 = runInitRound({
      cwd, desired: desiredFixture(), world,
      target: { ...freshTarget(), projectNumber: round1.effectiveProjectNumber },
      execGh: worldExecGh(world),
    });
    assert.equal(round2.optionsPlan.operations.length, 0);
  });

  test('a GSD field renamed on the board and matched by stored id plans one rename operation on the next run, then converges on the run after that', (t) => {
    const cwd = createTempProject('bootstrap-composition-drift-field-');
    t.after(() => cleanup(cwd));
    const world = createWorld({ owner: 'octo', repo: 'roadmap' });
    const round1 = runInitRound({ cwd, desired: desiredFixture(), world, target: freshTarget(), execGh: worldExecGh(world) });
    const waveField = world.fields.find((f) => f.name === 'Wave');
    waveField.name = 'Wave (renamed)';

    const round2 = runInitRound({
      cwd, desired: desiredFixture(), world,
      target: { ...freshTarget(), projectNumber: round1.effectiveProjectNumber },
      execGh: worldExecGh(world),
    });
    assert.equal(round2.structurePlan.operations.filter((o) => o.logicalKey === BOOTSTRAP_LOGICAL_KEY.field('Wave')).length, 1);
    assert.equal(round2.structurePlan.operations.find((o) => o.logicalKey === BOOTSTRAP_LOGICAL_KEY.field('Wave')).kind, 'rename-field');
    assert.equal(waveField.name, 'Wave');

    const round3 = runInitRound({
      cwd, desired: desiredFixture(), world,
      target: { ...freshTarget(), projectNumber: round1.effectiveProjectNumber },
      execGh: worldExecGh(world),
    });
    assert.equal(round3.structurePlan.operations.filter((o) => o.logicalKey === BOOTSTRAP_LOGICAL_KEY.field('Wave')).length, 0);
  });

  test('a GSD field with a dangling stored id is re-matched by canonical name, plans zero operations, and the map holds the new id afterward', (t) => {
    const cwd = createTempProject('bootstrap-composition-drift-dangling-');
    t.after(() => cleanup(cwd));
    const world = createWorld({ owner: 'octo', repo: 'roadmap' });
    const round1 = runInitRound({ cwd, desired: desiredFixture(), world, target: freshTarget(), execGh: worldExecGh(world) });

    // Corrupt the stored id for the Wave field so it no longer resolves —
    // the field itself is untouched on the board, so name-fallback applies.
    const repository = repositoryIdentity(freshTarget());
    let map = readSyncMapStrict(cwd, repository).map;
    const staleKey = BOOTSTRAP_LOGICAL_KEY.field('Wave');
    const realId = map.completions[staleKey].nodeId;
    map = recordCompletion(map, { ...map.completions[staleKey], nodeId: 'PVTF_dangling_stale' });
    writeSyncMapAtomically(cwd, map);

    const round2 = runInitRound({
      cwd, desired: desiredFixture(), world,
      target: { ...freshTarget(), projectNumber: round1.effectiveProjectNumber },
      execGh: worldExecGh(world),
    });
    assert.equal(round2.structurePlan.operations.filter((o) => o.logicalKey === staleKey).length, 0);
    assert.equal(round2.structureApply.kind, 'completed');
    const afterMap = readSyncMapStrict(cwd, repository).map;
    assert.equal(afterMap.completions[staleKey].nodeId, realId);
  });

  test('a milestone whose title changed but whose leading version token is unchanged converges to zero operations', (t) => {
    const cwd = createTempProject('bootstrap-composition-drift-milestone-');
    t.after(() => cleanup(cwd));
    const world = createWorld({ owner: 'octo', repo: 'roadmap' });
    const round1 = runInitRound({ cwd, desired: desiredFixture(), world, target: freshTarget(), execGh: worldExecGh(world) });
    const currentMilestone = world.milestones.find((m) => m.name.startsWith('v1.0'));
    currentMilestone.name = 'v1.0 — renamed on the board';

    const round2 = runInitRound({
      cwd, desired: desiredFixture(), world,
      target: { ...freshTarget(), projectNumber: round1.effectiveProjectNumber },
      execGh: worldExecGh(world),
    });
    assert.equal(round2.structurePlan.operations.filter((o) => o.logicalKey.startsWith('milestone:')).length, 0);
  });

  test('a permanently case-variant label converges to zero label operations on rounds two and three', (t) => {
    const cwd = createTempProject('bootstrap-composition-drift-label-');
    t.after(() => cleanup(cwd));
    const world = createWorld({ owner: 'octo', repo: 'roadmap' });
    world.project = { id: 'PVT_variant', number: 9, title: 'x' };
    world.linked = true;
    world.fields = [{ id: 'F_status', name: 'Status', dataType: 'SINGLE_SELECT', options: [] }];
    world.labels = [{ nodeId: 'L_variant', name: 'GSD:Phase' }];

    for (let round = 1; round <= 3; round += 1) {
      const result = runInitRound({
        cwd, desired: { available: true }, world,
        target: { owner: 'octo', repo: 'roadmap', repositoryNumber: 42, projectNumber: 9 },
        execGh: worldExecGh(world),
      });
      if (round > 1) assert.equal(result.structurePlan.operations.filter((o) => o.logicalKey.startsWith('label:')).length, 0, `round ${round} must emit zero label operations`);
    }
  });

  test('an adopted board whose title differs from config converges to zero operations (D-15, no rename)', (t) => {
    const cwd = createTempProject('bootstrap-composition-drift-title-');
    t.after(() => cleanup(cwd));
    const world = adoptedBoardWorld();
    const round1 = runInitRound({ cwd, desired: desiredFixture(), world, target: adoptedTarget(), execGh: forbiddenExecGh(), projectTitle: 'A Totally Different Configured Title' });
    assert.equal(round1.structurePlan.operations.length, 0);
    assert.equal(world.project.title, 'Hand-built board');
  });
});

// ─── Identity is byte-exact ─────────────────────────────────────────────

describe('identity is byte-exact', () => {
  test('a completion node id of the string form of a number is never treated as equal to a remote id of the numeric form', () => {
    const remote = {
      available: true, projectOutcome: 'resolved', projectNodeId: 'PVT_x',
      repository: { nodeId: 'R_1', ownerNodeId: 'O_1', ownerLogin: 'octo', linkState: 'linked' },
      fields: [{ id: '12345', name: 'Wave', dataType: 'NUMBER', options: null }],
      statusField: null,
    };
    const strictMap = { kind: 'valid', map: { completions: { [BOOTSTRAP_LOGICAL_KEY.field('Wave')]: { nodeId: 12345 } } } };
    const plan = planBootstrap({ desired: { available: true }, remote, strictMap, target: { owner: 'octo', repo: 'repo', repositoryNumber: 1, projectNumber: 9 } }, { pass: BOOTSTRAP_PASS.STRUCTURE });
    // A stored id of 12345 (number) can never === the remote's '12345' (string)
    // under the field resolver's strict-equality match — the field falls
    // back to name matching (Wave still named canonically) and checkpoints
    // by exact name, never producing a rename.
    assert.equal(plan.operations.filter((o) => o.logicalKey === BOOTSTRAP_LOGICAL_KEY.field('Wave')).length, 0);
  });

  test('a milestone title with leading ASCII whitespace still parses to the same version token', () => {
    const { parseMilestoneVersionToken } = require('../gsd-core/bin/lib/github-sync-bootstrap-plan.cjs');
    assert.equal(parseMilestoneVersionToken('   v1.0 — current'), 'v1.0');
  });

  test('a milestone titled with the version token in a non-leading position does not match', () => {
    const { parseMilestoneVersionToken } = require('../gsd-core/bin/lib/github-sync-bootstrap-plan.cjs');
    assert.equal(parseMilestoneVersionToken('release v1.0 — current'), null);
  });
});

// ─── Failure and recovery cases ─────────────────────────────────────────

describe('failure and recovery cases', () => {
  test('a run failing on operation 3 leaves exactly the fold plus the first two completions in the map, the options pass never runs, and the following run resumes from the third operation onward', (t) => {
    const cwd = createTempProject('bootstrap-composition-partial-failure-');
    t.after(() => cleanup(cwd));
    const world = createWorld({ owner: 'octo', repo: 'roadmap' });
    const execGh = worldExecGhFailingAt(world, 3);

    const round1 = runInitRound({ cwd, desired: desiredFixture(), world, target: freshTarget(), execGh });
    assert.equal(round1.structureApply.kind, 'failed');
    assert.equal(round1.optionsApply, undefined);

    const onDisk = readSyncMapStrict(cwd, repositoryIdentity(freshTarget()));
    assert.equal(onDisk.kind, 'valid');
    // Operations 1 and 2 (project create, link) confirmed; operation 3
    // (the first field create) never ran.
    assert.ok(onDisk.map.completions[BOOTSTRAP_LOGICAL_KEY.project()]);
    assert.ok(onDisk.map.completions[BOOTSTRAP_LOGICAL_KEY.projectLink()]);
    assert.equal(onDisk.map.completions[BOOTSTRAP_LOGICAL_KEY.field('GSD ID')], undefined);
    // Distinguishable from a recovered already-exists: the failed op's key
    // is absent from the journal entirely, not present with a result.
    assert.equal(round1.structureApply.outcomes.some((o) => o.logicalKey === BOOTSTRAP_LOGICAL_KEY.field('GSD ID')), false);

    // Round 2 re-plans from the third operation onward without redoing the
    // first two (fields 1-4 remain missing; the create for GSD ID appears
    // again — the confirmed project/link do not).
    const round2 = runInitRound({
      cwd, desired: desiredFixture(), world,
      target: { ...freshTarget(), projectNumber: round1.effectiveProjectNumber ?? world.project.number },
      execGh: worldExecGh(world),
    });
    assert.equal(round2.structurePlan.operations.some((o) => o.logicalKey === BOOTSTRAP_LOGICAL_KEY.project()), false);
    assert.equal(round2.structurePlan.operations.some((o) => o.logicalKey === BOOTSTRAP_LOGICAL_KEY.projectLink()), false);
    assert.ok(round2.structurePlan.operations.some((o) => o.logicalKey === BOOTSTRAP_LOGICAL_KEY.field('GSD ID')));
  });

  test('a crash between the project create and the config write is recovered by resolveTarget reading the repository identity first and the map second, and the config gets the recovered number written back', (t) => {
    const cwd = createTempProject('bootstrap-composition-crash-recovery-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
    // The crash shape: config carries no github_sync block at all.
    fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({ some_other_key: true }, null, 2));

    // Run 1 confirms a project completion in the map (as if the create
    // succeeded) but the process crashed before any config write.
    let map = null;
    map = recordCompletion(map, {
      logicalKey: BOOTSTRAP_LOGICAL_KEY.project(), nodeId: 'PVT_recovered', issueNumber: 77,
      completedAt: '2026-08-01T00:00:00.000Z', owner: 'octo', repo: 'roadmap', repositoryNumber: 42,
    });
    writeSyncMapAtomically(cwd, map);

    const execGh = (args) => {
      if (args[0] === 'repo' && args[1] === 'view') {
        return { exitCode: 0, reason: 'ok', stdout: JSON.stringify({ owner: { login: 'octo' }, name: 'roadmap', databaseId: 42 }), stderr: '' };
      }
      throw new Error(`unexpected execGh call during resolveTarget: ${JSON.stringify(args)}`);
    };

    const resolved = bootstrapConfigMod.resolveTarget(cwd, { execGh });
    assert.ok(resolved.target);
    assert.equal(resolved.target.owner, 'octo');
    assert.equal(resolved.target.repo, 'roadmap');
    assert.equal(resolved.target.repositoryNumber, 42);
    // The project number is recovered from the map, not left null — a
    // structure pass built from this target would plan zero create ops.
    assert.equal(resolved.target.projectNumber, 77);

    const writeResult = bootstrapConfigMod.writeProjectNumber(cwd, { owner: 'octo', repo: 'roadmap', repositoryNumber: 42 }, 77);
    assert.equal(writeResult.ok, true);
    const configAfter = JSON.parse(fs.readFileSync(path.join(cwd, '.planning', 'config.json'), 'utf8'));
    assert.equal(configAfter.github_sync.target.project_number, 77);
  });

  test('a 422 already-exists label create leaves the run completed with no label completion recorded and an already-exists outcome, and the next run plans zero label operations via adoption', (t) => {
    const cwd = createTempProject('bootstrap-composition-already-exists-');
    t.after(() => cleanup(cwd));
    const world = createWorld({ owner: 'octo', repo: 'roadmap' });
    world.project = { id: 'PVT_x', number: 9, title: 'x' };
    world.linked = true;
    world.fields = [
      { id: 'F_id', name: 'GSD ID', dataType: 'TEXT', options: null },
      { id: 'F_phase', name: 'Phase', dataType: 'TEXT', options: null },
      { id: 'F_req', name: 'Requirements', dataType: 'TEXT', options: null },
      { id: 'F_wave', name: 'Wave', dataType: 'NUMBER', options: null },
      { id: 'F_auto', name: 'Autonomous', dataType: 'SINGLE_SELECT', options: [{ id: 'A1', name: 'Yes', color: 'GREEN', description: '' }, { id: 'A2', name: 'No', color: 'RED', description: '' }] },
      { id: 'F_status', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'S1', name: 'Todo', color: 'GRAY', description: '' }, { id: 'S2', name: 'In Progress', color: 'BLUE', description: '' }, { id: 'S3', name: 'Blocked', color: 'RED', description: '' }, { id: 'S4', name: 'Done', color: 'GREEN', description: '' }, { id: 'S5', name: 'Deferred', color: 'YELLOW', description: '' }] },
    ];
    // Already having gsd:phase created live (raced by another process) but
    // NOT yet visible in this run's own list read.
    const target = { owner: 'octo', repo: 'roadmap', repositoryNumber: 42, projectNumber: 9 };
    const execGh = worldExecGhAlreadyExistsAt(world, 1); // the FIRST call this run makes is the gsd:phase label create

    const round1 = runInitRound({ cwd, desired: { available: true }, world, target, execGh });
    assert.equal(round1.structureApply.kind, 'completed');
    const labelKey = BOOTSTRAP_LOGICAL_KEY.label('gsd:phase');
    assert.equal(round1.structureApply.map.completions[labelKey], undefined);
    const alreadyExistsOutcome = round1.structureApply.outcomes.find((o) => o.logicalKey === labelKey);
    assert.ok(alreadyExistsOutcome);
    assert.equal(alreadyExistsOutcome.result, 'already-exists');

    // Simulate the race resolving: the label now really exists on the board.
    world.labels.push({ nodeId: 'L_phase_raced', name: 'gsd:phase' });
    const round2 = runInitRound({ cwd, desired: { available: true }, world, target, execGh: worldExecGh(world) });
    assert.equal(round2.structurePlan.operations.some((o) => o.logicalKey === labelKey), false);
    assert.ok(round2.structurePlan.checkpoints.some((c) => c.logicalKey === labelKey));
  });

  test('a run-fatal field mismatch leaves zero operations, zero checkpoints, zero execGh calls, and no sync map file on disk', (t) => {
    const cwd = createTempProject('bootstrap-composition-run-fatal-');
    t.after(() => cleanup(cwd));
    const world = createWorld({ owner: 'octo', repo: 'roadmap' });
    world.project = { id: 'PVT_x', number: 9, title: 'x' };
    world.linked = true;
    world.fields = [
      { id: 'F_id', name: 'GSD ID', dataType: 'TEXT', options: null },
      { id: 'F_wave', name: 'Wave', dataType: 'TEXT', options: null }, // wrong type — should be NUMBER
    ];
    const target = { owner: 'octo', repo: 'roadmap', repositoryNumber: 42, projectNumber: 9 };

    const round1 = runInitRound({ cwd, desired: desiredFixture(), world, target, execGh: forbiddenExecGh() });
    assert.equal(round1.structurePlan.operations.length, 0);
    assert.equal(round1.structurePlan.checkpoints.length, 0);
    assert.equal(round1.structurePlan.blocked[0].reason, BOOTSTRAP_OPERATION_REASON.FIELD_TYPE_MISMATCH);
    assert.equal(world.calls.length, 0);
    assert.equal(fs.existsSync(syncMapPath(cwd)), false);
  });
});
