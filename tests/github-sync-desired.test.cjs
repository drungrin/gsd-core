/* Offline tests for the authoritative github-sync disk projection. */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');

const { readDesiredState, DESIRED_REASON, dedupeMilestonesByVersion } = require('../gsd-core/bin/lib/github-sync-desired.cjs');

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
  // Backfilled as a new statement (03-05 Task 1 extends readDesiredState to
  // require milestone/milestone_name frontmatter for an available read) —
  // added after the original STATE.md write above rather than editing it, so
  // this test's diff for this task is additions only.
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 02\nmilestone: v1.0\nmilestone_name: Sync\n---\n');

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
    milestones: [],
    duplicateMilestones: [],
  });
});

// ─── readDesiredState: milestones (plan 03-05 Task 1) ─────────────────────

test('readDesiredState projects the current milestone alone when no archives directory exists', (t) => {
  const repoDir = createTempDir('github-sync-desired-milestone-current-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap: GSD Core\n\n### Phase 01: One\n\n**Goal**: one\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: milestone\n---\n');

  const result = readDesiredState(repoDir);

  assert.equal(result.available, true);
  assert.deepEqual(result.milestones, [
    { version: 'v1.0', name: 'milestone', title: 'v1.0 — milestone', description: 'Roadmap: GSD Core', archived: false },
  ]);
  assert.deepEqual(result.duplicateMilestones, []);
});

test('an archive written the way src/milestone.cts writes one (HIGH-5 gate): identity from the filename and MILESTONES.md, never from the archive\'s own H1', (t) => {
  const repoDir = createTempDir('github-sync-desired-archive-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap: GSD Core\n\n### Phase 01: One\n\n**Goal**: one\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: milestone\n---\n');
  // Verbatim roadmap copy — no header prepended, no version or milestone name
  // anywhere in the content — exactly what src/milestone.cts:671-674 writes.
  write(repoDir, '.planning/milestones/v0.9-ROADMAP.md', '# Roadmap: Some Project\n\n### Phase 01: One\n\n**Goal**: one\n');
  write(repoDir, '.planning/MILESTONES.md', '# Milestones\n\n## v0.9 first milestone (Shipped: 2026-01-01)\n\n**Phases completed:** 1 phases\n\n---\n');

  const result = readDesiredState(repoDir);

  assert.equal(result.available, true);
  assert.equal(result.milestones.length, 2);
  assert.deepEqual(result.milestones.map((m) => m.title), ['v0.9 — first milestone', 'v1.0 — milestone']);
  const [archived, current] = result.milestones;
  assert.equal(archived.version, 'v0.9');
  assert.equal(archived.name, 'first milestone');
  assert.equal(archived.archived, true);
  assert.equal(archived.description, 'Roadmap: Some Project');
  assert.equal(current.archived, false);
});

test('the same archive with MILESTONES.md absent still yields one entry, name falling back to the version', (t) => {
  const repoDir = createTempDir('github-sync-desired-archive-nomd-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap: GSD Core\n\n### Phase 01: One\n\n**Goal**: one\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: milestone\n---\n');
  write(repoDir, '.planning/milestones/v0.9-ROADMAP.md', '# Roadmap: Some Project\n');

  const result = readDesiredState(repoDir);
  const archived = result.milestones.find((m) => m.version === 'v0.9');
  assert.ok(archived, 'the archive must still produce an entry with MILESTONES.md absent');
  assert.equal(archived.name, 'v0.9');
});

test('MILESTONES.md present but carrying no entry for the archive version falls back identically, with no cross-contamination from a different version\'s entry', (t) => {
  const repoDir = createTempDir('github-sync-desired-archive-othername-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap: GSD Core\n\n### Phase 01: One\n\n**Goal**: one\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: milestone\n---\n');
  write(repoDir, '.planning/milestones/v0.9-ROADMAP.md', '# Roadmap: Some Project\n');
  write(repoDir, '.planning/MILESTONES.md', '# Milestones\n\n## v0.5 unrelated milestone (Shipped: 2025-01-01)\n');

  const result = readDesiredState(repoDir);
  const archived = result.milestones.find((m) => m.version === 'v0.9');
  assert.equal(archived.name, 'v0.9');
});

test('a v0.9-REQUIREMENTS.md sibling in the archives directory produces no milestone entry', (t) => {
  const repoDir = createTempDir('github-sync-desired-sibling-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap: GSD Core\n\n### Phase 01: One\n\n**Goal**: one\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: milestone\n---\n');
  write(repoDir, '.planning/milestones/v0.9-REQUIREMENTS.md', '# Requirements Archive: v0.9 first\n');

  const result = readDesiredState(repoDir);
  assert.equal(result.milestones.length, 1);
  assert.equal(result.milestones[0].archived, false);
});

test('a filename in the archives directory not matching the archive-roadmap pattern is skipped, not counted', (t) => {
  const repoDir = createTempDir('github-sync-desired-badname-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap: GSD Core\n\n### Phase 01: One\n\n**Goal**: one\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: milestone\n---\n');
  write(repoDir, '.planning/milestones/README.md', '# notes\n');

  const result = readDesiredState(repoDir);
  assert.equal(result.milestones.length, 1);
});

test('an archive with a malformed or absent H1 still yields its entry, description falling back to the title', (t) => {
  const repoDir = createTempDir('github-sync-desired-noh1-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap: GSD Core\n\n### Phase 01: One\n\n**Goal**: one\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: milestone\n---\n');
  write(repoDir, '.planning/milestones/v0.9-ROADMAP.md', 'no heading in this file at all\n');
  write(repoDir, '.planning/MILESTONES.md', '# Milestones\n\n## v0.9 first milestone (Shipped: 2026-01-01)\n');

  const result = readDesiredState(repoDir);
  const archived = result.milestones.find((m) => m.version === 'v0.9');
  assert.equal(archived.title, 'v0.9 — first milestone');
  assert.equal(archived.description, archived.title);
});

test('version ordering survives the double-digit and multi-segment cases; the current milestone is always last regardless of its own version', (t) => {
  const repoDir = createTempDir('github-sync-desired-order-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap: GSD Core\n\n### Phase 01: One\n\n**Goal**: one\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v9.0\nmilestone_name: current\n---\n');
  for (const version of ['v1.9', 'v1.10', 'v0.5', 'v1.2.3', 'v2']) {
    write(repoDir, `.planning/milestones/${version}-ROADMAP.md`, `# Roadmap: ${version}\n`);
  }

  const result = readDesiredState(repoDir);
  assert.deepEqual(result.milestones.map((m) => m.version), ['v0.5', 'v1.2.3', 'v1.9', 'v1.10', 'v2', 'v9.0']);
  assert.equal(result.milestones.at(-1).archived, false);
});

test('a `.planning` tree with no archives directory yields exactly one milestone and an available read', (t) => {
  const repoDir = createTempDir('github-sync-desired-noarchivedir-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap: GSD Core\n\n### Phase 01: One\n\n**Goal**: one\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: milestone\n---\n');

  const result = readDesiredState(repoDir);
  assert.equal(result.available, true);
  assert.equal(result.milestones.length, 1);
});

test('a STATE.md missing its milestone key yields the unavailable result with an empty milestone array, not a partial result', (t) => {
  const repoDir = createTempDir('github-sync-desired-nomilestone-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap: GSD Core\n\n### Phase 01: One\n\n**Goal**: one\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\n---\n');

  const result = readDesiredState(repoDir);
  assert.equal(result.available, false);
  assert.deepEqual(result.milestones, []);
});

test('an archive sharing the current milestone\'s version yields the current entry, with the archive reported as a duplicate', (t) => {
  const repoDir = createTempDir('github-sync-desired-currentdup-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap: GSD Core\n\n### Phase 01: One\n\n**Goal**: one\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: current-name\n---\n');
  write(repoDir, '.planning/milestones/v1.0-ROADMAP.md', '# Roadmap: archived form\n');
  write(repoDir, '.planning/MILESTONES.md', '# Milestones\n\n## v1.0 archived-name (Shipped: 2025-01-01)\n');

  const result = readDesiredState(repoDir);
  assert.equal(result.milestones.length, 1);
  assert.equal(result.milestones[0].name, 'current-name');
  assert.equal(result.milestones[0].archived, false);
  assert.deepEqual(result.duplicateMilestones, ['v1.0 — archived-name']);
});

test('no milestone entry ever carries a key whose name includes the word "due" (D-27: GSD has no deadline concept)', (t) => {
  // planner-discipline-allow: due
  const repoDir = createTempDir('github-sync-desired-noduedate-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap: GSD Core\n\n### Phase 01: One\n\n**Goal**: one\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: milestone\n---\n');
  write(repoDir, '.planning/milestones/v0.9-ROADMAP.md', '# Roadmap: archived\n');

  const result = readDesiredState(repoDir);
  for (const milestone of result.milestones) {
    for (const key of Object.keys(milestone)) {
      assert.doesNotMatch(key, /due/i);
    }
  }
});

test('dedupeMilestonesByVersion keeps the first entry in input order and reports every later same-version entry as a duplicate', () => {
  const first = { version: 'v0.9', name: 'a', title: 'v0.9 — a', description: '', archived: true };
  const second = { version: 'v0.9', name: 'b', title: 'v0.9 — b', description: '', archived: true };
  const third = { version: 'v1.0', name: 'c', title: 'v1.0 — c', description: '', archived: true };

  const result = dedupeMilestonesByVersion([first, second, third]);

  assert.deepEqual(result.milestones, [first, third]);
  assert.deepEqual(result.duplicates, [second.title]);
});

// ─── readDesiredState: success criteria and requirement IDs (plan 04-02 Task 1) ───

test('a phase section carrying a comma-separated requirements label yields those IDs, trimmed, in source order, with no empty entries', (t) => {
  const repoDir = createTempDir('github-sync-desired-requirements-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap\n\n### Phase 01: One\n\n**Goal**: one\n**Requirements**: FOO-01,  FOO-02 ,FOO-03,\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: m\n---\n');

  const result = readDesiredState(repoDir);

  assert.equal(result.available, true);
  assert.deepEqual(result.phases[0].requirements, ['FOO-01', 'FOO-02', 'FOO-03']);
});

test('a phase section carrying no requirements label yields an empty requirements list rather than an unavailable read', (t) => {
  const repoDir = createTempDir('github-sync-desired-norequirements-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap\n\n### Phase 01: One\n\n**Goal**: one\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: m\n---\n');

  const result = readDesiredState(repoDir);

  assert.equal(result.available, true);
  assert.deepEqual(result.phases[0].requirements, []);
});

test('a requirements list written with surrounding square brackets yields the same IDs with the brackets stripped', (t) => {
  const repoDir = createTempDir('github-sync-desired-requirements-brackets-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap\n\n### Phase 01: One\n\n**Goal**: one\n**Requirements**: [FOO-01, FOO-02]\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: m\n---\n');

  const result = readDesiredState(repoDir);

  assert.deepEqual(result.phases[0].requirements, ['FOO-01', 'FOO-02']);
});

test('a phase section carrying a success-criteria label followed by two-space-indented numbered items yields those items with numbering removed and text trimmed', (t) => {
  const repoDir = createTempDir('github-sync-desired-successcriteria-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap\n\n### Phase 01: One\n\n**Goal**: one\n**Success Criteria** (what must be TRUE):\n\n  1. First criterion  \n  2. Second criterion\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: m\n---\n');

  const result = readDesiredState(repoDir);

  assert.deepEqual(result.phases[0].successCriteria, ['First criterion', 'Second criterion']);
});

test('a success-criteria item that wraps onto a continuation line yields one entry joined with a single space, not two entries and not a truncation', (t) => {
  const repoDir = createTempDir('github-sync-desired-successcriteria-wrap-');
  t.after(() => cleanup(repoDir));
  write(
    repoDir,
    '.planning/ROADMAP.md',
    '# Roadmap\n\n### Phase 01: One\n\n**Goal**: one\n**Success Criteria** (what must be TRUE):\n\n  1. First line of the item\n     continues right here\n  2. Second item\n',
  );
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: m\n---\n');

  const result = readDesiredState(repoDir);

  assert.deepEqual(result.phases[0].successCriteria, ['First line of the item continues right here', 'Second item']);
});

test('extraction stops at the next bold label line: a confidence-handling paragraph, an italic amendment note, and a Plans line contribute no entry', (t) => {
  const repoDir = createTempDir('github-sync-desired-successcriteria-stop-');
  t.after(() => cleanup(repoDir));
  write(
    repoDir,
    '.planning/ROADMAP.md',
    [
      '# Roadmap',
      '',
      '### Phase 01: One',
      '',
      '**Goal**: one',
      '**Success Criteria** (what must be TRUE):',
      '',
      '  1. Only item',
      '',
      '*Amended note here spanning',
      'multiple lines of italic prose.*',
      '',
      '**Confidence handling**: some prose that must never become an entry',
      '',
      '**Plans**: TBD',
      '',
      '### Phase 02: Two',
      '',
      '**Goal**: two',
      '',
    ].join('\n'),
  );
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: m\n---\n');

  const result = readDesiredState(repoDir);

  assert.deepEqual(result.phases[0].successCriteria, ['Only item']);
});

test('a phase section carrying no success-criteria label yields an empty success-criteria list rather than an unavailable read', (t) => {
  const repoDir = createTempDir('github-sync-desired-nosuccesscriteria-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap\n\n### Phase 01: One\n\n**Goal**: one\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: m\n---\n');

  const result = readDesiredState(repoDir);

  assert.deepEqual(result.phases[0].successCriteria, []);
});

test('the real repository roadmap parses: phase 04 yields its three PHASE-* requirement IDs and four success-criteria entries', () => {
  const repoRoot = path.join(__dirname, '..');

  const result = readDesiredState(repoRoot);

  assert.equal(result.available, true);
  const phase04 = result.phases.find((phase) => phase.id === '04');
  assert.ok(phase04, 'phase 04 must be present in the real repository roadmap');
  assert.deepEqual(phase04.requirements, ['PHASE-01', 'PHASE-02', 'PHASE-03']);
  assert.equal(phase04.successCriteria.length, 4);
});

test('every fixture in this suite produces a milestone array with no two entries sharing a version', (t) => {
  const repoDir = createTempDir('github-sync-desired-uniqueness-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap: GSD Core\n\n### Phase 01: One\n\n**Goal**: one\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: milestone\n---\n');
  write(repoDir, '.planning/milestones/v0.9-ROADMAP.md', '# Roadmap: archived\n');
  write(repoDir, '.planning/milestones/v0.8-ROADMAP.md', '# Roadmap: older\n');

  const result = readDesiredState(repoDir);
  const versions = result.milestones.map((m) => m.version);
  assert.equal(new Set(versions).size, versions.length);
});
