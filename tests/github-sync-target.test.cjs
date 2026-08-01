'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readSyncTarget, SYNC_TARGET_REASON } = require('../gsd-core/bin/lib/github-sync-target.cjs');

function withConfig(config, run) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'github-sync-target-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify(config), 'utf8');
  try { run(cwd); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
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
  // G-02-4: readSyncTarget now also reports which field it blames (Task 1
  // wires `repository_number` precisely; every other rejection still routes
  // through the generic `target` fallback until the next task fans the rest
  // out). The accept/reject decision itself is unchanged from before this
  // field discriminator existed.
  for (const [config, field] of [
    [{}, 'target'],
    [{ github_sync: { target: { owner: 'octo', repo: 'example', repository_number: 42, project_number: 7, extra: true } } }, 'target'],
    [{ github_sync: { target: { owner: '', repo: 'example', repository_number: 1, project_number: 1 } } }, 'target'],
    [{ github_sync: { target: { owner: 'octo', repo: 'example', repository_number: 0, project_number: 1 } } }, 'repository_number'],
  ]) {
    withConfig(config, (cwd) => {
      assert.deepEqual(readSyncTarget(cwd), { available: false, reason: SYNC_TARGET_REASON.UNAVAILABLE, field });
    });
  }
});
