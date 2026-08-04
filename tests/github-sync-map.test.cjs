/*
 * Offline safety tests for the repository-scoped GitHub sync checkpoint map.
 * Each test uses a fresh temporary repository root; no GitHub credentials or
 * remote payloads are involved.
 */

'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');

const mapMod = require('../gsd-core/bin/lib/github-sync-map.cjs');
const { readSyncMapStrict, recordCompletion, writeSyncMapAtomically, mergeCompletion, SYNC_MAP_FILE_NAME, ISSUE_STATE } = mapMod;

const REPOSITORY = { owner: 'open-gsd', repo: 'gsd-core', number: 42 };

function mapPath(repoDir) {
  return path.join(repoDir, '.planning', SYNC_MAP_FILE_NAME);
}

function makeCompletion(overrides = {}) {
  return {
    logicalKey: 'phase:02',
    nodeId: 'PVT_kwDOExample',
    issueNumber: 17,
    completedAt: '2026-07-30T20:00:00.000Z',
    owner: REPOSITORY.owner,
    repo: REPOSITORY.repo,
    repositoryNumber: REPOSITORY.number,
    ...overrides,
  };
}

function writeMap(repoDir, document) {
  fs.mkdirSync(path.dirname(mapPath(repoDir)), { recursive: true });
  fs.writeFileSync(mapPath(repoDir), JSON.stringify(document, null, 2));
}

function makeMap(completions = {}) {
  return { version: '1', repository: REPOSITORY, completions };
}

test('readSyncMapStrict reports an absent map explicitly', (t) => {
  const repoDir = createTempDir('github-sync-map-absent-');
  t.after(() => cleanup(repoDir));

  assert.deepEqual(readSyncMapStrict(repoDir, REPOSITORY), { kind: 'absent' });
});

test('readSyncMapStrict returns a valid map bound to the requested repository', (t) => {
  const repoDir = createTempDir('github-sync-map-valid-');
  t.after(() => cleanup(repoDir));
  writeMap(repoDir, {
    version: '1',
    repository: REPOSITORY,
    completions: { 'phase:02': makeCompletion() },
  });

  const result = readSyncMapStrict(repoDir, REPOSITORY);

  assert.equal(result.kind, 'valid');
  assert.deepEqual(result.map.completions['phase:02'], makeCompletion());
});

test('readSyncMapStrict blocks malformed and unsupported map state without replacing it', (t) => {
  const repoDir = createTempDir('github-sync-map-invalid-');
  t.after(() => cleanup(repoDir));
  writeMap(repoDir, { version: '2', completions: {} });
  const before = fs.readFileSync(mapPath(repoDir), 'utf8');

  const result = readSyncMapStrict(repoDir, REPOSITORY);

  assert.equal(result.kind, 'blocking');
  assert.equal(result.reason, 'unsupported_version');
  assert.equal(fs.readFileSync(mapPath(repoDir), 'utf8'), before);
});

test('readSyncMapStrict blocks a map for another repository', (t) => {
  const repoDir = createTempDir('github-sync-map-foreign-');
  t.after(() => cleanup(repoDir));
  const foreignRepository = { ...REPOSITORY, repo: 'other-repo' };
  writeMap(repoDir, {
    version: '1',
    repository: foreignRepository,
    completions: { 'phase:02': makeCompletion({ repo: 'other-repo' }) },
  });

  const result = readSyncMapStrict(repoDir, REPOSITORY);

  assert.deepEqual(result, { kind: 'blocking', reason: 'repository_mismatch' });
});

test('readSyncMapStrict rejects credential-shaped and unknown values before use', (t) => {
  const repoDir = createTempDir('github-sync-map-closed-');
  t.after(() => cleanup(repoDir));
  writeMap(repoDir, {
    version: '1',
    repository: REPOSITORY,
    completions: {
      'phase:02': makeCompletion({ token: 'ghp_secret' }),
    },
  });

  const result = readSyncMapStrict(repoDir, REPOSITORY);

  assert.deepEqual(result, { kind: 'blocking', reason: 'invalid_schema' });
});

test('recordCompletion rejects credential and GraphQL payload-shaped inputs before persistence', () => {
  assert.throws(() => recordCompletion(null, makeCompletion({ token: 'ghp_secret' })), /Cannot record/);
  assert.throws(() => recordCompletion(null, makeCompletion({ data: { viewer: { login: 'octo' } } })), /Cannot record/);
  assert.throws(() => recordCompletion(null, makeCompletion({ errors: [{ message: 'captured GraphQL error' }] })), /Cannot record/);
});

test('an actual persisted map contains only repository identity and strict completion fields', (t) => {
  const repoDir = createTempDir('github-sync-map-persisted-closed-');
  t.after(() => cleanup(repoDir));
  writeSyncMapAtomically(repoDir, recordCompletion(null, makeCompletion()));

  const document = JSON.parse(fs.readFileSync(mapPath(repoDir), 'utf8'));
  assert.deepEqual(Object.keys(document).sort(), ['completions', 'repository', 'version']);
  assert.deepEqual(Object.keys(document.repository).sort(), ['number', 'owner', 'repo']);
  assert.deepEqual(Object.keys(document.completions['phase:02']).sort(), [
    'completedAt', 'issueNumber', 'logicalKey', 'nodeId', 'owner', 'repo', 'repositoryNumber',
  ]);
});

test('recordCompletion returns the next complete map without mutating the prior checkpoint', () => {
  const prior = makeMap({ 'phase:01': makeCompletion({ logicalKey: 'phase:01' }) });

  const next = recordCompletion(prior, makeCompletion());

  assert.deepEqual(Object.keys(next.completions), ['phase:01', 'phase:02']);
  assert.deepEqual(Object.keys(prior.completions), ['phase:01']);
  assert.equal(next.completions['phase:02'].nodeId, 'PVT_kwDOExample');
});

test('recordCompletion creates a repository-bound map from absent state', () => {
  const next = recordCompletion(null, makeCompletion());

  assert.deepEqual(next, makeMap({ 'phase:02': makeCompletion() }));
});

for (const fault of ['writeFileSync', 'fsyncSync', 'closeSync', 'renameSync']) {
  test(`writeSyncMapAtomically preserves the installed map when ${fault} fails`, (t) => {
    const repoDir = createTempDir(`github-sync-map-${fault}-`);
    t.after(() => cleanup(repoDir));
    t.after(() => mock.restoreAll());
    const prior = makeMap({ 'phase:01': makeCompletion({ logicalKey: 'phase:01' }) });
    writeMap(repoDir, prior);
    const next = recordCompletion(prior, makeCompletion());
    const original = fs[fault];
    mock.method(fs, fault, (...args) => {
      if (fault === 'renameSync' || args[0] !== mapPath(repoDir)) {
        const error = new Error(`injected ${fault} failure`);
        error.code = 'EIO';
        throw error;
      }
      return original.apply(fs, args);
    });

    assert.throws(() => writeSyncMapAtomically(repoDir, next), /injected/);
    assert.deepEqual(JSON.parse(fs.readFileSync(mapPath(repoDir), 'utf8')), prior);
    assert.deepEqual(
      fs.readdirSync(path.dirname(mapPath(repoDir))).filter((name) => name.includes('.tmp.')),
      [],
      'failed writes must clean up their same-directory temporary map',
    );
  });
}

// ─── plan 04-03 Task 3: contentHash / fieldState widened schema ───────────

test('a completion carrying contentHash and fieldState validates and round-trips through an atomic write and a strict read', (t) => {
  const repoDir = createTempDir('github-sync-map-contenthash-');
  t.after(() => cleanup(repoDir));
  const completion = makeCompletion({ contentHash: 'abc123', fieldState: '{"status":"Todo"}' });
  writeSyncMapAtomically(repoDir, recordCompletion(null, completion));

  const result = readSyncMapStrict(repoDir, REPOSITORY);

  assert.equal(result.kind, 'valid');
  assert.equal(result.map.completions['phase:02'].contentHash, 'abc123');
  assert.equal(result.map.completions['phase:02'].fieldState, '{"status":"Todo"}');
});

test('a completion carrying an unknown key is still rejected as invalid schema — the allow-list is widened, not removed', (t) => {
  const repoDir = createTempDir('github-sync-map-unknown-key-');
  t.after(() => cleanup(repoDir));
  writeMap(repoDir, {
    version: '1',
    repository: REPOSITORY,
    completions: { 'phase:02': makeCompletion({ bogusKey: 'nope' }) },
  });

  const result = readSyncMapStrict(repoDir, REPOSITORY);

  assert.deepEqual(result, { kind: 'blocking', reason: 'invalid_schema' });
});

test('a map file written before this change, carrying neither contentHash nor fieldState, still reads as valid with the version constant unchanged', (t) => {
  const repoDir = createTempDir('github-sync-map-pre-change-');
  t.after(() => cleanup(repoDir));
  writeMap(repoDir, makeMap({ 'phase:02': makeCompletion() }));

  const result = readSyncMapStrict(repoDir, REPOSITORY);

  assert.equal(result.kind, 'valid');
  assert.equal(result.map.version, '1');
});

test('a completion whose contentHash is present but not a string is rejected', (t) => {
  const repoDir = createTempDir('github-sync-map-bad-contenthash-');
  t.after(() => cleanup(repoDir));
  writeMap(repoDir, {
    version: '1',
    repository: REPOSITORY,
    completions: { 'phase:02': makeCompletion({ contentHash: 42 }) },
  });

  const result = readSyncMapStrict(repoDir, REPOSITORY);

  assert.deepEqual(result, { kind: 'blocking', reason: 'invalid_schema' });
});

test('a completion whose fieldState is present but not a string is rejected', (t) => {
  const repoDir = createTempDir('github-sync-map-bad-fieldstate-');
  t.after(() => cleanup(repoDir));
  writeMap(repoDir, {
    version: '1',
    repository: REPOSITORY,
    completions: { 'phase:02': makeCompletion({ fieldState: {} }) },
  });

  const result = readSyncMapStrict(repoDir, REPOSITORY);

  assert.deepEqual(result, { kind: 'blocking', reason: 'invalid_schema' });
});

test('a completion whose contentHash is present but an empty string is rejected — present implies non-empty', (t) => {
  const repoDir = createTempDir('github-sync-map-empty-contenthash-');
  t.after(() => cleanup(repoDir));
  writeMap(repoDir, {
    version: '1',
    repository: REPOSITORY,
    completions: { 'phase:02': makeCompletion({ contentHash: '' }) },
  });

  const result = readSyncMapStrict(repoDir, REPOSITORY);

  assert.deepEqual(result, { kind: 'blocking', reason: 'invalid_schema' });
});

// ─── plan 05-06 Task 3: issueState widened schema ──────────────────────────

test('isCompletion (via readSyncMapStrict): accepts a completion carrying the closed literal and one carrying the open literal', (t) => {
  const repoDir = createTempDir('github-sync-map-issuestate-valid-');
  t.after(() => cleanup(repoDir));
  writeMap(repoDir, makeMap({
    'plan:04-01': makeCompletion({ logicalKey: 'plan:04-01', issueState: ISSUE_STATE.CLOSED }),
  }));

  const result = readSyncMapStrict(repoDir, REPOSITORY);
  assert.equal(result.kind, 'valid');
  assert.equal(result.map.completions['plan:04-01'].issueState, 'closed');

  const repoDir2 = createTempDir('github-sync-map-issuestate-open-');
  t.after(() => cleanup(repoDir2));
  writeMap(repoDir2, makeMap({
    'plan:04-01': makeCompletion({ logicalKey: 'plan:04-01', issueState: ISSUE_STATE.OPEN }),
  }));
  const result2 = readSyncMapStrict(repoDir2, REPOSITORY);
  assert.equal(result2.kind, 'valid');
  assert.equal(result2.map.completions['plan:04-01'].issueState, 'open');
});

test('isCompletion (via readSyncMapStrict): rejects an issueState carrying any string other than the two literals, a boolean, or a number', (t) => {
  for (const badValue of ['Closed', 'OPEN', 'archived', true, false, 1, 0]) {
    const repoDir = createTempDir('github-sync-map-issuestate-invalid-');
    t.after(() => cleanup(repoDir));
    writeMap(repoDir, makeMap({
      'plan:04-01': makeCompletion({ logicalKey: 'plan:04-01', issueState: badValue }),
    }));
    const result = readSyncMapStrict(repoDir, REPOSITORY);
    assert.deepEqual(result, { kind: 'blocking', reason: 'invalid_schema' }, `expected issueState ${JSON.stringify(badValue)} to be rejected`);
  }
});

test('a completion recorded before this change, with no issueState member at all, still validates and round-trips through recordCompletion', () => {
  const preExisting = makeCompletion();
  assert.equal(Object.prototype.hasOwnProperty.call(preExisting, 'issueState'), false);
  const map = recordCompletion(null, preExisting);
  assert.deepEqual(map.completions['phase:02'], preExisting);
});

test('SYNC_MAP_VERSION is unchanged by the issueState widening', () => {
  assert.equal(mapMod.SYNC_MAP_VERSION, '1');
});

// ─── Plan 07-01 Task 2 (D-08/T-07-03, WINDOWS #9): mergeCompletion's
// field-survival regression. This is the exact bug class that silently wiped
// contentHash twice already (plans 05-05 and 05-06) — a completion written
// through mergeCompletion at a key that already carried other optional
// members must never lose them. ────────────────────────────────────────────

test('mergeCompletion preserves contentHash/fieldState/issueState when a later capture writes only the absence members (D-08 field-survival, WINDOWS #9)', () => {
  const first = makeCompletion({ logicalKey: 'issue:phase:01', contentHash: 'hash-a', fieldState: 'field-a', issueState: ISSUE_STATE.OPEN });
  let map = recordCompletion(null, first);

  const merged = mergeCompletion(map.completions['issue:phase:01'], {
    logicalKey: 'issue:phase:01',
    nodeId: first.nodeId,
    completedAt: '2026-08-01T00:00:00.000Z',
    owner: REPOSITORY.owner,
    repo: REPOSITORY.repo,
    repositoryNumber: REPOSITORY.number,
    absenceCount: 1,
    absenceFirstSeenAt: '2026-08-01T00:00:00.000Z',
  });
  map = recordCompletion(map, merged);

  const recorded = map.completions['issue:phase:01'];
  assert.equal(recorded.contentHash, 'hash-a');
  assert.equal(recorded.fieldState, 'field-a');
  assert.equal(recorded.issueState, ISSUE_STATE.OPEN);
  assert.equal(recorded.absenceCount, 1);
  assert.equal(recorded.absenceFirstSeenAt, '2026-08-01T00:00:00.000Z');
});

test('the reverse also holds: a later contentHash-only capture through mergeCompletion preserves the previously-recorded absence members', () => {
  const first = makeCompletion({ logicalKey: 'issue:phase:02', absenceCount: 2, absenceFirstSeenAt: '2026-08-01T00:00:00.000Z' });
  let map = recordCompletion(null, first);

  const merged = mergeCompletion(map.completions['issue:phase:02'], {
    logicalKey: 'issue:phase:02',
    nodeId: first.nodeId,
    completedAt: '2026-08-02T00:00:00.000Z',
    owner: REPOSITORY.owner,
    repo: REPOSITORY.repo,
    repositoryNumber: REPOSITORY.number,
    contentHash: 'hash-b',
  });
  map = recordCompletion(map, merged);

  const recorded = map.completions['issue:phase:02'];
  assert.equal(recorded.contentHash, 'hash-b');
  assert.equal(recorded.absenceCount, 2);
  assert.equal(recorded.absenceFirstSeenAt, '2026-08-01T00:00:00.000Z');
});

test('mergeCompletion clears exactly the members named in options.clear and nothing else', () => {
  const first = makeCompletion({ logicalKey: 'project', contentHash: 'hash-c', absenceCount: 3, absenceFirstSeenAt: '2026-08-01T00:00:00.000Z' });
  const merged = mergeCompletion(
    first,
    { logicalKey: 'project', nodeId: first.nodeId, completedAt: first.completedAt, owner: first.owner, repo: first.repo, repositoryNumber: first.repositoryNumber },
    { clear: ['absenceCount', 'absenceFirstSeenAt'] },
  );
  assert.equal(merged.contentHash, 'hash-c');
  assert.equal(Object.prototype.hasOwnProperty.call(merged, 'absenceCount'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(merged, 'absenceFirstSeenAt'), false);
});

test('mergeCompletion with no previous completion builds a fresh completion from next alone', () => {
  const next = makeCompletion({ logicalKey: 'project', absenceCount: 1, absenceFirstSeenAt: '2026-08-01T00:00:00.000Z' });
  const merged = mergeCompletion(undefined, next);
  assert.deepEqual(merged, next);
});

test('writeSyncMapAtomically reports directory fsync uncertainty after installing a complete map', (t) => {
  const repoDir = createTempDir('github-sync-map-dir-fsync-');
  t.after(() => cleanup(repoDir));
  t.after(() => mock.restoreAll());
  const prior = makeMap({ 'phase:01': makeCompletion({ logicalKey: 'phase:01' }) });
  writeMap(repoDir, prior);
  const next = recordCompletion(prior, makeCompletion());
  let fsyncCalls = 0;
  const originalFsync = fs.fsyncSync;
  mock.method(fs, 'fsyncSync', (fd) => {
    fsyncCalls += 1;
    if (fsyncCalls === 2) {
      const error = new Error('injected directory fsync failure');
      error.code = 'EIO';
      throw error;
    }
    return originalFsync.call(fs, fd);
  });

  assert.throws(() => writeSyncMapAtomically(repoDir, next), /directory fsync/i);
  assert.deepEqual(JSON.parse(fs.readFileSync(mapPath(repoDir), 'utf8')), next);
});
