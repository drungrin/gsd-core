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
  ISSUE_LOGICAL_KEY,
  isIssueBearingLogicalKey,
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

// ─── Plan 07-04 Task 3: widen rebuildTriggered to every participating
// namespace (D-02). The gate itself (two confirmed absences + RECREATE_GRACE_MS
// elapsed) is unchanged — only the set of keys that can reach it widens.

const TRIGGER_PARTICIPATING_KEYS = ['project', 'field:gsd-id', 'option:status:todo', 'option:autonomous:yes', 'label:gsd-phase', 'milestone:v1-0'];

for (const logicalKey of TRIGGER_PARTICIPATING_KEYS) {
  test(`rebuildTriggered is true when ${logicalKey} alone reaches its second confirmed absence past the 60000ms gate`, () => {
    const verdicts = [{ logicalKey, verdict: EXISTENCE_VERDICT.CONFIRMED_ABSENT }];
    const completions = { [logicalKey]: { absenceCount: 1, absenceFirstSeenAt: T0 } };
    assert.equal(rebuildTriggered(verdicts, completions, T0_PLUS_60S), true);
  });

  test(`rebuildTriggered is false when ${logicalKey} alone is confirmed absent for the first time, regardless of elapsed time`, () => {
    const verdicts = [{ logicalKey, verdict: EXISTENCE_VERDICT.CONFIRMED_ABSENT }];
    assert.equal(rebuildTriggered(verdicts, {}, T0_PLUS_60S), false);
  });
}

test('rebuildTriggered is true for a single non-project participating key past the gate even though the project itself is present — a single key is sufficient, not project specifically', () => {
  const verdicts = [
    { logicalKey: 'project', verdict: EXISTENCE_VERDICT.PRESENT },
    { logicalKey: 'field:gsd-id', verdict: EXISTENCE_VERDICT.CONFIRMED_ABSENT },
  ];
  const completions = { 'field:gsd-id': { absenceCount: 1, absenceFirstSeenAt: T0 } };
  assert.equal(rebuildTriggered(verdicts, completions, T0_PLUS_60S), true);
});

test('rebuildTriggered never fires for a confirmed-absent view key, at any absence count, even seeded directly past the gate (D-14)', () => {
  const verdicts = [{ logicalKey: 'view:roadmap', verdict: EXISTENCE_VERDICT.CONFIRMED_ABSENT }];
  const completions = { 'view:roadmap': { absenceCount: 5, absenceFirstSeenAt: T0 } };
  assert.equal(rebuildTriggered(verdicts, completions, T0_PLUS_60S), false);
});

test('rebuildTriggered never fires for a confirmed-absent project-link key, even seeded directly past the gate (D-14)', () => {
  const verdicts = [{ logicalKey: 'project-link', verdict: EXISTENCE_VERDICT.CONFIRMED_ABSENT }];
  const completions = { 'project-link': { absenceCount: 5, absenceFirstSeenAt: T0 } };
  assert.equal(rebuildTriggered(verdicts, completions, T0_PLUS_60S), false);
});

test('rebuildTriggered never fires for an unknown verdict, regardless of absence count, across every participating namespace', () => {
  for (const logicalKey of TRIGGER_PARTICIPATING_KEYS) {
    const verdicts = [{ logicalKey, verdict: EXISTENCE_VERDICT.UNKNOWN }];
    const completions = { [logicalKey]: { absenceCount: 5, absenceFirstSeenAt: T0 } };
    assert.equal(rebuildTriggered(verdicts, completions, T0_PLUS_60S), false, logicalKey);
  }
});

// ─── Plan 07-05 Task 1 (D-11/D-12): issue-bearing namespace classification —
// re-resolution by (owner, repo, number) runs BEFORE any issue's absence
// verdict. `confirmed-absent` is reachable only when BOTH the cached node ID
// and the (owner, repo, number) triple fail against a read that succeeded.

test('isIssueBearingLogicalKey admits exactly the phase-issue, plan-issue, and legacy phase project-item key forms', () => {
  assert.equal(isIssueBearingLogicalKey(ISSUE_LOGICAL_KEY.phaseIssue('04')), true);
  assert.equal(isIssueBearingLogicalKey(ISSUE_LOGICAL_KEY.planIssue('04-03')), true);
  assert.equal(isIssueBearingLogicalKey(ISSUE_LOGICAL_KEY.legacyPhase('04')), true);
  // Every reserved bootstrap-namespace key, and the plan's own (non-issue) project-item key, are excluded.
  assert.equal(isIssueBearingLogicalKey('plan:04-03'), false);
  assert.equal(isIssueBearingLogicalKey('project'), false);
  assert.equal(isIssueBearingLogicalKey('project-link'), false);
  assert.equal(isIssueBearingLogicalKey('field:gsd-id'), false);
  assert.equal(isIssueBearingLogicalKey('option:status:todo'), false);
  assert.equal(isIssueBearingLogicalKey('option:autonomous:yes'), false);
  assert.equal(isIssueBearingLogicalKey('label:gsd-phase'), false);
  assert.equal(isIssueBearingLogicalKey('milestone:v1-0'), false);
  assert.equal(isIssueBearingLogicalKey('view:roadmap'), false);
});

/** A `remote.issueNodeIds` wrapper recording every key ever read from it — the injected spy Task 1's acceptance criteria requires. */
function issueNodeIdsSpy(realMap) {
  const accessed = [];
  const proxy = new Proxy(realMap, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') accessed.push(prop);
      return Reflect.get(target, prop, receiver);
    },
  });
  return { proxy, accessed };
}

test('classifyExistence returns present for an issue-bearing key whose cached node ID appears among the run\'s own project items, without consulting the by-number lookup at all', () => {
  const spy = issueNodeIdsSpy({});
  const remote = {
    available: true,
    items: [{ id: 'item-05', content: { id: 'ISSUE_NODE_900', number: 900 } }],
    issueNodeIds: spy.proxy,
  };
  const verdicts = classifyExistence({
    completions: { [ISSUE_LOGICAL_KEY.phaseIssue('05')]: { nodeId: 'ISSUE_NODE_900', issueNumber: 900 } },
    remote,
  });
  assert.deepEqual(verdicts, [{ logicalKey: 'issue:phase:05', verdict: EXISTENCE_VERDICT.PRESENT }]);
  assert.deepEqual(spy.accessed, [], 'the node-ID-resolves case must reach its verdict without touching issueNodeIds at all');
});

test('classifyExistence returns present for an issue-bearing key whose cached node ID does not appear, but whose number resolves against the same successful read', () => {
  const remote = {
    available: true,
    items: [],
    issueNodeIds: { 900: 'ISSUE_NODE_NEW' },
  };
  const verdicts = classifyExistence({
    completions: { [ISSUE_LOGICAL_KEY.phaseIssue('05')]: { nodeId: 'ISSUE_NODE_OLD', issueNumber: 900 } },
    remote,
  });
  assert.deepEqual(verdicts, [{ logicalKey: 'issue:phase:05', verdict: EXISTENCE_VERDICT.PRESENT }]);
});

test('classifyExistence returns confirmed-absent for an issue-bearing key where neither the cached node ID nor the number resolves against a successful read', () => {
  const remote = { available: true, items: [], issueNodeIds: {} };
  const verdicts = classifyExistence({
    completions: { [ISSUE_LOGICAL_KEY.phaseIssue('05')]: { nodeId: 'ISSUE_NODE_GONE', issueNumber: 900 } },
    remote,
  });
  assert.deepEqual(verdicts, [{ logicalKey: 'issue:phase:05', verdict: EXISTENCE_VERDICT.CONFIRMED_ABSENT }]);
});

test('classifyExistence returns unknown for an issue-bearing key whenever the remote read is unavailable, even when its (empty) arrays would otherwise resolve both lookups', () => {
  const remote = {
    available: false,
    items: [{ id: 'item-05', content: { id: 'ISSUE_NODE_900', number: 900 } }],
    issueNodeIds: { 900: 'ISSUE_NODE_900' },
  };
  const verdicts = classifyExistence({
    completions: { [ISSUE_LOGICAL_KEY.phaseIssue('05')]: { nodeId: 'ISSUE_NODE_900', issueNumber: 900 } },
    remote,
  });
  assert.deepEqual(verdicts, [{ logicalKey: 'issue:phase:05', verdict: EXISTENCE_VERDICT.UNKNOWN }]);
});

test('classifyExistence returns unknown for an issue-bearing key when no remote is supplied at all', () => {
  const verdicts = classifyExistence({ completions: { [ISSUE_LOGICAL_KEY.phaseIssue('05')]: { nodeId: 'X', issueNumber: 900 } } });
  assert.deepEqual(verdicts, [{ logicalKey: 'issue:phase:05', verdict: EXISTENCE_VERDICT.UNKNOWN }]);
});

test('classifyExistence over a map holding a project completion, a milestone completion, and an issue completion reads only the issue number through the by-number lookup', () => {
  const spy = issueNodeIdsSpy({ 900: 'ISSUE_NODE_900' });
  const verdicts = classifyExistence({
    completions: {
      project: { nodeId: 'PVT_1', issueNumber: 9 },
      'milestone:v1-0': { nodeId: 'MI_1', issueNumber: 4 },
      [ISSUE_LOGICAL_KEY.phaseIssue('05')]: { nodeId: 'ISSUE_NODE_STALE', issueNumber: 900 },
    },
    remote: { available: true, items: [], issueNodeIds: spy.proxy },
    bootstrapRemote: { available: true, projectOutcome: 'resolved' },
  });
  assert.deepEqual(spy.accessed, ['900'], 'only the issue completion\'s own number may reach the by-number lookup — never the project\'s or the milestone\'s');
  const issueVerdict = verdicts.find((entry) => entry.logicalKey === 'issue:phase:05');
  assert.equal(issueVerdict.verdict, EXISTENCE_VERDICT.PRESENT);
});

test('classifyExistence classifies the legacy phase-prefixed key form by number exactly as the current issue-prefixed form does', () => {
  const presentRemote = { available: true, items: [], issueNodeIds: { 77: 'ISSUE_NODE_NEW' } };
  const presentVerdicts = classifyExistence({
    completions: { [ISSUE_LOGICAL_KEY.legacyPhase('09')]: { nodeId: 'item-09-stale', issueNumber: 77 } },
    remote: presentRemote,
  });
  assert.deepEqual(presentVerdicts, [{ logicalKey: 'phase:09', verdict: EXISTENCE_VERDICT.PRESENT }]);

  const absentRemote = { available: true, items: [], issueNodeIds: {} };
  const absentVerdicts = classifyExistence({
    completions: { [ISSUE_LOGICAL_KEY.legacyPhase('09')]: { nodeId: 'item-09-stale', issueNumber: 77 } },
    remote: absentRemote,
  });
  assert.deepEqual(absentVerdicts, [{ logicalKey: 'phase:09', verdict: EXISTENCE_VERDICT.CONFIRMED_ABSENT }]);
});

test('classifyExistence excludes a mapped plan project-item key (plan:<id>, not issue-bearing) from its returned collection even though it carries a number', () => {
  const verdicts = classifyExistence({
    completions: { 'plan:04-03': { nodeId: 'item-plan', issueNumber: 55 } },
    remote: { available: true, items: [], issueNodeIds: {} },
  });
  assert.deepEqual(verdicts, []);
});

test('classifyExistence over a mix of bootstrap-namespace and issue-bearing keys classifies each through its own axis, sorted together', () => {
  const remote = { available: true, items: [], issueNodeIds: { 900: 'ISSUE_NODE_900' } };
  const bootstrapRemote = { available: true, projectOutcome: 'resolved', fields: [], statusField: null, labels: [], milestones: [] };
  const verdicts = classifyExistence({
    completions: {
      project: { nodeId: 'PVT_1' },
      [ISSUE_LOGICAL_KEY.phaseIssue('05')]: { nodeId: 'ISSUE_NODE_900', issueNumber: 900 },
    },
    remote,
    bootstrapRemote,
  });
  assert.deepEqual(verdicts, [
    { logicalKey: 'issue:phase:05', verdict: EXISTENCE_VERDICT.PRESENT },
    { logicalKey: 'project', verdict: EXISTENCE_VERDICT.PRESENT },
  ]);
});
