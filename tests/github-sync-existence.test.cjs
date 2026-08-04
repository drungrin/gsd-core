/*
 * Offline, zero-I/O tests for the D-05/D-08/D-09 existence classifier (plan
 * 07-01). Every test supplies a hand-built nowIso; no clock module is
 * imported anywhere in this file.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const existenceMod = require('../gsd-core/bin/lib/github-sync-existence.cjs');
const {
  EXISTENCE_VERDICT,
  RECREATE_GRACE_MS,
  classifyExistence,
  advanceAbsence,
  absenceGateSatisfied,
  rebuildTriggered,
} = existenceMod;

const T0 = '2026-08-01T00:00:00.000Z';
const T0_PLUS_60S = '2026-08-01T00:01:00.000Z';
const T0_PLUS_59999MS = '2026-08-01T00:00:59.999Z';

const PROJECT_COMPLETIONS = { project: { logicalKey: 'project', nodeId: 'PVT_1' } };

test('RECREATE_GRACE_MS is fixed at 60000', () => {
  assert.equal(RECREATE_GRACE_MS, 60000);
});

// ─── Behavior 1: present ────────────────────────────────────────────────────

test('classifyExistence returns present for a mapped project node ID that appears in an available bootstrap remote read', () => {
  const verdicts = classifyExistence({
    completions: PROJECT_COMPLETIONS,
    remote: { available: true },
    bootstrapRemote: { available: true, projectOutcome: 'resolved' },
  });
  assert.deepEqual(verdicts, [{ logicalKey: 'project', verdict: EXISTENCE_VERDICT.PRESENT }]);
});

// ─── Behavior 2: confirmed-absent ───────────────────────────────────────────

test('classifyExistence returns confirmed-absent for a mapped project node ID absent from an available bootstrap remote read', () => {
  const verdicts = classifyExistence({
    completions: PROJECT_COMPLETIONS,
    remote: { available: true },
    bootstrapRemote: { available: true, projectOutcome: 'absent' },
  });
  assert.deepEqual(verdicts, [{ logicalKey: 'project', verdict: EXISTENCE_VERDICT.CONFIRMED_ABSENT }]);
});

// ─── Behavior 3: unknown (T-07-01) ──────────────────────────────────────────

test('classifyExistence returns unknown when the bootstrap remote read is unavailable, regardless of what its (empty) arrays contain', () => {
  const verdicts = classifyExistence({
    completions: PROJECT_COMPLETIONS,
    remote: { available: true },
    // available: false, but projectOutcome deliberately claims "resolved" —
    // the classifier must branch on `available` BEFORE looking at anything
    // else (T-07-01), so this must still yield `unknown`, never `present`.
    bootstrapRemote: { available: false, projectOutcome: 'resolved' },
  });
  assert.deepEqual(verdicts, [{ logicalKey: 'project', verdict: EXISTENCE_VERDICT.UNKNOWN }]);
});

test('classifyExistence returns unknown when no bootstrapRemote is supplied at all', () => {
  const verdicts = classifyExistence({ completions: PROJECT_COMPLETIONS, remote: {}, bootstrapRemote: null });
  assert.deepEqual(verdicts, [{ logicalKey: 'project', verdict: EXISTENCE_VERDICT.UNKNOWN }]);
});

test('classifyExistence classifies nothing when no project completion is mapped', () => {
  const verdicts = classifyExistence({ completions: {}, remote: {}, bootstrapRemote: { available: true, projectOutcome: 'resolved' } });
  assert.deepEqual(verdicts, []);
});

// ─── Behavior 4: first confirmed absence ───────────────────────────────────

test('first confirmed absence: advanceAbsence sets absenceCount to 1 and stamps absenceFirstSeenAt from the supplied nowIso; classifyExistence itself emits zero bootstrap operations (rebuildTriggered stays false)', () => {
  const marker = advanceAbsence(undefined, EXISTENCE_VERDICT.CONFIRMED_ABSENT, T0);
  assert.deepEqual(marker, { absenceCount: 1, absenceFirstSeenAt: T0 });

  const verdicts = [{ logicalKey: 'project', verdict: EXISTENCE_VERDICT.CONFIRMED_ABSENT }];
  assert.equal(rebuildTriggered(verdicts, {}, T0), false);
});

// ─── Behavior 5: elapsed exactly RECREATE_GRACE_MS satisfies the gate ──────

test('second confirmed absence with elapsed exactly 60000ms satisfies the gate', () => {
  const completion = { absenceCount: 2, absenceFirstSeenAt: T0 };
  assert.equal(absenceGateSatisfied(completion, T0_PLUS_60S), true);
});

// ─── Behavior 6: elapsed 59999ms does not satisfy the gate ─────────────────

test('second confirmed absence with elapsed 59999ms does not satisfy the gate', () => {
  const completion = { absenceCount: 2, absenceFirstSeenAt: T0 };
  assert.equal(absenceGateSatisfied(completion, T0_PLUS_59999MS), false);
});

// ─── Behavior 7: unparseable or future-dated stamp fails closed ───────────

test('a recorded stamp that is unparseable never satisfies the gate', () => {
  const completion = { absenceCount: 2, absenceFirstSeenAt: 'not-a-date' };
  assert.equal(absenceGateSatisfied(completion, T0_PLUS_60S), false);
});

test('a recorded stamp later than nowIso never satisfies the gate', () => {
  const completion = { absenceCount: 2, absenceFirstSeenAt: T0_PLUS_60S };
  assert.equal(absenceGateSatisfied(completion, T0), false);
});

// ─── Behavior 8: present clears both members ───────────────────────────────

test('present after a recorded absence clears both members', () => {
  const marker = advanceAbsence({ absenceCount: 2, absenceFirstSeenAt: T0 }, EXISTENCE_VERDICT.PRESENT, T0_PLUS_60S);
  assert.deepEqual(marker, {});
  assert.equal(Object.prototype.hasOwnProperty.call(marker, 'absenceCount'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(marker, 'absenceFirstSeenAt'), false);
});

// ─── Behavior 9: unknown leaves both members byte-identical ────────────────

test('unknown after a recorded absence leaves both members byte-identical', () => {
  const previous = { absenceCount: 3, absenceFirstSeenAt: T0 };
  const marker = advanceAbsence(previous, EXISTENCE_VERDICT.UNKNOWN, T0_PLUS_60S);
  assert.deepEqual(marker, previous);
});

test('unknown with no prior marker at all produces no marker (both members absent)', () => {
  const marker = advanceAbsence(undefined, EXISTENCE_VERDICT.UNKNOWN, T0_PLUS_60S);
  assert.deepEqual(marker, {});
});

// ─── D-09: nowIso absent never advances the marker, never satisfies the gate ─

test('a confirmed-absent verdict with no nowIso never advances the marker (fail-closed, D-09)', () => {
  const marker = advanceAbsence(undefined, EXISTENCE_VERDICT.CONFIRMED_ABSENT, undefined);
  assert.deepEqual(marker, {});

  const withPrior = advanceAbsence({ absenceCount: 1, absenceFirstSeenAt: T0 }, EXISTENCE_VERDICT.CONFIRMED_ABSENT, undefined);
  assert.deepEqual(withPrior, { absenceCount: 1, absenceFirstSeenAt: T0 });
});

test('absenceGateSatisfied never satisfies the gate with no nowIso', () => {
  assert.equal(absenceGateSatisfied({ absenceCount: 2, absenceFirstSeenAt: T0 }, undefined), false);
});

// ─── Second confirmed absence increments count and preserves the ORIGINAL stamp ─

test('second confirmed absence increments the count and preserves the original stamp — never restamps', () => {
  const marker = advanceAbsence({ absenceCount: 1, absenceFirstSeenAt: T0 }, EXISTENCE_VERDICT.CONFIRMED_ABSENT, T0_PLUS_60S);
  assert.deepEqual(marker, { absenceCount: 2, absenceFirstSeenAt: T0 });
});

// ─── rebuildTriggered: the router-facing simulate-then-gate composition ────

test('rebuildTriggered is true for a second confirmed absence past the 60000ms gate', () => {
  const verdicts = [{ logicalKey: 'project', verdict: EXISTENCE_VERDICT.CONFIRMED_ABSENT }];
  const completions = { project: { absenceCount: 1, absenceFirstSeenAt: T0 } };
  assert.equal(rebuildTriggered(verdicts, completions, T0_PLUS_60S), true);
});

test('rebuildTriggered is false for a second confirmed absence short of the gate', () => {
  const verdicts = [{ logicalKey: 'project', verdict: EXISTENCE_VERDICT.CONFIRMED_ABSENT }];
  const completions = { project: { absenceCount: 1, absenceFirstSeenAt: T0 } };
  assert.equal(rebuildTriggered(verdicts, completions, T0_PLUS_59999MS), false);
});

test('rebuildTriggered is false for a present verdict, regardless of any prior marker', () => {
  const verdicts = [{ logicalKey: 'project', verdict: EXISTENCE_VERDICT.PRESENT }];
  const completions = { project: { absenceCount: 5, absenceFirstSeenAt: T0 } };
  assert.equal(rebuildTriggered(verdicts, completions, T0_PLUS_60S), false);
});

test('rebuildTriggered is false for an unknown verdict, regardless of any prior marker', () => {
  const verdicts = [{ logicalKey: 'project', verdict: EXISTENCE_VERDICT.UNKNOWN }];
  const completions = { project: { absenceCount: 5, absenceFirstSeenAt: T0 } };
  assert.equal(rebuildTriggered(verdicts, completions, T0_PLUS_60S), false);
});

test('rebuildTriggered called without a nowIso input never satisfies the recreate gate and never advances an absence marker (SC5)', () => {
  const verdicts = [{ logicalKey: 'project', verdict: EXISTENCE_VERDICT.CONFIRMED_ABSENT }];
  const completions = { project: { absenceCount: 1, absenceFirstSeenAt: T0 } };
  assert.equal(rebuildTriggered(verdicts, completions, undefined), false);
});

// ─── classifyExistence sort order (exactly collectOrphans' own sort) ───────

test('classifyExistence sorts verdicts by logical key with localeCompare numeric collation', () => {
  const verdicts = classifyExistence({
    completions: PROJECT_COMPLETIONS,
    remote: {},
    bootstrapRemote: { available: true, projectOutcome: 'resolved' },
  });
  const sorted = [...verdicts].sort((left, right) => left.logicalKey.localeCompare(right.logicalKey, undefined, { numeric: true }));
  assert.deepEqual(verdicts, sorted);
});

// ─── Plan 07-04 Task 1: namespace-complete classification (D-02/D-05/D-22) ─
//
// Widens `classifyExistence` from the `project` key alone to every
// participating bootstrap namespace: `field:*`, `option:status:*`,
// `option:autonomous:*`, `label:*`, `milestone:*`. `view:*` and
// `project-link` stay exempt (D-14) and must carry no verdict.

const FULL_BOOTSTRAP_REMOTE = Object.freeze({
  available: true,
  projectOutcome: 'resolved',
  fields: [
    { id: 'PVTF_gsdid', name: 'GSD ID' },
    { id: 'PVTF_phase', name: 'Phase' },
    { id: 'PVTF_autonomous', name: 'Autonomous', options: [{ id: 'OPT_yes', name: 'Yes' }, { id: 'OPT_no', name: 'No' }] },
  ],
  statusField: { id: 'PVTF_status', name: 'Status', options: [{ id: 'OPT_todo', name: 'Todo' }, { id: 'OPT_done', name: 'Done' }] },
  labels: [{ nodeId: 'LA_phase', name: 'gsd:phase' }],
  milestones: [{ nodeId: 'MI_v1', name: 'v1.0' }],
});

const UNAVAILABLE_BOOTSTRAP_REMOTE = Object.freeze({
  available: false,
  projectOutcome: 'unavailable',
  fields: [],
  statusField: null,
  labels: [],
  milestones: [],
});

const ZERO_ENUMERATED_BOOTSTRAP_REMOTE = Object.freeze({
  available: true,
  projectOutcome: 'absent',
  fields: [],
  statusField: null,
  labels: [],
  milestones: [],
});

const ALL_PARTICIPATING_COMPLETIONS = Object.freeze({
  project: { nodeId: 'PVT_1' },
  'field:gsd-id': { nodeId: 'PVTF_gsdid' },
  'option:status:todo': { nodeId: 'OPT_todo' },
  'option:autonomous:yes': { nodeId: 'OPT_yes' },
  'label:gsd-phase': { nodeId: 'LA_phase' },
  'milestone:v1-0': { nodeId: 'MI_v1' },
});

test('classifyExistence returns present for a mapped field key whose recorded node ID appears in an available bootstrap remote read', () => {
  const verdicts = classifyExistence({ completions: { 'field:gsd-id': { nodeId: 'PVTF_gsdid' } }, bootstrapRemote: FULL_BOOTSTRAP_REMOTE });
  assert.deepEqual(verdicts, [{ logicalKey: 'field:gsd-id', verdict: EXISTENCE_VERDICT.PRESENT }]);
});

test('classifyExistence returns confirmed-absent for a mapped field key whose recorded node ID does not appear in an available bootstrap remote read', () => {
  const verdicts = classifyExistence({ completions: { 'field:gsd-id': { nodeId: 'PVTF_deleted' } }, bootstrapRemote: FULL_BOOTSTRAP_REMOTE });
  assert.deepEqual(verdicts, [{ logicalKey: 'field:gsd-id', verdict: EXISTENCE_VERDICT.CONFIRMED_ABSENT }]);
});

const OTHER_PARTICIPATING_NAMESPACES = [
  { logicalKey: 'option:status:todo', presentNodeId: 'OPT_todo', absentNodeId: 'OPT_bogus' },
  { logicalKey: 'option:autonomous:yes', presentNodeId: 'OPT_yes', absentNodeId: 'OPT_bogus' },
  { logicalKey: 'label:gsd-phase', presentNodeId: 'LA_phase', absentNodeId: 'LA_bogus' },
  { logicalKey: 'milestone:v1-0', presentNodeId: 'MI_v1', absentNodeId: 'MI_bogus' },
];

for (const { logicalKey, presentNodeId, absentNodeId } of OTHER_PARTICIPATING_NAMESPACES) {
  test(`classifyExistence classifies ${logicalKey} present/confirmed-absent/unknown exactly as it does a field key`, () => {
    const present = classifyExistence({ completions: { [logicalKey]: { nodeId: presentNodeId } }, bootstrapRemote: FULL_BOOTSTRAP_REMOTE });
    assert.deepEqual(present, [{ logicalKey, verdict: EXISTENCE_VERDICT.PRESENT }]);

    const absent = classifyExistence({ completions: { [logicalKey]: { nodeId: absentNodeId } }, bootstrapRemote: FULL_BOOTSTRAP_REMOTE });
    assert.deepEqual(absent, [{ logicalKey, verdict: EXISTENCE_VERDICT.CONFIRMED_ABSENT }]);

    const unknown = classifyExistence({ completions: { [logicalKey]: { nodeId: presentNodeId } }, bootstrapRemote: UNAVAILABLE_BOOTSTRAP_REMOTE });
    assert.deepEqual(unknown, [{ logicalKey, verdict: EXISTENCE_VERDICT.UNKNOWN }]);
  });
}

test('classifyExistence excludes a mapped view key and a mapped project-link key from its returned collection even alongside participating keys', () => {
  const verdicts = classifyExistence({
    completions: {
      project: { nodeId: 'PVT_1' },
      'view:roadmap': { nodeId: 'PVTV_1' },
      'project-link': { nodeId: 'PVT_1' },
      'field:gsd-id': { nodeId: 'PVTF_gsdid' },
    },
    bootstrapRemote: FULL_BOOTSTRAP_REMOTE,
  });
  assert.deepEqual(verdicts.map((entry) => entry.logicalKey).sort(), ['field:gsd-id', 'project']);
});

test('classifyExistence over an empty completions map yields zero verdicts', () => {
  assert.deepEqual(classifyExistence({ completions: {}, bootstrapRemote: FULL_BOOTSTRAP_REMOTE }), []);
});

test('a successful bootstrap read enumerating zero objects yields confirmed-absent for every mapped bootstrap key, never unknown', () => {
  const verdicts = classifyExistence({ completions: ALL_PARTICIPATING_COMPLETIONS, bootstrapRemote: ZERO_ENUMERATED_BOOTSTRAP_REMOTE });
  assert.equal(verdicts.length, 6);
  for (const entry of verdicts) assert.equal(entry.verdict, EXISTENCE_VERDICT.CONFIRMED_ABSENT, entry.logicalKey);
});

test('an unavailable bootstrap read whose arrays are empty yields unknown for every mapped bootstrap key, never confirmed-absent', () => {
  const verdicts = classifyExistence({ completions: ALL_PARTICIPATING_COMPLETIONS, bootstrapRemote: UNAVAILABLE_BOOTSTRAP_REMOTE });
  assert.equal(verdicts.length, 6);
  for (const entry of verdicts) assert.equal(entry.verdict, EXISTENCE_VERDICT.UNKNOWN, entry.logicalKey);
  assert.ok(verdicts.every((entry) => entry.verdict !== EXISTENCE_VERDICT.CONFIRMED_ABSENT));
});

test('classifyExistence returns byte-identical, key-sorted collections across two invocations over identical mixed-namespace input', () => {
  const first = classifyExistence({ completions: ALL_PARTICIPATING_COMPLETIONS, bootstrapRemote: FULL_BOOTSTRAP_REMOTE });
  const second = classifyExistence({ completions: ALL_PARTICIPATING_COMPLETIONS, bootstrapRemote: FULL_BOOTSTRAP_REMOTE });
  assert.deepEqual(first, second);
  const sortedByKey = [...first].sort((left, right) => left.logicalKey.localeCompare(right.logicalKey, undefined, { numeric: true }));
  assert.deepEqual(first, sortedByKey);
});
