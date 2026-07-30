/*
 * Offline safety tests for the repository-scoped GitHub sync checkpoint map.
 * Each test uses a fresh temporary repository root; no GitHub credentials or
 * remote payloads are involved.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');

const mapMod = require('../gsd-core/bin/lib/github-sync-map.cjs');
const { readSyncMapStrict, SYNC_MAP_FILE_NAME } = mapMod;

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
  writeMap(repoDir, {
    version: '1',
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
    completions: {
      'phase:02': makeCompletion({ token: 'ghp_secret' }),
    },
  });

  const result = readSyncMapStrict(repoDir, REPOSITORY);

  assert.deepEqual(result, { kind: 'blocking', reason: 'invalid_schema' });
});
