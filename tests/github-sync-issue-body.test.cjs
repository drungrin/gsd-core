/* Pure renderer tests: no disk, no transport, no gh. */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  phaseMarker,
  FENCE_BEGIN,
  FENCE_END,
  renderPhaseRegion,
  renderNewIssueBody,
} = require('../gsd-core/bin/lib/github-sync-issue-body.cjs');

const PHASE = { id: '04', title: 'Phase → Issue Sync', goal: 'Sync roadmap phases as GitHub issues.' };

test('renderNewIssueBody: first line is the marker, second line opens the region fence, closed by the end fence, then one trailing newline and nothing else', () => {
  const body = renderNewIssueBody(PHASE);
  const lines = body.split('\n');

  assert.equal(lines[0], phaseMarker(PHASE.id));
  assert.equal(lines[1], FENCE_BEGIN);
  assert.equal(lines[lines.length - 2], FENCE_END);
  assert.equal(lines[lines.length - 1], '', 'body must end with exactly one trailing newline');
  assert.equal(body.endsWith(`${FENCE_END}\n`), true);
  assert.equal(body.endsWith(`${FENCE_END}\n\n`), false, 'must not carry a second trailing newline');
});

test('renderNewIssueBody and renderPhaseRegion contain no interactive markdown checkbox in any form', () => {
  const body = renderNewIssueBody(PHASE);
  const region = renderPhaseRegion(PHASE);

  for (const text of [body, region]) {
    assert.doesNotMatch(text, /\[ \]/, 'unchecked checkbox must never appear');
    assert.doesNotMatch(text, /\[x\]/i, 'checked checkbox must never appear (case-insensitive)');
    assert.doesNotMatch(text, /^\s*-\s*\[/m, 'no list item may open a bracketed control');
  }
});

test('renderPhaseRegion contains the phase goal and a provenance line naming .planning/ROADMAP.md and the phase section', () => {
  const region = renderPhaseRegion(PHASE);
  assert.ok(region.includes(PHASE.goal), 'region must contain the phase goal verbatim');
  assert.ok(region.includes('.planning/ROADMAP.md'), 'region must name the roadmap source file');
  assert.ok(region.includes(PHASE.id), 'region must name the phase\'s own section/id');
});

test('renderPhaseRegion falls back to a placeholder when the goal is empty, never an empty line silently', () => {
  const region = renderPhaseRegion({ ...PHASE, goal: '' });
  assert.ok(region.length > 0);
  assert.doesNotMatch(region, /\n\n\n/, 'no empty goal should produce a stray blank paragraph run');
});

test('phaseMarker: the marker for id "04" and id "2.1" differ and neither is a substring of the other', () => {
  const marker04 = phaseMarker('04');
  const marker21 = phaseMarker('2.1');

  assert.notEqual(marker04, marker21);
  assert.equal(marker04.includes(marker21), false);
  assert.equal(marker21.includes(marker04), false);
});

test('phaseMarker: takes an already-normalized id and does not normalize it itself — "04" and "4" produce different markers', () => {
  assert.notEqual(phaseMarker('04'), phaseMarker('4'));
});

test('FENCE_BEGIN and FENCE_END are frozen, distinct literal tokens, neither a substring of a phase marker', () => {
  assert.notEqual(FENCE_BEGIN, FENCE_END);
  const marker = phaseMarker('04');
  assert.equal(marker.includes(FENCE_BEGIN), false);
  assert.equal(marker.includes(FENCE_END), false);
  assert.equal(FENCE_BEGIN.includes('gsd:phase'), false);
  assert.equal(FENCE_END.includes('gsd:phase'), false);
});
