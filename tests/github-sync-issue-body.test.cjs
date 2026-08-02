/* Pure renderer tests: no disk, no transport, no gh. */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  phaseMarker,
  FENCE_BEGIN,
  FENCE_END,
  renderPhaseRegion,
  renderNewIssueBody,
  spliceRegion,
  SPLICE_RESULT,
  contentHash,
  renderFieldState,
  parseFieldState,
  changedFields,
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

/* --- spliceRegion (plan 04-03 Task 1): splice a region by severity --- */

test('spliceRegion: a body with exactly one fence pair replaces only the interior; text before begin and after end survives byte-for-byte', () => {
  const before = 'Some developer prose before the fence.';
  const after = 'Some developer prose after the fence.';
  const oldRegion = 'old region content';
  const newRegion = 'new region content';
  const body = `${before}\n${FENCE_BEGIN}\n${oldRegion}\n${FENCE_END}\n${after}`;
  const result = spliceRegion(body, newRegion);
  assert.equal(result.kind, SPLICE_RESULT.SPLICED);
  assert.ok(result.body.startsWith(`${before}\n${FENCE_BEGIN}`));
  assert.ok(result.body.endsWith(`${FENCE_END}\n${after}`));
  assert.ok(result.body.includes(newRegion));
  assert.ok(!result.body.includes(oldRegion));
});

test('spliceRegion: fence pair in the middle of the body — prose above and below both survive and keep their order', () => {
  const above = '# Above heading\n\nSome prose above.';
  const below = 'Some prose below.\n\n## Below heading';
  const body = `${above}\n${FENCE_BEGIN}\nold\n${FENCE_END}\n${below}`;
  const result = spliceRegion(body, 'new');
  assert.equal(result.kind, SPLICE_RESULT.SPLICED);
  const aboveIndex = result.body.indexOf(above);
  const belowIndex = result.body.indexOf(below);
  assert.ok(aboveIndex >= 0 && belowIndex >= 0, 'both blocks must survive verbatim');
  assert.ok(aboveIndex < belowIndex, 'the region must not be normalized to the top — above stays above below');
});

test('spliceRegion: surrounding markdown headings, code fences, and a non-GSD HTML comment are undisturbed', () => {
  const above = '# Title\n\n```js\nconst x = 1;\n```\n\n<!-- not-a-gsd-token -->';
  const below = '<!-- another comment -->\n\n```bash\necho hi\n```';
  const body = `${above}\n${FENCE_BEGIN}\nold\n${FENCE_END}\n${below}`;
  const result = spliceRegion(body, 'new');
  assert.equal(result.kind, SPLICE_RESULT.SPLICED);
  assert.ok(result.body.includes(above));
  assert.ok(result.body.includes(below));
});

test('spliceRegion: a body with the identity marker and no fence token at all self-heals — original text preserved byte-for-byte, new region appended', () => {
  const body = `${phaseMarker('04')}\nSome developer prose, no fences here.`;
  const result = spliceRegion(body, 'fresh region');
  assert.equal(result.kind, SPLICE_RESULT.SELF_HEAL);
  assert.ok(result.body.startsWith(body));
  assert.ok(result.body.endsWith(`${FENCE_BEGIN}\nfresh region\n${FENCE_END}\n`));
});

test('spliceRegion: two begin fences and one end fence is damaged, with a detail naming the observed counts', () => {
  const body = `${FENCE_BEGIN}\nx\n${FENCE_BEGIN}\ny\n${FENCE_END}`;
  const result = spliceRegion(body, 'new');
  assert.equal(result.kind, SPLICE_RESULT.DAMAGED);
  assert.match(result.detail, /2/);
  assert.match(result.detail, /1/);
});

test('spliceRegion: one begin fence and two end fences is damaged', () => {
  const body = `${FENCE_BEGIN}\nx\n${FENCE_END}\ny\n${FENCE_END}`;
  const result = spliceRegion(body, 'new');
  assert.equal(result.kind, SPLICE_RESULT.DAMAGED);
});

test('spliceRegion: a begin fence with no end fence is damaged', () => {
  const body = `${FENCE_BEGIN}\nx`;
  const result = spliceRegion(body, 'new');
  assert.equal(result.kind, SPLICE_RESULT.DAMAGED);
});

test('spliceRegion: an end fence with no begin fence is damaged', () => {
  const body = `x\n${FENCE_END}`;
  const result = spliceRegion(body, 'new');
  assert.equal(result.kind, SPLICE_RESULT.DAMAGED);
});

test('spliceRegion: end fence preceding begin fence is damaged, with a detail naming the inversion rather than the counts', () => {
  const body = `x\n${FENCE_END}\ny\n${FENCE_BEGIN}\nz`;
  const result = spliceRegion(body, 'new');
  assert.equal(result.kind, SPLICE_RESULT.DAMAGED);
  assert.doesNotMatch(result.detail, /\b1 begin\b|\b1 end\b/);
  assert.match(result.detail, /precede|before|invert/i);
});

test('spliceRegion: a damaged result has no body property at all (presence check, not merely a falsy check)', () => {
  const result = spliceRegion(`${FENCE_BEGIN}\nx`, 'new');
  assert.equal(result.kind, SPLICE_RESULT.DAMAGED);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'body'), false);
});

test('spliceRegion: an empty-string body returns self-heal, not damaged, and the result is a bare fenced region', () => {
  const result = spliceRegion('', 'region content');
  assert.equal(result.kind, SPLICE_RESULT.SELF_HEAL);
  assert.equal(result.body, `\n${FENCE_BEGIN}\nregion content\n${FENCE_END}\n`);
});

test('spliceRegion: a region resembling a fence token by one character does not affect counting', () => {
  const almostBegin = FENCE_BEGIN.replace('begin', 'beginx');
  const body = `prose\n${FENCE_BEGIN}\nold\n${FENCE_END}\nmore prose containing ${almostBegin}`;
  const result = spliceRegion(body, 'new');
  assert.equal(result.kind, SPLICE_RESULT.SPLICED);
});

test('spliceRegion: never throws for any adversarial fence arrangement, including empty and fence-only bodies', () => {
  const inputs = ['', 'plain text', FENCE_BEGIN, FENCE_END, `${FENCE_BEGIN}${FENCE_END}`, `${FENCE_END}${FENCE_BEGIN}`];
  for (const input of inputs) {
    assert.doesNotThrow(() => spliceRegion(input, 'region'));
  }
});

/* --- contentHash / renderFieldState / parseFieldState / changedFields (plan 04-03 Task 2) --- */

test('contentHash: returns a lowercase hex string of fixed length (sha256 = 64 chars), stable across repeated calls', () => {
  const projection = { title: 'T', region: 'R', milestoneNumber: 1 };
  const hash = contentHash(projection);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, contentHash(projection));
});

test('contentHash: is a pure function with no I/O and no clock — matches a value the test itself computes from the documented JSON.stringify({title, region, milestoneNumber}) serialization, not a hardcoded digest', () => {
  const projection = { title: 'Phase Title', region: 'region body text', milestoneNumber: 3 };
  const expected = crypto.createHash('sha256')
    .update(JSON.stringify({ title: projection.title, region: projection.region, milestoneNumber: projection.milestoneNumber }))
    .digest('hex');
  assert.equal(contentHash(projection), expected);
});

test('contentHash: changing only the title changes the hash', () => {
  const base = { title: 'A', region: 'R', milestoneNumber: 1 };
  assert.notEqual(contentHash(base), contentHash({ ...base, title: 'B' }));
});

test('contentHash: changing only the region changes the hash', () => {
  const base = { title: 'A', region: 'R', milestoneNumber: 1 };
  assert.notEqual(contentHash(base), contentHash({ ...base, region: 'S' }));
});

test('contentHash: changing only the milestone number changes the hash', () => {
  const base = { title: 'A', region: 'R', milestoneNumber: 1 };
  assert.notEqual(contentHash(base), contentHash({ ...base, milestoneNumber: 2 }));
});

test('contentHash: a title of "a" with a region of "b" does not collide with a title of "b" with a region of "a"', () => {
  const first = contentHash({ title: 'a', region: 'b', milestoneNumber: 1 });
  const second = contentHash({ title: 'b', region: 'a', milestoneNumber: 1 });
  assert.notEqual(first, second);
});

test('contentHash: a title or region containing the serialization\'s own delimiter characters still round-trips to a stable, non-colliding hash', () => {
  const withDelims = { title: 'Title","region":"injected', region: 'plain', milestoneNumber: 1 };
  const plain = { title: 'plain-title', region: 'plain', milestoneNumber: 1 };
  const hash1 = contentHash(withDelims);
  assert.equal(hash1, contentHash(withDelims));
  assert.notEqual(hash1, contentHash(plain));
});

test('renderFieldState/parseFieldState: round-trips the four field values, including an empty requirements list and a status carrying a space', () => {
  const values = { gsdId: 'issue:phase:04', phaseId: '04', requirements: [], status: 'In Progress' };
  const serialized = renderFieldState(values);
  assert.equal(typeof serialized, 'string');
  const parsed = parseFieldState(serialized);
  assert.equal(parsed.kind, 'known');
  assert.deepEqual(parsed.values, values);
});

test('renderFieldState/parseFieldState: round-trips a non-empty requirements list unchanged, in order', () => {
  const values = { gsdId: 'issue:phase:04', phaseId: '04', requirements: ['PHASE-01', 'PHASE-02'], status: 'Todo' };
  const parsed = parseFieldState(renderFieldState(values));
  assert.equal(parsed.kind, 'known');
  assert.deepEqual(parsed.values.requirements, values.requirements);
});

test('parseFieldState: a malformed or empty string returns a typed unknown result rather than throwing or returning partial values', () => {
  const malformed = [
    '',
    'not json',
    '{"gsdId":"x"}',
    '[]',
    'null',
    '{"gsdId":1,"phaseId":"04","requirements":[],"status":"Todo"}',
    '{"gsdId":"x","phaseId":"04","requirements":["ok",1],"status":"Todo"}',
  ];
  for (const input of malformed) {
    const result = parseFieldState(input);
    assert.equal(result.kind, 'unknown', `expected unknown for input: ${input}`);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'values'), false);
  }
});

test('parseFieldState: never throws for any malformed input', () => {
  for (const input of ['', 'not json', '{{{', 'undefined', '42']) {
    assert.doesNotThrow(() => parseFieldState(input));
  }
});

test('changedFields: a previous and desired state differing in exactly one field reports exactly that field', () => {
  const previousValues = { gsdId: 'a', phaseId: '04', requirements: ['R1'], status: 'Todo' };
  const previous = { kind: 'known', values: previousValues };
  const desired = { ...previousValues, status: 'Done' };
  assert.deepEqual(changedFields(previous, desired), ['status']);
});

test('changedFields: an unknown previous state reports all four fields as changed', () => {
  const desired = { gsdId: 'a', phaseId: '04', requirements: ['R1'], status: 'Todo' };
  const changed = changedFields({ kind: 'unknown' }, desired);
  assert.deepEqual([...changed].sort(), ['gsdId', 'phaseId', 'requirements', 'status'].sort());
});

test('changedFields: an identical previous and desired state reports no fields as changed', () => {
  const values = { gsdId: 'a', phaseId: '04', requirements: ['R1', 'R2'], status: 'Todo' };
  const previous = { kind: 'known', values: { ...values, requirements: [...values.requirements] } };
  assert.deepEqual(changedFields(previous, values), []);
});
