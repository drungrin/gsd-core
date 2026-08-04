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
