/* Offline tests for the authoritative github-sync disk projection. */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');

const { readDesiredState, DESIRED_REASON } = require('../gsd-core/bin/lib/github-sync-desired.cjs');

function write(repoDir, relativePath, content) {
  const target = path.join(repoDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

test('readDesiredState projects roadmap phases and plan metadata in stable order', (t) => {
  const repoDir = createTempDir('github-sync-desired-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', `# Roadmap\n\n### Phase 10: Later\n\n**Goal**: later\n\n### Phase 2: Sync\n\n**Goal**: current\n`);
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 02\n---\n');
  write(repoDir, '.planning/phases/02-sync/02-01-PLAN.md', '---\nwave: 2\nautonomous: true\nrequirements: [SYNC-05]\n---\n');
  write(repoDir, '.planning/phases/02-sync/02-01-SUMMARY.md', '# done\n');

  const result = readDesiredState(repoDir);

  assert.equal(result.available, true);
  assert.equal(result.reason, DESIRED_REASON.OK);
  assert.deepEqual(result.phases.map((phase) => phase.id), ['02', '10']);
  assert.deepEqual(result.plans, [{ id: '02-01', phaseId: '02', wave: 2, autonomous: true, requirements: ['SYNC-05'], complete: true }]);
  assert.equal(result.currentPhase, '02');
});

test('readDesiredState returns fixed typed unavailable data for malformed local inputs', (t) => {
  const repoDir = createTempDir('github-sync-desired-invalid-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', 'not a roadmap');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: [bad\n---\n');

  assert.deepEqual(readDesiredState(repoDir), {
    available: false,
    reason: DESIRED_REASON.LOCAL_UNAVAILABLE,
    phases: [],
    plans: [],
    currentPhase: null,
  });
});
