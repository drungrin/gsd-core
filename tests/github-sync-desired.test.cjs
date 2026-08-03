/* Offline tests for the authoritative github-sync disk projection. */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');

const {
  readDesiredState, DESIRED_REASON, dedupeMilestonesByVersion, PHASE_STATUS,
  planTitleFor, parsePlanTaskNames, parseRoadmapPlanDescriptions,
  parseCurrentPlan, derivePlanStatus,
} = require('../gsd-core/bin/lib/github-sync-desired.cjs');

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
  assert.deepEqual(result.plans, [{
    id: '02-01', phaseId: '02', wave: 2, autonomous: true, requirements: ['SYNC-05'], dependsOn: [], complete: true,
    // Plan 05-01 (D-04/D-01/D-05): no ROADMAP plan-list row for 02-01, so the
    // title falls back to its phase's own title ("Sync"); the plan body
    // carries no <task> blocks, so tasks is empty; complete: true derives
    // Done regardless of current_plan position (05-02: derivePlanStatus).
    title: '02-01 — Sync', tasks: [], status: PHASE_STATUS.DONE,
  }]);
  assert.equal(result.currentPhase, '02');
  assert.equal(result.currentPlan, null);
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
    currentPlan: null,
    milestones: [],
    duplicateMilestones: [],
    malformedPlans: [],
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

// ─── readDesiredState: derived Status (plan 04-02 Task 2) ─────────────────

test('a phase whose checklist entry is checked yields Done, regardless of whether it is the current phase', (t) => {
  const repoDir = createTempDir('github-sync-desired-status-done-');
  t.after(() => cleanup(repoDir));
  write(
    repoDir,
    '.planning/ROADMAP.md',
    '# Roadmap\n\n- [x] **Phase 1: One** - done\n\n### Phase 01: One\n\n**Goal**: one\n',
  );
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: m\n---\n');

  const result = readDesiredState(repoDir);

  assert.equal(result.phases[0].status, PHASE_STATUS.DONE);
});

test('a phase whose checklist entry is unchecked and whose id equals current_phase yields In Progress', (t) => {
  const repoDir = createTempDir('github-sync-desired-status-inprogress-');
  t.after(() => cleanup(repoDir));
  write(
    repoDir,
    '.planning/ROADMAP.md',
    '# Roadmap\n\n- [ ] **Phase 1: One** - not done\n\n### Phase 01: One\n\n**Goal**: one\n',
  );
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: m\n---\n');

  const result = readDesiredState(repoDir);

  assert.equal(result.phases[0].status, PHASE_STATUS.IN_PROGRESS);
});

test('a phase whose checklist entry is unchecked and whose id differs from current_phase yields Todo', (t) => {
  const repoDir = createTempDir('github-sync-desired-status-todo-');
  t.after(() => cleanup(repoDir));
  write(
    repoDir,
    '.planning/ROADMAP.md',
    '# Roadmap\n\n- [ ] **Phase 2: Two** - not done\n\n### Phase 02: Two\n\n**Goal**: two\n',
  );
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: m\n---\n');

  const result = readDesiredState(repoDir);

  assert.equal(result.phases[0].status, PHASE_STATUS.TODO);
});

test('checklist ids are normalized before comparison: `- [ ] **Phase 4:` matches `### Phase 04:` and STATE current_phase 04', (t) => {
  const repoDir = createTempDir('github-sync-desired-status-normalize-');
  t.after(() => cleanup(repoDir));
  write(
    repoDir,
    '.planning/ROADMAP.md',
    '# Roadmap\n\n- [ ] **Phase 4: Four** - not done\n\n### Phase 04: Four\n\n**Goal**: four\n',
  );
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 04\nmilestone: v1.0\nmilestone_name: m\n---\n');

  const result = readDesiredState(repoDir);

  assert.equal(result.phases.length, 1);
  assert.equal(result.phases[0].status, PHASE_STATUS.IN_PROGRESS);
});

test('a decimal-id phase (2.1) in both the checklist and the details resolves to its own status, not phase 02\'s', (t) => {
  const repoDir = createTempDir('github-sync-desired-status-decimal-');
  t.after(() => cleanup(repoDir));
  write(
    repoDir,
    '.planning/ROADMAP.md',
    [
      '# Roadmap',
      '',
      '- [x] **Phase 2: Two** - done',
      '- [ ] **Phase 2.1: Two Point One** - not done',
      '',
      '### Phase 02: Two',
      '',
      '**Goal**: two',
      '',
      '### Phase 2.1: Two Point One',
      '',
      '**Goal**: inserted',
      '',
    ].join('\n'),
  );
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: m\n---\n');

  const result = readDesiredState(repoDir);

  const phase02 = result.phases.find((phase) => phase.id === '02');
  const phase21 = result.phases.find((phase) => phase.id === '2.1');
  assert.equal(phase02.status, PHASE_STATUS.DONE);
  assert.equal(phase21.status, PHASE_STATUS.TODO);
});

test('a phase present in the phase details but absent from the checklist falls back to the current-phase test, never null/undefined/empty', (t) => {
  const repoDir = createTempDir('github-sync-desired-status-nochecklist-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap\n\n### Phase 01: One\n\n**Goal**: one\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: m\n---\n');

  const result = readDesiredState(repoDir);

  assert.equal(result.phases[0].status, PHASE_STATUS.IN_PROGRESS);
  assert.notEqual(result.phases[0].status, null);
  assert.notEqual(result.phases[0].status, undefined);
  assert.notEqual(result.phases[0].status, '');
});

test('a checklist entry present with no matching detail heading contributes no phase at all', (t) => {
  const repoDir = createTempDir('github-sync-desired-status-orphanchecklist-');
  t.after(() => cleanup(repoDir));
  write(
    repoDir,
    '.planning/ROADMAP.md',
    '# Roadmap\n\n- [x] **Phase 9: Nine** - phantom\n\n### Phase 01: One\n\n**Goal**: one\n',
  );
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: m\n---\n');

  const result = readDesiredState(repoDir);

  assert.equal(result.phases.length, 1);
  assert.equal(result.phases[0].id, '01');
});

test('every phase in the returned desired state carries a status drawn from the fixed PHASE_STATUS member set', (t) => {
  const repoDir = createTempDir('github-sync-desired-status-memberset-');
  t.after(() => cleanup(repoDir));
  write(
    repoDir,
    '.planning/ROADMAP.md',
    [
      '# Roadmap',
      '',
      '- [x] **Phase 1: One** - done',
      '- [ ] **Phase 2: Two** - not done',
      '',
      '### Phase 01: One',
      '',
      '**Goal**: one',
      '',
      '### Phase 02: Two',
      '',
      '**Goal**: two',
      '',
      '### Phase 03: Three',
      '',
      '**Goal**: three',
      '',
    ].join('\n'),
  );
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 02\nmilestone: v1.0\nmilestone_name: m\n---\n');

  const result = readDesiredState(repoDir);

  const memberSet = new Set(Object.values(PHASE_STATUS));
  for (const phase of result.phases) {
    assert.ok(memberSet.has(phase.status), `phase ${phase.id} status ${phase.status} must be a PHASE_STATUS member`);
  }
});

test('no fixture in this suite ever yields Blocked or Deferred', (t) => {
  const repoDir = createTempDir('github-sync-desired-status-noblockeddeferred-');
  t.after(() => cleanup(repoDir));
  write(
    repoDir,
    '.planning/ROADMAP.md',
    [
      '# Roadmap',
      '',
      '- [x] **Phase 1: One** - done',
      '- [ ] **Phase 2: Two** - not done',
      '',
      '### Phase 01: One',
      '',
      '**Goal**: one',
      '',
      '### Phase 02: Two',
      '',
      '**Goal**: two',
      '',
    ].join('\n'),
  );
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 02\nmilestone: v1.0\nmilestone_name: m\n---\n');

  const result = readDesiredState(repoDir);

  for (const phase of result.phases) {
    assert.notEqual(phase.status, 'Blocked');
    assert.notEqual(phase.status, 'Deferred');
  }
});

test('reading the repository\'s own ROADMAP.md and STATE.md yields Done for phases 01-03, In Progress for phase 04, and Todo for phases 05-08', () => {
  const repoRoot = path.join(__dirname, '..');

  const result = readDesiredState(repoRoot);

  assert.equal(result.available, true);
  const statusFor = (id) => result.phases.find((phase) => phase.id === id).status;
  assert.equal(statusFor('01'), PHASE_STATUS.DONE);
  assert.equal(statusFor('02'), PHASE_STATUS.DONE);
  assert.equal(statusFor('03'), PHASE_STATUS.DONE);
  assert.equal(statusFor('04'), PHASE_STATUS.IN_PROGRESS);
  assert.equal(statusFor('05'), PHASE_STATUS.TODO);
  assert.equal(statusFor('06'), PHASE_STATUS.TODO);
  assert.equal(statusFor('07'), PHASE_STATUS.TODO);
  assert.equal(statusFor('08'), PHASE_STATUS.TODO);
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

// ─── Phase 5 (05-01 Task 1): plan title, task list, plan status ───────────

test('planTitleFor: description present yields "<id> — <description>", regardless of whether a phase title is also supplied', () => {
  assert.equal(planTitleFor('04-03', 'Splice a region by severity', 'Phase Four'), '04-03 — Splice a region by severity');
  assert.equal(planTitleFor('04-03', 'Splice a region by severity', undefined), '04-03 — Splice a region by severity');
});

test('planTitleFor: description absent but a phase title is supplied yields "<id> — <phaseTitle>"', () => {
  assert.equal(planTitleFor('04-03', undefined, 'Phase Four'), '04-03 — Phase Four');
});

test('planTitleFor: neither description nor phase title supplied yields the bare id, never empty', () => {
  assert.equal(planTitleFor('04-03', undefined, undefined), '04-03');
});

test('parseRoadmapPlanDescriptions: extracts an em-dash-separated description keyed by the normalized plan id, and a bare row (no description) contributes no entry', () => {
  const roadmap = [
    '- [x] 04-01-PLAN.md — Tracer: the whole path, one plan only',
    '- [x] 04-16-PLAN.md',
    '- [ ] 4-02-PLAN.md — Unnormalized phase digit',
  ].join('\n');

  const descriptions = parseRoadmapPlanDescriptions(roadmap);

  assert.equal(descriptions.get('04-01'), 'Tracer: the whole path, one plan only');
  assert.equal(descriptions.has('04-16'), false);
  assert.equal(descriptions.get('04-02'), 'Unnormalized phase digit');
});

test('parsePlanTaskNames: reads <task>/<name> blocks from the PLAN.md body in document order, ignoring the frontmatter entirely', () => {
  const raw = [
    '---',
    'phase: 04',
    'plan: 01',
    '---',
    '',
    '<tasks>',
    '<task type="auto">',
    '  <name>Task 1: First task</name>',
    '</task>',
    '<task type="auto">',
    '  <name>Task 2: Second task</name>',
    '</task>',
    '</tasks>',
    '',
  ].join('\n');

  assert.deepEqual(parsePlanTaskNames(raw), ['Task 1: First task', 'Task 2: Second task']);
});

test('parsePlanTaskNames: two task blocks with byte-identical <name> text both contribute their own entry — no deduplication', () => {
  const raw = [
    '---\nphase: 04\nplan: 01\n---',
    '<task type="auto"><name>Repeated name</name></task>',
    '<task type="auto"><name>Repeated name</name></task>',
  ].join('\n');

  assert.deepEqual(parsePlanTaskNames(raw), ['Repeated name', 'Repeated name']);
});

test('parsePlanTaskNames: a plan file with zero <task> blocks yields an empty array, not a failure', () => {
  const raw = '---\nphase: 04\nplan: 01\n---\n<objective>No tasks here.</objective>\n';
  assert.deepEqual(parsePlanTaskNames(raw), []);
});

test('readPlans (via readDesiredState): title populates through all three planTitleFor tiers, and tasks reflects the PLAN.md body task/name blocks in document order', (t) => {
  const repoDir = createTempDir('github-sync-desired-plan-title-tiers-');
  t.after(() => cleanup(repoDir));
  write(
    repoDir,
    '.planning/ROADMAP.md',
    [
      '# Roadmap',
      '',
      '- [x] 01-01-PLAN.md — Curated one-liner',
      '- [x] 01-02-PLAN.md',
      '',
      '### Phase 01: One',
      '',
      '**Goal**: one',
      '',
      '### Phase 02: Two',
      '',
      '**Goal**: two',
      '',
    ].join('\n'),
  );
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: m\n---\n');
  // Tier 1: description present.
  write(repoDir, '.planning/phases/01-one/01-01-PLAN.md', '---\nwave: 1\nautonomous: true\nrequirements: []\n---\n<task type="auto"><name>First</name></task>\n<task type="auto"><name>Second</name></task>\n');
  // Tier 2: no description, but the phase (01) is present in ROADMAP.md.
  write(repoDir, '.planning/phases/01-one/01-02-PLAN.md', '---\nwave: 1\nautonomous: true\nrequirements: []\n---\n');
  // Tier 3: no description and the phase (03) has no ROADMAP.md detail section at all.
  write(repoDir, '.planning/phases/03-three/03-01-PLAN.md', '---\nwave: 1\nautonomous: true\nrequirements: []\n---\n');

  const result = readDesiredState(repoDir);

  assert.equal(result.available, true);
  const byId = (id) => result.plans.find((plan) => plan.id === id);
  assert.equal(byId('01-01').title, '01-01 — Curated one-liner');
  assert.deepEqual(byId('01-01').tasks, ['First', 'Second']);
  assert.equal(byId('01-02').title, '01-02 — One');
  assert.deepEqual(byId('01-02').tasks, []);
  assert.equal(byId('03-01').title, '03-01');
});

// ─── CR-03 pin (05-REVIEW re-review): one malformed plan file/subdirectory
// never silences the whole readPlans/readDesiredState run ──────────────────

test('readDesiredState: CR-03 pin — a PLAN.md with no frontmatter block is skipped and named in malformedPlans, never suppressing sibling plans in the same or another phase directory', (t) => {
  const repoDir = createTempDir('github-sync-desired-malformed-plan-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap\n\n### Phase 01: One\n\n**Goal**: one\n\n### Phase 02: Two\n\n**Goal**: two\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: m\n---\n');
  write(repoDir, '.planning/phases/01-one/01-01-PLAN.md', '---\nwave: 1\nautonomous: true\nrequirements: []\n---\n');
  // No frontmatter block at all — a legacy pre-frontmatter-era file, or a
  // plan mid-edit when sync happens to run: exactly the case CR-03 covers.
  write(repoDir, '.planning/phases/01-one/01-02-PLAN.md', '# Just a heading, no frontmatter block\n');
  write(repoDir, '.planning/phases/02-two/02-01-PLAN.md', '---\nwave: 1\nautonomous: true\nrequirements: []\n---\n');

  const result = readDesiredState(repoDir);

  assert.equal(result.available, true, 'CR-03: one malformed plan file no longer collapses the whole read to unavailable()');
  assert.equal(result.reason, DESIRED_REASON.OK);
  assert.deepEqual(
    result.plans.map((plan) => plan.id),
    ['01-01', '02-01'],
    'the two well-formed plans, across both phase directories, still parse — the malformed sibling is skipped, not the whole tree',
  );
  assert.deepEqual(
    result.malformedPlans,
    [path.join('phases', '01-one', '01-02-PLAN.md')],
    'the offending file\'s path is named, not collapsed into a single opaque local_unavailable reason',
  );
});

test('readDesiredState: CR-03 pin — an unreadable phase subdirectory (a file where a directory is expected) is skipped and named in malformedPlans, without aborting other phase directories', (t) => {
  const repoDir = createTempDir('github-sync-desired-malformed-phasedir-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap\n\n### Phase 01: One\n\n**Goal**: one\n\n### Phase 02: Two\n\n**Goal**: two\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: m\n---\n');
  write(repoDir, '.planning/phases/02-two/02-01-PLAN.md', '---\nwave: 1\nautonomous: true\nrequirements: []\n---\n');
  // A regular file at the phase-subdirectory path — fs.readdirSync throws
  // ENOTDIR on it, the same fault class a permissions error would cause.
  const phasesDir = path.join(repoDir, '.planning', 'phases');
  fs.mkdirSync(phasesDir, { recursive: true });
  fs.writeFileSync(path.join(phasesDir, '01-one'), 'not a directory\n');

  const result = readDesiredState(repoDir);

  assert.equal(result.available, true, 'CR-03: one unreadable phase subdirectory no longer collapses the whole read to unavailable()');
  assert.deepEqual(result.plans.map((plan) => plan.id), ['02-01'], 'the other phase directory\'s plan still parses');
  assert.deepEqual(result.malformedPlans, [path.join('phases', '01-one')], 'the offending phase subdirectory is named');
});

// ─── WR-01 pin (05-REVIEW re-review): wave: 0 is not a positive integer ───

test('readDesiredState: WR-01 pin — wave: 0 does not parse as a real value, falling through to null exactly like an absent wave: key', (t) => {
  const repoDir = createTempDir('github-sync-desired-wave-zero-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap\n\n### Phase 01: One\n\n**Goal**: one\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: m\n---\n');
  write(repoDir, '.planning/phases/01-one/01-01-PLAN.md', '---\nwave: 0\nautonomous: true\nrequirements: []\n---\n');

  const result = readDesiredState(repoDir);

  assert.equal(result.available, true);
  const plan = result.plans.find((entry) => entry.id === '01-01');
  assert.equal(
    plan.wave,
    null,
    'WR-01: wave: 0 is not a positive integer, so it no longer parses as the number 0 — every comment describing Wave\'s argv encoding in github-sync-reconcile.cts calls it "a validated positive integer", and 0 is not one',
  );
});

test('readDesiredState: WR-01 — a positive wave value still parses normally, unaffected by the tightened regex', (t) => {
  const repoDir = createTempDir('github-sync-desired-wave-positive-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap\n\n### Phase 01: One\n\n**Goal**: one\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: m\n---\n');
  write(repoDir, '.planning/phases/01-one/01-01-PLAN.md', '---\nwave: 3\nautonomous: true\nrequirements: []\n---\n');

  const result = readDesiredState(repoDir);
  const plan = result.plans.find((entry) => entry.id === '01-01');
  assert.equal(plan.wave, 3);
});

// ─── Phase 5 (05-02 Task 1): parseCurrentPlan, derivePlanStatus (D-09) ────

test('parseCurrentPlan: a quoted current_plan frontmatter value returns the plan id', () => {
  assert.equal(parseCurrentPlan('---\ncurrent_plan: "04-03"\n---\nsome body\n'), '04-03');
});

test('parseCurrentPlan: an unquoted current_plan frontmatter value also returns the plan id', () => {
  assert.equal(parseCurrentPlan('---\ncurrent_plan: 04-03\n---\n'), '04-03');
});

test('parseCurrentPlan: no frontmatter key but a body line labelled "Current Plan" (bold) returns that value', () => {
  assert.equal(parseCurrentPlan('---\ncurrent_phase: 04\n---\n**Current Plan:** 04-03\n'), '04-03');
});

test('parseCurrentPlan: no frontmatter key but a plain "Current Plan:" body line returns that value', () => {
  assert.equal(parseCurrentPlan('---\ncurrent_phase: 04\n---\nCurrent Plan: 04-03\n'), '04-03');
});

test('parseCurrentPlan: the frontmatter key takes precedence over a conflicting body field, mirroring state.cts', () => {
  assert.equal(parseCurrentPlan('---\ncurrent_plan: "04-03"\n---\n**Current Plan:** 04-99\n'), '04-03');
});

test('parseCurrentPlan: neither the frontmatter key nor a "Current Plan" body field present returns null; a "Plan: Not started" body line is not a match', () => {
  assert.equal(parseCurrentPlan('---\ncurrent_phase: 04\n---\nPlan: Not started\n'), null);
  assert.equal(parseCurrentPlan('---\ncurrent_phase: 04\n---\n**Plan:** Not started\n'), null);
  assert.equal(parseCurrentPlan('---\n---\n'), null);
});

test('parseCurrentPlan: the phase segment is normalized through normalizeId; the plan segment is left as written', () => {
  assert.equal(parseCurrentPlan('---\ncurrent_plan: "4-03"\n---\n'), '04-03');
});

test('derivePlanStatus: complete true returns Done — completeness wins over position even when the plan also names the current position', () => {
  assert.equal(derivePlanStatus({ id: '04-03', complete: true }, '04-03'), PHASE_STATUS.DONE);
});

test('derivePlanStatus: incomplete and id equals the resolved current-plan id returns In Progress', () => {
  assert.equal(derivePlanStatus({ id: '04-03', complete: false }, '04-03'), PHASE_STATUS.IN_PROGRESS);
});

test('derivePlanStatus: incomplete and id differs from the resolved current-plan id returns Todo', () => {
  assert.equal(derivePlanStatus({ id: '04-04', complete: false }, '04-03'), PHASE_STATUS.TODO);
});

test('derivePlanStatus: incomplete and no recorded position (null) returns Todo — nothing is In Progress', () => {
  assert.equal(derivePlanStatus({ id: '04-04', complete: false }, null), PHASE_STATUS.TODO);
});

test('derivePlanStatus: never returns Blocked, Deferred, undefined, or null across the full (complete, position) matrix', () => {
  const memberSet = new Set(Object.values(PHASE_STATUS));
  const ids = ['04-01', '04-02'];
  const currentPositions = ['04-01', '04-02', '04-99', null];
  for (const id of ids) {
    for (const complete of [true, false]) {
      for (const currentPlanId of currentPositions) {
        const status = derivePlanStatus({ id, complete }, currentPlanId);
        assert.ok(memberSet.has(status), `derivePlanStatus({id:${id},complete:${complete}}, ${currentPlanId}) returned ${status}, not a PHASE_STATUS member`);
        assert.notEqual(status, 'Blocked');
        assert.notEqual(status, 'Deferred');
        assert.notEqual(status, undefined);
        assert.notEqual(status, null);
      }
    }
  }
});

test('derivePlanStatus is a pure function of (complete, id, currentPlanId) alone: reversing the input plan list changes no plan\'s derived status', () => {
  const currentPlanId = '04-02';
  const plans = [
    { id: '04-01', complete: false },
    { id: '04-02', complete: false },
    { id: '04-03', complete: true },
    { id: '04-04', complete: false },
  ];
  const forward = Object.fromEntries(plans.map((plan) => [plan.id, derivePlanStatus(plan, currentPlanId)]));
  const reversed = Object.fromEntries([...plans].reverse().map((plan) => [plan.id, derivePlanStatus(plan, currentPlanId)]));
  assert.deepEqual(reversed, forward);
});

test('readDesiredState: the plan named by current_plan (frontmatter) and lacking a SUMMARY.md derives In Progress; a sibling with a SUMMARY.md derives Done regardless; every other plan derives Todo', (t) => {
  const repoDir = createTempDir('github-sync-desired-planstatus-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap\n\n### Phase 04: Four\n\n**Goal**: four\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 04\ncurrent_plan: "04-02"\nmilestone: v1.0\nmilestone_name: m\n---\n');
  write(repoDir, '.planning/phases/04-four/04-01-PLAN.md', '---\nwave: 1\nautonomous: true\nrequirements: []\n---\n');
  write(repoDir, '.planning/phases/04-four/04-01-SUMMARY.md', '# done\n');
  write(repoDir, '.planning/phases/04-four/04-02-PLAN.md', '---\nwave: 1\nautonomous: true\nrequirements: []\n---\n');
  write(repoDir, '.planning/phases/04-four/04-03-PLAN.md', '---\nwave: 2\nautonomous: true\nrequirements: []\n---\n');

  const result = readDesiredState(repoDir);

  assert.equal(result.available, true);
  assert.equal(result.currentPlan, '04-02');
  const byId = (id) => result.plans.find((plan) => plan.id === id);
  assert.equal(byId('04-01').status, PHASE_STATUS.DONE);
  assert.equal(byId('04-02').status, PHASE_STATUS.IN_PROGRESS);
  assert.equal(byId('04-03').status, PHASE_STATUS.TODO);
});

test('readDesiredState: a plan that is both complete and named by current_plan derives Done — completeness wins over position', (t) => {
  const repoDir = createTempDir('github-sync-desired-planstatus-donewins-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap\n\n### Phase 04: Four\n\n**Goal**: four\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 04\ncurrent_plan: "04-01"\nmilestone: v1.0\nmilestone_name: m\n---\n');
  write(repoDir, '.planning/phases/04-four/04-01-PLAN.md', '---\nwave: 1\nautonomous: true\nrequirements: []\n---\n');
  write(repoDir, '.planning/phases/04-four/04-01-SUMMARY.md', '# done\n');

  const result = readDesiredState(repoDir);

  assert.equal(result.plans.find((plan) => plan.id === '04-01').status, PHASE_STATUS.DONE);
});

test('readDesiredState: STATE.md asserting no current_plan position yields Todo for every incomplete plan, never In Progress', (t) => {
  const repoDir = createTempDir('github-sync-desired-planstatus-noposition-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap\n\n### Phase 04: Four\n\n**Goal**: four\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 04\nmilestone: v1.0\nmilestone_name: m\n---\n');
  write(repoDir, '.planning/phases/04-four/04-01-PLAN.md', '---\nwave: 1\nautonomous: true\nrequirements: []\n---\n');
  write(repoDir, '.planning/phases/04-four/04-02-PLAN.md', '---\nwave: 1\nautonomous: true\nrequirements: []\n---\n');

  const result = readDesiredState(repoDir);

  assert.equal(result.available, true);
  assert.equal(result.currentPlan, null);
  for (const plan of result.plans) {
    assert.equal(plan.status, PHASE_STATUS.TODO);
  }
});

test('readDesiredState: a phase directory with zero PLAN.md files contributes zero plans and leaves the read available', (t) => {
  const repoDir = createTempDir('github-sync-desired-planstatus-emptyphase-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap\n\n### Phase 04: Four\n\n**Goal**: four\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 04\nmilestone: v1.0\nmilestone_name: m\n---\n');
  fs.mkdirSync(path.join(repoDir, '.planning/phases/04-four'), { recursive: true });

  const result = readDesiredState(repoDir);

  assert.equal(result.available, true);
  assert.deepEqual(result.plans, []);
});

// ─── Phase 5 (05-02 Task 2): depends_on, and the title fallback chain ─────

test('readDesiredState: depends_on: ["05-01", "05-02"] yields dependsOn in that order, quotes stripped', (t) => {
  const repoDir = createTempDir('github-sync-desired-dependson-quoted-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap\n\n### Phase 05: Five\n\n**Goal**: five\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 05\nmilestone: v1.0\nmilestone_name: m\n---\n');
  write(repoDir, '.planning/phases/05-five/05-03-PLAN.md', '---\nwave: 2\nautonomous: true\nrequirements: []\ndepends_on: ["05-01", "05-02"]\n---\n');

  const result = readDesiredState(repoDir);

  assert.deepEqual(result.plans.find((plan) => plan.id === '05-03').dependsOn, ['05-01', '05-02']);
});

test('readDesiredState: depends_on: [] yields an empty dependency list', (t) => {
  const repoDir = createTempDir('github-sync-desired-dependson-emptybrackets-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap\n\n### Phase 05: Five\n\n**Goal**: five\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 05\nmilestone: v1.0\nmilestone_name: m\n---\n');
  write(repoDir, '.planning/phases/05-five/05-01-PLAN.md', '---\nwave: 1\nautonomous: true\nrequirements: []\ndepends_on: []\n---\n');

  const result = readDesiredState(repoDir);

  assert.deepEqual(result.plans.find((plan) => plan.id === '05-01').dependsOn, []);
});

test('readDesiredState: an omitted depends_on key also yields an empty dependency list — a real state, never an unavailable read', (t) => {
  const repoDir = createTempDir('github-sync-desired-dependson-omitted-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap\n\n### Phase 05: Five\n\n**Goal**: five\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 05\nmilestone: v1.0\nmilestone_name: m\n---\n');
  write(repoDir, '.planning/phases/05-five/05-01-PLAN.md', '---\nwave: 1\nautonomous: true\nrequirements: []\n---\n');

  const result = readDesiredState(repoDir);

  assert.equal(result.available, true);
  assert.deepEqual(result.plans.find((plan) => plan.id === '05-01').dependsOn, []);
});

test('readDesiredState: an unquoted, irregularly spaced depends_on list yields trimmed entries with no empties', (t) => {
  const repoDir = createTempDir('github-sync-desired-dependson-irregular-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap\n\n### Phase 05: Five\n\n**Goal**: five\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 05\nmilestone: v1.0\nmilestone_name: m\n---\n');
  write(repoDir, '.planning/phases/05-five/05-03-PLAN.md', '---\nwave: 2\nautonomous: true\nrequirements: []\ndepends_on: [ 05-01 ,  05-02 ]\n---\n');

  const result = readDesiredState(repoDir);

  assert.deepEqual(result.plans.find((plan) => plan.id === '05-03').dependsOn, ['05-01', '05-02']);
});

test('readDesiredState: a depends_on entry naming an id with no PLAN.md on disk parses cleanly and leaves the read available — resolution is a later stage\'s concern', (t) => {
  const repoDir = createTempDir('github-sync-desired-dependson-unknownid-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap\n\n### Phase 05: Five\n\n**Goal**: five\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 05\nmilestone: v1.0\nmilestone_name: m\n---\n');
  write(repoDir, '.planning/phases/05-five/05-01-PLAN.md', '---\nwave: 1\nautonomous: true\nrequirements: []\ndepends_on: ["99-99"]\n---\n');

  const result = readDesiredState(repoDir);

  assert.equal(result.available, true);
  assert.deepEqual(result.plans.find((plan) => plan.id === '05-01').dependsOn, ['99-99']);
});

test('readDesiredState: a depends_on entry naming its own plan (self-reference) parses without error', (t) => {
  const repoDir = createTempDir('github-sync-desired-dependson-selfref-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap\n\n### Phase 05: Five\n\n**Goal**: five\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 05\nmilestone: v1.0\nmilestone_name: m\n---\n');
  write(repoDir, '.planning/phases/05-five/05-01-PLAN.md', '---\nwave: 1\nautonomous: true\nrequirements: []\ndepends_on: ["05-01"]\n---\n');

  const result = readDesiredState(repoDir);

  assert.equal(result.available, true);
  assert.deepEqual(result.plans.find((plan) => plan.id === '05-01').dependsOn, ['05-01']);
});

test('parseRoadmapPlanDescriptions: a row "- [x] 04-03-PLAN.md — The convergence primitives" maps 04-03 to "The convergence primitives"', () => {
  const descriptions = parseRoadmapPlanDescriptions('- [x] 04-03-PLAN.md — The convergence primitives\n');
  assert.equal(descriptions.get('04-03'), 'The convergence primitives');
});

test('parseRoadmapPlanDescriptions: a bare row "- [x] 02-05-PLAN.md" with no separator contributes no map entry', () => {
  const descriptions = parseRoadmapPlanDescriptions('- [x] 02-05-PLAN.md\n');
  assert.equal(descriptions.has('02-05'), false);
});

test('planTitleFor: "02-05" with no description but a phase title "Sync Engine Core" returns "02-05 — Sync Engine Core"', () => {
  assert.equal(planTitleFor('02-05', undefined, 'Sync Engine Core'), '02-05 — Sync Engine Core');
});

test('planTitleFor: "09-01" with neither a description nor a phase title returns the bare id "09-01"', () => {
  assert.equal(planTitleFor('09-01', undefined, undefined), '09-01');
});

test('planTitleFor never returns an empty or whitespace-only string across the full tier matrix', () => {
  const inputs = [
    ['id-only', undefined, undefined],
    ['id-only', undefined, ''],
    ['id-only', '', undefined],
    ['id-only', '', ''],
    ['id-only', undefined, 'Phase Title'],
    ['id-only', 'Description', undefined],
    ['id-only', 'Description', 'Phase Title'],
  ];
  for (const [id, description, phaseTitle] of inputs) {
    const title = planTitleFor(id, description, phaseTitle);
    assert.ok(title.length > 0, `planTitleFor(${id}, ${JSON.stringify(description)}, ${JSON.stringify(phaseTitle)}) returned an empty string`);
    assert.notEqual(title.trim(), '', `planTitleFor(${id}, ${JSON.stringify(description)}, ${JSON.stringify(phaseTitle)}) returned a whitespace-only string`);
  }
});

test('readDesiredState: a plan whose PLAN.md exists but whose phase is absent from ROADMAP.md still yields a non-empty title and does not make the projection unavailable', (t) => {
  const repoDir = createTempDir('github-sync-desired-title-noRoadmapPhase-');
  t.after(() => cleanup(repoDir));
  write(repoDir, '.planning/ROADMAP.md', '# Roadmap\n\n### Phase 01: One\n\n**Goal**: one\n');
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 01\nmilestone: v1.0\nmilestone_name: m\n---\n');
  write(repoDir, '.planning/phases/09-orphan/09-01-PLAN.md', '---\nwave: 1\nautonomous: true\nrequirements: []\n---\n');

  const result = readDesiredState(repoDir);

  assert.equal(result.available, true);
  const plan = result.plans.find((p) => p.id === '09-01');
  assert.equal(plan.title, '09-01');
  assert.ok(plan.title.length > 0);
});

test('readDesiredState: a row with no description contributes no entry to parseRoadmapPlanDescriptions, and the plan still receives a title through tier two (the phase title)', (t) => {
  const repoDir = createTempDir('github-sync-desired-title-tier2-viadescription-');
  t.after(() => cleanup(repoDir));
  write(
    repoDir,
    '.planning/ROADMAP.md',
    ['# Roadmap', '', '- [x] 02-05-PLAN.md', '', '### Phase 02: Sync Engine Core', '', '**Goal**: sync', ''].join('\n'),
  );
  write(repoDir, '.planning/STATE.md', '---\ncurrent_phase: 02\nmilestone: v1.0\nmilestone_name: m\n---\n');
  write(repoDir, '.planning/phases/02-sync/02-05-PLAN.md', '---\nwave: 1\nautonomous: true\nrequirements: []\n---\n');

  const result = readDesiredState(repoDir);

  assert.equal(parseRoadmapPlanDescriptions(fs.readFileSync(path.join(repoDir, '.planning/ROADMAP.md'), 'utf8')).has('02-05'), false);
  assert.equal(result.plans.find((plan) => plan.id === '02-05').title, '02-05 — Sync Engine Core');
});
