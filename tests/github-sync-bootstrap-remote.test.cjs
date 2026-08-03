'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  assertPathSafeTarget,
  readBootstrapRemoteState,
  restPath,
  readRepoLabels,
  readRepoMilestones,
  BOOTSTRAP_REMOTE_REASON,
  PROJECT_OUTCOME,
  STATUS_FIELD_NAME,
  BOOTSTRAP_DOCUMENTS,
} = require('../gsd-core/bin/lib/github-sync-bootstrap-remote.cjs');

const repoObjectsFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/github-sync/bootstrap-repo-objects.json'), 'utf8'),
);
const { planStatusOptionMerge, planProject, planFields, planViews, BOOTSTRAP_LOGICAL_KEY } = require('../gsd-core/bin/lib/github-sync-bootstrap-plan.cjs');

const bootstrapViewsFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/github-sync/bootstrap-views.json'), 'utf8'),
);

function envelope(data) {
  return { data };
}

function ownerFieldsResponse(nodes, hasNextPage = false, endCursor = null, projectId = 'PVT_project') {
  return envelope({
    repositoryOwner: {
      projectV2: {
        id: projectId,
        fields: { nodes, pageInfo: { hasNextPage, endCursor } },
      },
    },
  });
}

/** Plan 06-01 Task 1: a decodable empty `views` connection response, the default every pre-06-01 test now implicitly exercises via readBootstrapRemoteState's new views read. */
function ownerViewsResponse(nodes = [], hasNextPage = false, endCursor = null) {
  return envelope({
    repositoryOwner: {
      projectV2: {
        views: { nodes, pageInfo: { hasNextPage, endCursor } },
      },
    },
  });
}

function repositoryResponse(id = 'R_repo', ownerId = 'O_owner', login = 'octo', linkedNumbers = [], hasNextPage = false) {
  return envelope({
    repository: {
      id,
      owner: { id: ownerId, login },
      projectsV2: { nodes: linkedNumbers.map((number) => ({ number })), pageInfo: { hasNextPage, endCursor: hasNextPage ? 'link-cursor' : null } },
    },
  });
}

function makeExecGh(sequence) {
  const calls = [];
  return {
    calls,
    execGh(args) {
      calls.push(args);
      const isRepoDoc = args.find((arg) => typeof arg === 'string' && arg.startsWith('query=') && arg.includes('github-sync-bootstrap:repository'));
      const isFieldsDoc = args.find((arg) => typeof arg === 'string' && arg.startsWith('query=') && arg.includes('github-sync-bootstrap:fieldsWithTypes'));
      const isViewsDoc = args.find((arg) => typeof arg === 'string' && arg.startsWith('query=') && arg.includes('github-sync-bootstrap:views'));
      const isLabelsRest = typeof args[1] === 'string' && args[1].includes('/labels');
      const isMilestonesRest = typeof args[1] === 'string' && args[1].includes('/milestones');
      const kind = isRepoDoc ? 'repository' : isFieldsDoc ? 'fields' : isViewsDoc ? 'views' : isLabelsRest ? 'labels' : isMilestonesRest ? 'milestones' : 'unknown';
      // Tests that never script 'labels'/'milestones' still exercise
      // readBootstrapRemoteState's now-mandatory REST reads (Task 2); default
      // both to a decodable empty list so every pre-Task-2 test keeps passing
      // unchanged, and a test that cares about the REST shape scripts it
      // explicitly via `sequence.labels`/`sequence.milestones`.
      if (kind === 'labels' || kind === 'milestones') {
        const next = sequence[kind]?.shift() ?? [[]];
        return { exitCode: 0, reason: 'ok', stderr: '', stdout: JSON.stringify(next) };
      }
      // Plan 06-01 Task 1: tests that never script 'views' still exercise the
      // new views read on every resolved-project call — default to a
      // decodable empty connection so every pre-06-01 test keeps passing
      // unchanged; a test that cares about the views shape scripts it
      // explicitly via `sequence.views`.
      if (kind === 'views') {
        const next = sequence.views?.shift() ?? ownerViewsResponse();
        return { exitCode: 0, reason: 'ok', stderr: '', stdout: JSON.stringify(next) };
      }
      const next = sequence[kind]?.shift();
      if (!next) throw new Error(`no scripted response for ${kind}`);
      return { exitCode: 0, reason: 'ok', stderr: '', stdout: JSON.stringify(next) };
    },
  };
}

// ─── assertPathSafeTarget ───────────────────────────────────────────────────

describe('assertPathSafeTarget', () => {
  test('accepts realistic owner/repo values', () => {
    assert.equal(assertPathSafeTarget('drungrin', 'gsd-core'), true);
    assert.equal(assertPathSafeTarget('octo-cat', 'repo.name'), true);
  });

  test('rejects a brace, a slash, an at-sign, a space, and the empty string', () => {
    assert.equal(assertPathSafeTarget('{owner}', 'repo'), false);
    assert.equal(assertPathSafeTarget('owner/evil', 'repo'), false);
    assert.equal(assertPathSafeTarget('@owner', 'repo'), false);
    assert.equal(assertPathSafeTarget('owner name', 'repo'), false);
    assert.equal(assertPathSafeTarget('', 'repo'), false);
    assert.equal(assertPathSafeTarget('owner', ''), false);
  });
});

// ─── readBootstrapRemoteState ──────────────────────────────────────────────

describe('readBootstrapRemoteState', () => {
  test('an unsafe target returns unavailable without invoking execGh even once', () => {
    let called = false;
    const result = readBootstrapRemoteState({
      cwd: '/repo', owner: '{owner}', repo: 'repo', projectNumber: 7,
      execGh: () => { called = true; throw new Error('must not call execGh'); },
    });
    assert.equal(result.available, false);
    assert.equal(result.reason, BOOTSTRAP_REMOTE_REASON.UNSAFE_TARGET);
    assert.equal(called, false);
  });

  test('decodes fields carrying id/name/dataType, and the Status field carrying its options with id/name/color/description', () => {
    const seq = {
      repository: [repositoryResponse()],
      fields: [ownerFieldsResponse([
        { id: 'PVTF_gsdid', name: 'GSD ID', dataType: 'TEXT' },
        { id: 'PVTF_status', name: STATUS_FIELD_NAME, dataType: 'SINGLE_SELECT', options: [{ id: 'opt-1', name: 'Todo', color: 'GRAY', description: '' }] },
      ])],
    };
    const { execGh } = makeExecGh(seq);
    const result = readBootstrapRemoteState({ cwd: '/repo', owner: 'octo', repo: 'repo', projectNumber: 7, execGh });
    assert.equal(result.available, true);
    assert.equal(result.projectOutcome, PROJECT_OUTCOME.RESOLVED);
    assert.equal(result.fields.length, 2);
    assert.equal(result.statusField.id, 'PVTF_status');
    assert.deepEqual(result.statusField.options, [{ id: 'opt-1', name: 'Todo', color: 'GRAY', description: '' }]);
  });

  test('a null project number returns available true, outcome unset, empty fields, null Status field, and issues no fields-document call', () => {
    const seq = { repository: [repositoryResponse()], fields: [] };
    const { execGh, calls } = makeExecGh(seq);
    const result = readBootstrapRemoteState({ cwd: '/repo', owner: 'octo', repo: 'repo', projectNumber: null, execGh });
    assert.equal(result.available, true);
    assert.equal(result.projectOutcome, PROJECT_OUTCOME.UNSET);
    assert.deepEqual(result.fields, []);
    assert.equal(result.statusField, null);
    assert.equal(calls.some((args) => args.some((arg) => typeof arg === 'string' && arg.includes('github-sync-bootstrap:fieldsWithTypes'))), false);
  });

  test('the same call with a positive project number does issue the fields document', () => {
    const seq = { repository: [repositoryResponse()], fields: [ownerFieldsResponse([])] };
    const { execGh, calls } = makeExecGh(seq);
    readBootstrapRemoteState({ cwd: '/repo', owner: 'octo', repo: 'repo', projectNumber: 7, execGh });
    assert.equal(calls.some((args) => args.some((arg) => typeof arg === 'string' && arg.includes('github-sync-bootstrap:fieldsWithTypes'))), true);
  });

  test('a resolved project reports the built-in Status field node id on the decoded snapshot', () => {
    const seq = {
      repository: [repositoryResponse()],
      fields: [ownerFieldsResponse([{ id: 'PVTF_status', name: STATUS_FIELD_NAME, dataType: 'SINGLE_SELECT', options: [] }])],
    };
    const { execGh } = makeExecGh(seq);
    const result = readBootstrapRemoteState({ cwd: '/repo', owner: 'octo', repo: 'repo', projectNumber: 7, execGh });
    assert.equal(result.statusField.id, 'PVTF_status');
  });

  test('an organization-kind and a user-kind repositoryOwner response decode to the same field set; a viewer-rooted body decodes to an empty field set', () => {
    const nodes = [{ id: 'PVTF_1', name: 'GSD ID', dataType: 'TEXT' }];
    const orgLike = ownerFieldsResponse(nodes);
    const userLike = ownerFieldsResponse(nodes);
    for (const body of [orgLike, userLike]) {
      const seq = { repository: [repositoryResponse()], fields: [body] };
      const { execGh } = makeExecGh(seq);
      const result = readBootstrapRemoteState({ cwd: '/repo', owner: 'octo', repo: 'repo', projectNumber: 7, execGh });
      assert.equal(result.fields.length, 1);
    }

    const viewerRooted = envelope({ viewer: { projectV2: { fields: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } });
    const seq = { repository: [repositoryResponse()], fields: [viewerRooted] };
    const { execGh } = makeExecGh(seq);
    const result = readBootstrapRemoteState({ cwd: '/repo', owner: 'octo', repo: 'repo', projectNumber: 7, execGh });
    assert.equal(result.available, false);
  });

  test('the fields-document argv carries the owner login on the raw flag and the project number on the typed flag', () => {
    const seq = { repository: [repositoryResponse()], fields: [ownerFieldsResponse([])] };
    const { execGh, calls } = makeExecGh(seq);
    readBootstrapRemoteState({ cwd: '/repo', owner: 'octo', repo: 'repo', projectNumber: 7, execGh });
    const fieldsCall = calls.find((args) => args.some((arg) => typeof arg === 'string' && arg.includes('github-sync-bootstrap:fieldsWithTypes')));
    const ownerIndex = fieldsCall.findIndex((arg) => typeof arg === 'string' && arg.startsWith('owner='));
    assert.equal(fieldsCall[ownerIndex - 1], '-f');
    const projectIndex = fieldsCall.findIndex((arg) => typeof arg === 'string' && arg.startsWith('projectNumber='));
    assert.equal(fieldsCall[projectIndex - 1], '-F');
  });

  test('cursor exhaustion: two pages accumulate both, and a repeated end cursor returns unavailable', () => {
    const page1 = ownerFieldsResponse([{ id: 'PVTF_1', name: 'A', dataType: 'TEXT' }], true, 'cursor-1');
    const page2 = ownerFieldsResponse([{ id: 'PVTF_2', name: 'B', dataType: 'TEXT' }], false, null);
    const seq = { repository: [repositoryResponse()], fields: [page1, page2] };
    const { execGh } = makeExecGh(seq);
    const result = readBootstrapRemoteState({ cwd: '/repo', owner: 'octo', repo: 'repo', projectNumber: 7, execGh });
    assert.equal(result.fields.length, 2);

    const repeat1 = ownerFieldsResponse([{ id: 'PVTF_1', name: 'A', dataType: 'TEXT' }], true, 'cursor-1');
    const repeat2 = ownerFieldsResponse([{ id: 'PVTF_1', name: 'A', dataType: 'TEXT' }], true, 'cursor-1');
    const seqRepeat = { repository: [repositoryResponse()], fields: [repeat1, repeat2] };
    const { execGh: execGhRepeat } = makeExecGh(seqRepeat);
    const resultRepeat = readBootstrapRemoteState({ cwd: '/repo', owner: 'octo', repo: 'repo', projectNumber: 7, execGh: execGhRepeat });
    assert.equal(resultRepeat.available, false);
  });

  test('a malformed payload at any level collapses to the unavailable result and never throws', () => {
    const cases = [
      envelope({ repositoryOwner: { projectV2: { fields: { nodes: 'not-an-array', pageInfo: { hasNextPage: false, endCursor: null } } } } }),
      { errors: [{ message: 'boom' }] },
      'not json',
    ];
    for (const body of cases) {
      const seq = { repository: [repositoryResponse()], fields: [typeof body === 'string' ? body : body] };
      const { execGh } = makeExecGh(seq);
      assert.doesNotThrow(() => {
        const result = readBootstrapRemoteState({ cwd: '/repo', owner: 'octo', repo: 'repo', projectNumber: 7, execGh });
        assert.equal(result.available, false);
      });
    }
  });

  test('an absent project (repositoryOwner or projectV2 resolves to null) reports the absent outcome, an available read', () => {
    const seq = { repository: [repositoryResponse()], fields: [envelope({ repositoryOwner: null })] };
    const { execGh } = makeExecGh(seq);
    const result = readBootstrapRemoteState({ cwd: '/repo', owner: 'octo', repo: 'repo', projectNumber: 999, execGh });
    assert.equal(result.available, true);
    assert.equal(result.projectOutcome, PROJECT_OUTCOME.ABSENT);
  });

  test('a real slurped multi-page label list is decoded and attached to the snapshot alongside the existing project/fields data', () => {
    const seq = { repository: [repositoryResponse()], fields: [ownerFieldsResponse([])], labels: [repoObjectsFixture.multiPageLabelsList] };
    const { execGh } = makeExecGh(seq);
    const result = readBootstrapRemoteState({ cwd: '/repo', owner: 'octo', repo: 'repo', projectNumber: 7, execGh });
    assert.equal(result.available, true);
    assert.equal(result.labels.length, repoObjectsFixture.multiPageLabelsList.flat().length);
    assert.equal(result.milestones.length, 0);
  });

  test('a REST-unavailable label read marks the whole snapshot unavailable rather than yielding an empty list', () => {
    const seq = {
      repository: [repositoryResponse()],
      fields: [ownerFieldsResponse([])],
      labels: [{ not: 'an array' }],
    };
    const { execGh } = makeExecGh(seq);
    const result = readBootstrapRemoteState({ cwd: '/repo', owner: 'octo', repo: 'repo', projectNumber: 7, execGh });
    assert.equal(result.available, false);
    assert.equal(result.reason, BOOTSTRAP_REMOTE_REASON.REST_UNAVAILABLE);
  });
});

// ─── restPath / readRepoLabels / readRepoMilestones (Task 2, REST reads) ──

function restExecGh(bodies) {
  const calls = [];
  return {
    calls,
    execGh(args, opts) {
      calls.push({ args, opts });
      const next = bodies.shift();
      if (next === undefined) throw new Error('no scripted REST response');
      if (next.exitCode !== undefined) return next;
      return { exitCode: 0, reason: 'ok', stderr: '', stdout: JSON.stringify(next) };
    },
  };
}

describe('restPath', () => {
  test('returns the repos path with the two real UAT values appearing literally, for the labels suffix', () => {
    assert.equal(restPath('drungrin', 'gsd-core', '/labels'), 'repos/drungrin/gsd-core/labels');
    assert.equal(restPath('drungrin', 'gsd-core', '/milestones'), 'repos/drungrin/gsd-core/milestones');
  });

  test('returns null, never invoking execGh, for a brace, a slash, an at-sign, a space, and the empty string on the owner', () => {
    for (const owner of ['{owner}', 'owner/evil', '@owner', 'owner name', '']) {
      assert.equal(restPath(owner, 'repo', '/labels'), null);
    }
  });

  test('returns null, never invoking execGh, for the same five hostile values on the repo', () => {
    for (const repo of ['{repo}', 'repo/evil', '@repo', 'repo name', '']) {
      assert.equal(restPath('owner', repo, '/labels'), null);
    }
  });

  test('the literal three-character brace-owner token never reaches execGh', () => {
    let called = false;
    const result = readRepoLabels({ cwd: '/repo', owner: '{owner}', repo: 'repo', execGh: () => { called = true; throw new Error('must not call execGh'); } });
    assert.equal(called, false);
    assert.equal(result.available, false);
    assert.equal(result.reason, BOOTSTRAP_REMOTE_REASON.UNSAFE_TARGET);
  });
});

describe('readRepoLabels', () => {
  test('passes an explicit page size of 100, the paginate and slurp flags, and includeHeaders false, in a single execGh call', () => {
    const { execGh, calls } = restExecGh([[[]]]);
    readRepoLabels({ cwd: '/repo', owner: 'octo', repo: 'repo', execGh });
    assert.equal(calls.length, 1);
    const { args, opts } = calls[0];
    assert.ok(args.includes('-f'));
    assert.equal(args[args.indexOf('per_page=100') - 1], '-f');
    assert.ok(args.includes('--paginate'));
    assert.ok(args.includes('--slurp'));
    assert.equal(opts.includeHeaders, false);
  });

  test('a real slurped multi-page label body flattens to the sum of every page, in first-page-then-second-page order, from exactly one execGh call', () => {
    const { execGh, calls } = restExecGh([repoObjectsFixture.multiPageLabelsList]);
    const result = readRepoLabels({ cwd: '/repo', owner: 'octo', repo: 'repo', execGh });
    assert.equal(calls.length, 1);
    assert.equal(result.available, true);
    const expectedNames = repoObjectsFixture.multiPageLabelsList.flat().map((l) => l.name);
    assert.deepEqual(result.entries.map((e) => e.name), expectedNames);
  });

  test('a real single-page label body (still slurp-wrapped in one outer array) decodes to the same entry count', () => {
    const { execGh } = restExecGh([repoObjectsFixture.singlePageLabelsList]);
    const result = readRepoLabels({ cwd: '/repo', owner: 'octo', repo: 'repo', execGh });
    assert.equal(result.available, true);
    assert.equal(result.entries.length, repoObjectsFixture.singlePageLabelsList.flat().length);
  });

  test('an array of one empty array decodes to an available result with zero entries — not conflated with an unavailable read', () => {
    const { execGh } = restExecGh([repoObjectsFixture.emptyLabelsList]);
    const result = readRepoLabels({ cwd: '/repo', owner: 'octo', repo: 'repo', execGh });
    assert.equal(result.available, true);
    assert.deepEqual(result.entries, []);
  });

  test('a flat array of objects (the un-nested single-page shape some gh versions return) is also accepted', () => {
    const flat = repoObjectsFixture.multiPageLabelsList.flat();
    const { execGh } = restExecGh([flat]);
    const result = readRepoLabels({ cwd: '/repo', owner: 'octo', repo: 'repo', execGh });
    assert.equal(result.available, true);
    assert.equal(result.entries.length, flat.length);
  });

  test('every decoded label entry exposes a non-empty node id string', () => {
    const { execGh } = restExecGh([repoObjectsFixture.multiPageLabelsList]);
    const result = readRepoLabels({ cwd: '/repo', owner: 'octo', repo: 'repo', execGh });
    for (const entry of result.entries) {
      assert.equal(typeof entry.nodeId, 'string');
      assert.ok(entry.nodeId.length > 0);
    }
  });

  test('an object body, a non-zero exit, and unparseable JSON each yield the REST-unavailable reason with no thrown error', () => {
    const cases = [
      { not: 'an array' },
      { exitCode: 1, reason: 'gh_exit_nonzero', stdout: '', stderr: 'boom' },
      'not json',
    ];
    for (const body of cases) {
      const { execGh } = restExecGh([body]);
      assert.doesNotThrow(() => {
        const result = readRepoLabels({ cwd: '/repo', owner: 'octo', repo: 'repo', execGh });
        assert.equal(result.available, false);
        assert.equal(result.reason, BOOTSTRAP_REMOTE_REASON.REST_UNAVAILABLE);
      });
    }
  });
});

describe('readRepoMilestones', () => {
  test('the request includes the all-states parameter alongside the explicit page size', () => {
    const { execGh, calls } = restExecGh([[[]]]);
    readRepoMilestones({ cwd: '/repo', owner: 'octo', repo: 'repo', execGh });
    const { args } = calls[0];
    assert.equal(args[args.indexOf('state=all') - 1], '-f');
    assert.equal(args[args.indexOf('per_page=100') - 1], '-f');
  });

  test('a real milestone list carrying both an open and a closed entry decodes both, each with its own number and state', () => {
    const { execGh } = restExecGh([repoObjectsFixture.milestonesBothStatesList]);
    const result = readRepoMilestones({ cwd: '/repo', owner: 'octo', repo: 'repo', execGh });
    assert.equal(result.available, true);
    assert.deepEqual(result.entries.map((e) => e.state).sort(), ['closed', 'open']);
    for (const entry of result.entries) {
      assert.equal(typeof entry.number, 'number');
      assert.ok(entry.number > 0);
    }
  });

  test('an empty milestone list (a real capture: the repository carried zero milestones) decodes to an available, zero-entry result', () => {
    const { execGh } = restExecGh([repoObjectsFixture.emptyMilestonesList]);
    const result = readRepoMilestones({ cwd: '/repo', owner: 'octo', repo: 'repo', execGh });
    assert.equal(result.available, true);
    assert.deepEqual(result.entries, []);
  });
});

describe('bootstrap-repo-objects.json fixture', () => {
  test('provenance names the repository, the capture date, and the gh version', () => {
    assert.match(repoObjectsFixture.provenance, /drungrin\/gsd-core/);
    assert.match(repoObjectsFixture.provenance, /2026-08-02/);
    assert.match(repoObjectsFixture.provenance, /2\.96\.0/);
  });

  test('the label-already-exists 422 body decodes as GitHub\'s already-exists error shape (Task 3\'s conflict recovery input)', () => {
    assert.equal(repoObjectsFixture.labelAlreadyExists422Body.errors[0].code, 'already_exists');
  });

  test('the milestone-already-exists 422 body decodes as GitHub\'s already-exists error shape too', () => {
    assert.equal(repoObjectsFixture.milestoneAlreadyExists422Body.errors[0].code, 'already_exists');
  });
});

// ─── the five bootstrap document guards (a bootstrap-local capture harness) ─
//
// A sibling of tests/github-sync-remote.test.cjs's DOCUMENTS schema contract,
// scoped to the two documents this module owns. Not added to Phase 2's own
// contract fixture/harness (D-24 / HIGH-15): that harness's Guard 1 is a
// two-way assertion against a hardcoded five-name capture list and cannot
// accommodate new document names without breaking Phase 2's own suite.

const bootstrapContract = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/github-sync/bootstrap-graphql-documents-contract.json'), 'utf8'),
);

/**
 * Drives a full readBootstrapRemoteState run and returns a Map of document
 * name -> dispatched query text. `createProject`/`linkProjectToRepository`
 * are never dispatched by readBootstrapRemoteState itself (planProject emits
 * them as MutationOperations, applied later by applyMutationPlan) — they are
 * captured here from planProject's own emitted operation args, in the
 * create-path scenario, so Guard 1's completeness check still sees all four
 * contract-registered document names. Plan 06-01 Task 2: `views` IS
 * dispatched by readBootstrapRemoteState itself (unconditionally, on every
 * resolved-project read) and is captured the same way `repository`/
 * `fieldsWithTypes` are; `createViewWithFields`/`updateViewShapeWithFilter`
 * are captured from planViews' own emitted operations, mirroring the
 * planFields/planProject precedent above.
 */
function captureDispatchedBootstrapDocuments() {
  const documents = new Map();
  readBootstrapRemoteState({
    cwd: '/tmp', owner: 'octo', repo: 'example', projectNumber: 7,
    execGh(args) {
      const query = args.find((arg) => arg.startsWith('query='));
      // Task 2's REST label/milestone reads carry no `query=` argv entry at
      // all — they are not GraphQL documents and are out of scope for this
      // GraphQL-only document-contract harness (Guard 1 below asserts
      // completeness over BOOTSTRAP_DOCUMENTS, not over every execGh call).
      if (!query) return { exitCode: 0, reason: 'ok', stderr: '', stdout: JSON.stringify([[]]) };
      const name = ['repository', 'fieldsWithTypes', 'views'].find((candidate) => query.includes(`github-sync-bootstrap:${candidate}`));
      if (name && !documents.has(name)) documents.set(name, query.slice('query='.length));
      if (name === 'repository') {
        return {
          exitCode: 0, reason: 'ok', stderr: '',
          stdout: JSON.stringify({ data: { repository: { id: 'R_1', owner: { id: 'O_1', login: 'octo' }, projectsV2: { nodes: [{ number: 7 }], pageInfo: { hasNextPage: false, endCursor: null } } } } }),
        };
      }
      if (name === 'views') {
        return {
          exitCode: 0, reason: 'ok', stderr: '',
          stdout: JSON.stringify(bootstrapViewsFixture.viewsReadResponse),
        };
      }
      return {
        exitCode: 0, reason: 'ok', stderr: '',
        stdout: JSON.stringify({ data: { repositoryOwner: { projectV2: { id: 'PVT_contract', fields: { nodes: [{ id: 'PVTF_1', name: 'Status', dataType: 'SINGLE_SELECT', options: [] }], pageInfo: { hasNextPage: false, endCursor: null } } } } } }),
      };
    },
  });

  const createPathPlan = planProject(
    { available: true, projectOutcome: 'unset', repository: { nodeId: 'R_1', ownerNodeId: 'O_1', ownerLogin: 'octo', linkState: null }, projectNodeId: null, statusField: null },
    { kind: 'absent' },
    { owner: 'octo', repo: 'example', repositoryNumber: 1, projectNumber: null },
    null,
    { owner: 'octo', repo: 'example', repositoryNumber: 1 },
  );
  for (const operation of createPathPlan.operations) {
    const query = operation.args.find((arg) => typeof arg === 'string' && arg.startsWith('query='));
    const name = ['createProject', 'linkProjectToRepository'].find((candidate) => query.includes(`github-sync-bootstrap:${candidate}`));
    if (name && !documents.has(name)) documents.set(name, query.slice('query='.length));
  }

  // plan 03-04 Task 2: createFieldText/createFieldNumber/createFieldSingleSelect
  // are captured from planFields' create-path plan (an empty field list, so
  // all five GSD fields — including the SINGLE_SELECT Autonomous — create);
  // renameField is captured from a rename-path plan (a field matched by
  // stored id whose remote name differs from its canonical GSD name).
  const fieldsCreatePathPlan = planFields(
    { available: true, projectOutcome: 'resolved', statusField: null, fields: [] },
    { kind: 'absent' },
    { owner: 'octo', repo: 'example', repositoryNumber: 1 },
  );
  const fieldsRenamePathPlan = planFields(
    { available: true, projectOutcome: 'resolved', statusField: null, fields: [{ id: 'F_old', name: 'Old Name', dataType: 'TEXT', options: null }] },
    { kind: 'valid', map: { completions: { [BOOTSTRAP_LOGICAL_KEY.field('GSD ID')]: { nodeId: 'F_old' } } } },
    { owner: 'octo', repo: 'example', repositoryNumber: 1 },
  );
  for (const operation of [...fieldsCreatePathPlan.operations, ...fieldsRenamePathPlan.operations]) {
    const query = operation.args.find((arg) => typeof arg === 'string' && arg.startsWith('query='));
    const name = ['createFieldText', 'createFieldNumber', 'createFieldSingleSelect', 'renameField']
      .find((candidate) => query.includes(`github-sync-bootstrap:${candidate}`));
    if (name && !documents.has(name)) documents.set(name, query.slice('query='.length));
  }

  // plan 06-01 Task 2: createViewWithFields/updateViewShapeWithFilter are
  // captured from planViews' own create-path plan against every D-08 view
  // present (fields carrying Phase/Wave/Status so Table-by-Phase/By-Wave
  // resolve too, not just Backlog) — an empty views list, so every view
  // creates.
  //
  // plan 06-02 Task 1: createView/updateViewShape (the configuration-free
  // pair) are captured the same way — createView from THIS SAME create-path
  // plan (Roadmap/Board have no filter/fields, so their create routes
  // through the bare document), updateShape from a second, repair-path plan
  // holding a matched-but-diverged Roadmap (the D-01 resolve-by-id-restore
  // branch, with no filter/fields to trigger the WITH_FILTER document).
  const viewsCreatePathPlan = planViews(
    {
      available: true, projectOutcome: 'resolved', statusField: null,
      fields: [
        { id: 'PVTF_phase_1', name: 'Phase', dataType: 'TEXT', options: null },
        { id: 'PVTF_wave_1', name: 'Wave', dataType: 'NUMBER', options: null },
        { id: 'PVTSSF_1', name: 'Status', dataType: 'SINGLE_SELECT', options: [] },
      ],
      views: [],
    },
    { kind: 'absent' },
    { owner: 'octo', repo: 'example', repositoryNumber: 1 },
  );
  const viewsRepairPathPlan = planViews(
    {
      available: true, projectOutcome: 'resolved', statusField: null,
      fields: [{ id: 'PVTSSF_1', name: 'Status', dataType: 'SINGLE_SELECT', options: [] }],
      views: [{ id: 'PVTV_roadmap_h', name: 'Roadmap', layout: 'BOARD_LAYOUT', filter: null }],
    },
    { kind: 'absent' },
    { owner: 'octo', repo: 'example', repositoryNumber: 1 },
  );
  // Longer names first: 'createView'/'updateViewShape' are prefixes of
  // 'createViewWithFields'/'updateViewShapeWithFilter', so a shorter
  // candidate checked first would false-positive-match the longer query via
  // `.includes`.
  const viewDocumentNames = ['createViewWithFields', 'createView', 'updateViewShapeWithFilter', 'updateViewShape'];
  for (const operation of [...viewsCreatePathPlan.operations, ...viewsRepairPathPlan.operations]) {
    const query = operation.args.find((arg) => typeof arg === 'string' && arg.startsWith('query='));
    const name = viewDocumentNames.find((candidate) => query.includes(`github-sync-bootstrap:${candidate}`));
    if (name && !documents.has(name)) documents.set(name, query.slice('query='.length));
  }

  return documents;
}

/** Balanced-brace body of the first `{ ... }` block following `anchor` in `query`. */
function extractBody(query, anchor) {
  const anchorIndex = query.indexOf(anchor);
  if (anchorIndex === -1) return null;
  const braceStart = query.indexOf('{', anchorIndex);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < query.length; i++) {
    if (query[i] === '{') depth++;
    else if (query[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  return query.slice(braceStart + 1, end);
}

/** Depth-zero identifiers of `text` — does not descend into a nested `{ ... }` selection set. */
function collectDepthZeroFieldNames(text) {
  const names = [];
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') { depth--; i++; continue; }
    if (depth === 0 && /[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
      names.push(text.slice(i, j));
      i = j;
      continue;
    }
    i++;
  }
  return names;
}

/** Depth-zero balanced-brace scan collecting every `... on Type { fields }` inline fragment inside `body`. */
function collectInlineFragments(body) {
  const fragments = [];
  const fragmentRe = /\.\.\.\s*on\s+(\w+)\s*\{/g;
  let match;
  while ((match = fragmentRe.exec(body))) {
    const braceStart = match.index + match[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const inner = body.slice(braceStart + 1, end);
    fragments.push({ target: match[1], fields: collectDepthZeroFieldNames(inner) });
    fragmentRe.lastIndex = end;
  }
  return fragments;
}

describe('bootstrap GraphQL document contract', () => {
  test('completeness (Guard 1): every document actually dispatched has a contract entry, and vice versa', () => {
    const documents = captureDispatchedBootstrapDocuments();
    assert.deepStrictEqual([...documents.keys()].sort(), Object.keys(bootstrapContract.documents).sort());
  });

  test('union safety (Guard 2): the fields selection on the union selects only through recorded inline fragments, never a bare scalar', () => {
    const documents = captureDispatchedBootstrapDocuments();
    const nodesBody = extractBody(documents.get('fieldsWithTypes'), 'nodes');
    const fragments = collectInlineFragments(nodesBody);
    assert.ok(fragments.length > 0, 'fieldsWithTypes must select through at least one inline fragment');
    for (const fragment of fragments) {
      assert.ok(bootstrapContract.documents.fieldsWithTypes.fragmentTargets.includes(fragment.target),
        `unexpected fragment target ${fragment.target}`);
    }
    // Every top-level character in nodesBody must belong to a `... on Type {...}`
    // fragment block — a bare field outside any fragment would be a selection
    // mismatch GitHub's live schema rejects on a union type.
    const withoutFragments = nodesBody.replace(/\.\.\.\s*on\s+\w+\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
    assert.match(withoutFragments.trim(), /^$/, `bare selection found outside any inline fragment: ${JSON.stringify(withoutFragments)}`);
  });

  test('selection parity (Guard 3): the union of both fragments\' field names equals the recorded selects list', () => {
    const documents = captureDispatchedBootstrapDocuments();
    const nodesBody = extractBody(documents.get('fieldsWithTypes'), 'nodes');
    const fragments = collectInlineFragments(nodesBody);
    const allFields = new Set();
    for (const fragment of fragments) for (const field of fragment.fields) allFields.add(field);
    assert.deepStrictEqual([...allFields].sort(), [...bootstrapContract.documents.fieldsWithTypes.selects].sort());
  });

  test('pagination (Guard 4): fieldsWithTypes selects pageInfo { hasNextPage endCursor }', () => {
    const documents = captureDispatchedBootstrapDocuments();
    const query = documents.get('fieldsWithTypes');
    const pageInfoBody = extractBody(query, 'pageInfo');
    assert.ok(pageInfoBody, 'fieldsWithTypes must select pageInfo');
    const fields = [...pageInfoBody.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => m[0]);
    assert.deepStrictEqual(fields.sort(), ['endCursor', 'hasNextPage']);
  });

  test('fixture parity (Guard 5): the recorded live fixture\'s Status field node carries only keys within the recorded selection', () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/github-sync/bootstrap-status-options.json'), 'utf8'));
    const statusNode = fixture.fieldsWithTypesResponseAfterInit.data.repositoryOwner.projectV2.fields.nodes[0];
    const keys = Object.keys(statusNode);
    for (const key of keys) {
      assert.ok(bootstrapContract.documents.fieldsWithTypes.selects.includes(key), `fixture key ${key} drifted from the recorded selection`);
    }
  });

  // ─── the same five guards, applied to the `views` document (plan 06-01 ──
  // Task 2) — the first `nodeKind: "OBJECT"` paginated entry in this
  // contract, so Guard 2 here proves the NEGATIVE: no fragment is required.

  test('completeness (Guard 1, views-specific): the views document is dispatched by readBootstrapRemoteState itself and carries the orderBy:POSITION argument', () => {
    const documents = captureDispatchedBootstrapDocuments();
    assert.ok(documents.has('views'), 'views must be captured as an actually-dispatched document');
    assert.match(documents.get('views'), /orderBy:\{field:POSITION,\s*direction:ASC\}/);
  });

  test('union safety (Guard 2, views): a concrete OBJECT node type selects bare scalars directly, with no inline fragment required or present', () => {
    const documents = captureDispatchedBootstrapDocuments();
    const nodesBody = extractBody(documents.get('views'), 'nodes');
    assert.ok(nodesBody, 'views must select a nodes block');
    assert.equal(collectInlineFragments(nodesBody).length, 0, 'an OBJECT type needs no inline fragment');
    assert.equal(bootstrapContract.documents.views.nodeKind, 'OBJECT');
    assert.deepEqual(bootstrapContract.documents.views.fragmentTargets, []);
  });

  test('selection parity (Guard 3, views): the bare scalar selection inside nodes equals the recorded selects list, minus the nested pageInfo block', () => {
    const documents = captureDispatchedBootstrapDocuments();
    const nodesBody = extractBody(documents.get('views'), 'nodes');
    const fieldNames = collectDepthZeroFieldNames(nodesBody);
    assert.deepStrictEqual(fieldNames.sort(), [...bootstrapContract.documents.views.selects].sort());
  });

  test('pagination (Guard 4, views): the views document selects pageInfo { hasNextPage endCursor } AND carries orderBy:{field:POSITION,direction:ASC} (RESEARCH Pitfall 1)', () => {
    const documents = captureDispatchedBootstrapDocuments();
    const query = documents.get('views');
    const pageInfoBody = extractBody(query, 'pageInfo');
    assert.ok(pageInfoBody, 'views must select pageInfo');
    const fields = [...pageInfoBody.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => m[0]);
    assert.deepStrictEqual(fields.sort(), ['endCursor', 'hasNextPage']);
    assert.match(query, /orderBy:\{field:POSITION,\s*direction:ASC\}/);
  });

  test('fixture parity (Guard 5, views): every key on the live-captured views node falls within the recorded selects list', () => {
    const viewNode = bootstrapViewsFixture.viewsReadResponse.data.repositoryOwner.projectV2.views.nodes[0];
    const keys = Object.keys(viewNode);
    for (const key of keys) {
      assert.ok(bootstrapContract.documents.views.selects.includes(key), `fixture key ${key} drifted from the recorded selection`);
    }
  });

  test('deliberately dropping the orderBy argument from BOOTSTRAP_DOCUMENTS.views would fail Guard 1/4\'s orderBy assertions (verifies the guard actually detects the regression it exists for)', () => {
    // A direct fail-first control on the live production document text
    // itself, not merely the harness: this does not mutate the module, it
    // just proves the regex the two guards above depend on is not
    // vacuously true against text that lacks the argument.
    const withoutOrderBy = BOOTSTRAP_DOCUMENTS.views.replace(/,orderBy:\{field:POSITION,direction:ASC\}/, '');
    assert.doesNotMatch(withoutOrderBy, /orderBy:\{field:POSITION,\s*direction:ASC\}/);
    assert.match(BOOTSTRAP_DOCUMENTS.views, /orderBy:\{field:POSITION,\s*direction:ASC\}/);
  });

  test('the merged-write mutation string carries the updateSingleSelectOptions comment tag', () => {
    // The mutation document itself lives in github-sync-bootstrap-plan.cts; a
    // plain smoke assertion against the module's exported query text via
    // planStatusOptionMerge keeps this file scoped to the remote reader while
    // still pinning the tag the contract fixture's provenance references.
    const result = planStatusOptionMerge(
      { available: true, projectOutcome: 'resolved', statusField: { id: 'PVTF_status', name: 'Status', dataType: 'SINGLE_SELECT', options: [] } },
      { kind: 'absent' },
      { owner: 'octo', repo: 'repo', repositoryNumber: 1 },
    );
    const query = result.operation.args.find((arg) => typeof arg === 'string' && arg.startsWith('query='));
    assert.match(query, /github-sync-bootstrap:updateSingleSelectOptions/);
  });
});
