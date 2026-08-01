'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { readSyncTarget, SYNC_TARGET_REASON, SYNC_TARGET_FIELD } = require('../gsd-core/bin/lib/github-sync-target.cjs');

function withConfig(config, run) {
  const cwd = createTempDir('github-sync-target-');
  fs.mkdirSync(path.join(cwd, '.planning'));
  fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify(config), 'utf8');
  try { run(cwd); } finally { cleanup(cwd); }
}

// G-02-4: same fixture shape as withConfig, but writes the exact raw text
// given (or no config.json at all when `raw` is undefined) so the config-file
// discriminator ("unreadable or unparseable") can be exercised directly,
// instead of via a JSON.stringify'd object.
function withRawConfig(raw, run) {
  const cwd = createTempDir('github-sync-target-');
  fs.mkdirSync(path.join(cwd, '.planning'));
  if (raw !== undefined) fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), raw, 'utf8');
  try { run(cwd); } finally { cleanup(cwd); }
}

test('readSyncTarget accepts exactly the closed positive github_sync.target identity', () => {
  withConfig({ github_sync: { target: { owner: 'octo', repo: 'example', repository_number: 42, project_number: 7 } } }, (cwd) => {
    assert.deepEqual(readSyncTarget(cwd), {
      available: true,
      reason: SYNC_TARGET_REASON.OK,
      target: { owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 7 },
    });
  });
});

test('readSyncTarget rejects absent, unknown-shaped, and invalid identity without placeholders', () => {
  // G-02-4: readSyncTarget now also reports which field it blames. The
  // accept/reject decision itself is unchanged from before this field
  // discriminator existed — this test only pins the field each rejection
  // reports.
  for (const [config, field] of [
    [{}, 'target'],
    [{ github_sync: { target: { owner: 'octo', repo: 'example', repository_number: 42, project_number: 7, extra: true } } }, 'target'],
    [{ github_sync: { target: { owner: '', repo: 'example', repository_number: 1, project_number: 1 } } }, 'owner'],
    [{ github_sync: { target: { owner: 'octo', repo: 'example', repository_number: 0, project_number: 1 } } }, 'repository_number'],
  ]) {
    withConfig(config, (cwd) => {
      assert.deepEqual(readSyncTarget(cwd), { available: false, reason: SYNC_TARGET_REASON.UNAVAILABLE, field });
    });
  }
});

// ─── G-02-4 (Task 2): the full closed field catalog, in fixed evaluation order ─
//
// Order: an unreadable/unparseable config.json -> `config`; a non-object
// root, a missing/non-object github_sync, a missing/non-object target, or a
// target whose key set isn't exactly the four required keys -> `target`;
// otherwise the first field failing its own validation, checked in the order
// owner, repo, repository_number, project_number -> that field's name.

test('SYNC_TARGET_FIELD is exactly the documented six-value closed catalog', () => {
  assert.deepEqual(Object.values(SYNC_TARGET_FIELD).sort(), ['config', 'owner', 'project_number', 'repo', 'repository_number', 'target']);
});

test('readSyncTarget reports `config` for an absent or unparseable .planning/config.json', () => {
  withRawConfig(undefined, (cwd) => {
    assert.deepEqual(readSyncTarget(cwd), { available: false, reason: SYNC_TARGET_REASON.UNAVAILABLE, field: 'config' });
  });
  withRawConfig('{ this is not valid json', (cwd) => {
    assert.deepEqual(readSyncTarget(cwd), { available: false, reason: SYNC_TARGET_REASON.UNAVAILABLE, field: 'config' });
  });
});

test('readSyncTarget reports `target` for every shape rejection that never reaches a single leaf field', () => {
  for (const config of [
    [], // non-object root (array)
    { github_sync: 'not-an-object' }, // non-object github_sync
    { github_sync: {} }, // missing target
    { github_sync: { target: 'not-an-object' } }, // non-object target
    { github_sync: { target: { owner: 'octo', repo: 'example', repository_number: 42 } } }, // missing a key
    { github_sync: { target: { owner: 'octo', repo: 'example', repository_number: 42, project_number: 7, extra: true } } }, // extra key
  ]) {
    withConfig(config, (cwd) => {
      assert.deepEqual(readSyncTarget(cwd), { available: false, reason: SYNC_TARGET_REASON.UNAVAILABLE, field: 'target' });
    });
  }
});

test('readSyncTarget reports the first invalid leaf field, checked in order owner, repo, repository_number, project_number', () => {
  for (const [config, field] of [
    [{ github_sync: { target: { owner: '', repo: 'example', repository_number: 42, project_number: 7 } } }, 'owner'],
    [{ github_sync: { target: { owner: 'octo', repo: '', repository_number: 42, project_number: 7 } } }, 'repo'],
    [{ github_sync: { target: { owner: 'octo', repo: 'example', repository_number: 0, project_number: 7 } } }, 'repository_number'],
    [{ github_sync: { target: { owner: 'octo', repo: 'example', repository_number: '42', project_number: 7 } } }, 'repository_number'],
    [{ github_sync: { target: { owner: 'octo', repo: 'example', repository_number: 42, project_number: -1 } } }, 'project_number'],
    [{ github_sync: { target: { owner: 'octo', repo: 'example', repository_number: 42, project_number: 0 } } }, 'project_number'],
  ]) {
    withConfig(config, (cwd) => {
      assert.deepEqual(readSyncTarget(cwd), { available: false, reason: SYNC_TARGET_REASON.UNAVAILABLE, field });
    });
  }
});

test('readSyncTarget still accepts the closed positive identity byte-identically (unaffected by the field catalog)', () => {
  withConfig({ github_sync: { target: { owner: 'octo', repo: 'example', repository_number: 42, project_number: 7 } } }, (cwd) => {
    assert.deepEqual(readSyncTarget(cwd), {
      available: true,
      reason: SYNC_TARGET_REASON.OK,
      target: { owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 7 },
    });
  });
});
