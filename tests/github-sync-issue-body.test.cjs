/* Pure renderer tests: no disk, no transport, no gh. */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
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
  planMarker,
  TASK_GLYPH,
  renderTaskList,
  renderPlanRegion,
  renderNewPlanIssueBody,
  DEPENDENCY_REF_SENTINEL,
  countDependencyRefSlots,
  substituteDependencyRefs,
  PHASE_FIELD_NAMES,
  PLAN_FIELD_NAMES,
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

/* --- renderPhaseRegion: the full D-14 region (plan 04-05 Task 1) --- */

const FULL_PHASE = {
  id: '04',
  title: 'Phase → Issue Sync',
  goal: 'Sync roadmap phases as GitHub issues.',
  successCriteria: ['First criterion.', 'Second criterion.', 'Third criterion.'],
  requirements: ['PHASE-01', 'PHASE-02', 'PHASE-03'],
};

test('renderPhaseRegion: a phase with a goal, three success criteria, and three requirement IDs contains the goal, all three criteria in source order, and all three IDs', () => {
  const region = renderPhaseRegion(FULL_PHASE);
  assert.ok(region.includes(FULL_PHASE.goal));
  const criteriaIndexes = FULL_PHASE.successCriteria.map((criterion) => region.indexOf(criterion));
  assert.ok(criteriaIndexes.every((index) => index >= 0), 'every criterion must appear');
  assert.deepEqual(criteriaIndexes, [...criteriaIndexes].sort((a, b) => a - b), 'criteria must appear in source order');
  for (const requirementId of FULL_PHASE.requirements) {
    assert.ok(region.includes(requirementId), `region must contain requirement id ${requirementId}`);
  }
});

test('renderPhaseRegion: success criteria render as a plain numbered list — each ordinal prefixes its own criterion text', () => {
  const region = renderPhaseRegion(FULL_PHASE);
  FULL_PHASE.successCriteria.forEach((criterion, index) => {
    assert.match(region, new RegExp(`${index + 1}\\.\\s+${criterion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });
});

test('renderPhaseRegion: no markdown checkbox appears anywhere, in any clickable spelling, empty or checked, even with criteria and requirements populated', () => {
  const region = renderPhaseRegion(FULL_PHASE);
  const body = renderNewIssueBody(FULL_PHASE);
  for (const text of [region, body]) {
    assert.doesNotMatch(text, /\[ \]/, 'unchecked checkbox must never appear');
    assert.doesNotMatch(text, /\[x\]/i, 'checked checkbox must never appear (case-insensitive)');
    assert.doesNotMatch(text, /^\s*-\s*\[/m, 'no list item may open a bracketed control');
  }
});

test('renderPhaseRegion: requirement IDs render as plain text, not links and not checkboxes', () => {
  const region = renderPhaseRegion(FULL_PHASE);
  assert.doesNotMatch(region, /\[PHASE-\d+\]\(/, 'requirement IDs must not render as markdown links');
  for (const requirementId of FULL_PHASE.requirements) {
    assert.doesNotMatch(region, new RegExp(`\\[${requirementId}\\]`), 'a requirement ID must never be wrapped in brackets (a link or checkbox opening)');
  }
});

test('renderPhaseRegion: the provenance line names .planning/ROADMAP.md and the phase\'s own section, and states the issue is a regenerated projection', () => {
  const region = renderPhaseRegion(FULL_PHASE);
  assert.ok(region.includes('.planning/ROADMAP.md'));
  assert.ok(region.includes(FULL_PHASE.id));
  assert.match(region, /projection/i);
  assert.match(region, /regenerat/i);
});

test('renderPhaseRegion: the region contains no dependency line and no plan count, even when the phase object carries extra properties naming them', () => {
  const hostilePhase = { ...FULL_PHASE, dependsOn: ['03'], planCount: 7, wave: 2 };
  const region = renderPhaseRegion(hostilePhase);
  assert.doesNotMatch(region, /Depends on/i);
  assert.doesNotMatch(region, /plan count/i);
  assert.doesNotMatch(region, /\b7\b/, 'the injected plan count value must never appear');
});

test('renderPhaseRegion: a phase with zero success criteria renders the goal and provenance with no criteria heading at all', () => {
  const region = renderPhaseRegion({ ...FULL_PHASE, successCriteria: [] });
  assert.doesNotMatch(region, /## Success Criteria/);
  assert.ok(region.includes(FULL_PHASE.goal));
  assert.ok(region.includes('.planning/ROADMAP.md'));
});

test('renderPhaseRegion: a phase with zero requirement IDs renders the same way for the requirements section', () => {
  const region = renderPhaseRegion({ ...FULL_PHASE, requirements: [] });
  assert.doesNotMatch(region, /## Requirements/);
  assert.ok(region.includes(FULL_PHASE.goal));
});

test('renderPhaseRegion: a phase with neither successCriteria nor requirements supplied at all (omitted, not empty) renders with no headings for either', () => {
  const bare = { id: '04', title: 'T', goal: 'g' };
  const region = renderPhaseRegion(bare);
  assert.doesNotMatch(region, /## Success Criteria/);
  assert.doesNotMatch(region, /## Requirements/);
});

test('renderPhaseRegion: a goal, a criterion, or a requirement ID containing markdown control characters, an HTML comment, or a string resembling a fence token renders without being interpreted, and the full body still splices cleanly', () => {
  const hostilePhase = {
    id: '04',
    title: 'T',
    goal: 'Goal with <!-- not-a-gsd-fence --> and *markdown* and a near-fence <!-- gsd:beginx -->.',
    successCriteria: ['Criterion with `code` and <script>alert(1)</script>.'],
    requirements: ['PHASE-<!-- gsd:endx -->-01'],
  };
  const body = renderNewIssueBody(hostilePhase);
  assert.ok(body.includes(hostilePhase.goal), 'hostile text renders verbatim, uninterpreted');

  // Round-trips through spliceRegion: exactly one real begin/end fence pair
  // (the near-fence and requirement-embedded strings above do not exactly
  // match FENCE_BEGIN/FENCE_END), so the result must be spliced, not damaged.
  const result = spliceRegion(body, 'a fresh replacement region');
  assert.equal(result.kind, SPLICE_RESULT.SPLICED, 'hostile developer text must never make its own issue unrepairable');
});

test('renderPhaseRegion: rendering is deterministic — the same phase renders byte-identically twice', () => {
  assert.equal(renderPhaseRegion(FULL_PHASE), renderPhaseRegion(FULL_PHASE));
  assert.equal(renderPhaseRegion({ ...FULL_PHASE }), renderPhaseRegion({ ...FULL_PHASE }));
});

test('renderPhaseRegion: reads only properties of the phase object it is given — an unrelated property changes nothing in the output', () => {
  const withExtra = { ...FULL_PHASE, unrelatedProp: 'anything', anotherOne: { nested: true } };
  assert.equal(renderPhaseRegion(FULL_PHASE), renderPhaseRegion(withExtra));
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

/* --- Phase 5 (05-01 Task 1): plan marker, task list, plan region, plan body --- */

const PLAN = { id: '04-03', title: '04-03 — Splice a region by severity', status: 'Todo', tasks: ['Task 1: First task', 'Task 2: Second task'] };

test('planMarker: mirrors phaseMarker\'s shape, and a plan marker never equals or contains a phase marker for the same id', () => {
  assert.equal(planMarker('04'), '<!-- gsd:plan id="04" -->');
  assert.notEqual(planMarker('04'), phaseMarker('04'));
  assert.equal(planMarker('04').includes(phaseMarker('04')), false);
});

test('planMarker: takes an already-normalized id and does not normalize it itself — "04-03" and "4-3" produce different markers', () => {
  assert.notEqual(planMarker('04-03'), planMarker('4-3'));
});

test('TASK_GLYPH: exposes exactly the three PlanStatus members, each mapped to a distinct single glyph', () => {
  assert.deepEqual(Object.keys(TASK_GLYPH).sort(), ['Done', 'In Progress', 'Todo'].sort());
  const glyphs = Object.values(TASK_GLYPH);
  assert.equal(new Set(glyphs).size, glyphs.length, 'every glyph must be distinct');
});

test('renderTaskList: renders one line per task, glyph + a single space + the name verbatim, preserving document order', () => {
  const rendered = renderTaskList('Todo', PLAN.tasks);
  const lines = rendered.split('\n');
  assert.equal(lines.length, PLAN.tasks.length);
  PLAN.tasks.forEach((name, index) => {
    assert.equal(lines[index], `${TASK_GLYPH.Todo} ${name}`);
  });
});

test('renderTaskList: two tasks whose name text is byte-identical both render as their own separate line — no deduplication', () => {
  const rendered = renderTaskList('Done', ['Repeated name', 'Repeated name']);
  const lines = rendered.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], lines[1]);
  assert.equal(lines[0], `${TASK_GLYPH.Done} Repeated name`);
});

test('renderTaskList: the glyph rolls up from the plan\'s own status — Done, In Progress, and Todo each render their own distinct glyph for the same task name', () => {
  const rendered = { Done: renderTaskList('Done', ['X']), 'In Progress': renderTaskList('In Progress', ['X']), Todo: renderTaskList('Todo', ['X']) };
  assert.equal(rendered.Done, `${TASK_GLYPH.Done} X`);
  assert.equal(rendered['In Progress'], `${TASK_GLYPH['In Progress']} X`);
  assert.equal(rendered.Todo, `${TASK_GLYPH.Todo} X`);
  assert.notEqual(rendered.Done, rendered.Todo);
});

test('renderPlanRegion: no markdown checkbox appears anywhere, even when a task name itself contains bracket characters', () => {
  const bracketPlan = { ...PLAN, tasks: ['Task with [brackets] and (parens)', 'Handle the [edge case] cleanly'] };
  const region = renderPlanRegion(bracketPlan);
  assert.doesNotMatch(region, /\[[ xX]\]/, 'no unchecked/checked markdown checkbox may appear');
  assert.doesNotMatch(region, /^\s*-\s*\[/m, 'no list item may open a bracketed control');
  assert.ok(region.includes('[brackets]'), 'the hostile bracket text itself must still render verbatim');
});

test('renderPlanRegion: task lines render in PLAN.md document order', () => {
  const region = renderPlanRegion(PLAN);
  const indexes = PLAN.tasks.map((name) => region.indexOf(name));
  assert.ok(indexes.every((index) => index >= 0), 'every task name must appear');
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b), 'tasks must appear in source order');
});

test('renderPlanRegion: never repeats Wave, Autonomous, or Requirements as body text, even when the input object carries those properties', () => {
  const hostilePlan = { ...PLAN, wave: 3, autonomous: true, requirements: ['PLAN-01'] };
  const region = renderPlanRegion(hostilePlan);
  assert.doesNotMatch(region, /Wave/i);
  assert.doesNotMatch(region, /Autonomous/i);
  assert.doesNotMatch(region, /Requirements/i);
});

test('renderPlanRegion: the provenance line names the plan\'s own PLAN.md path and states the issue is a regenerated projection', () => {
  const region = renderPlanRegion(PLAN);
  assert.ok(region.includes(`${PLAN.id}-PLAN.md`));
  assert.match(region, /projection/i);
  assert.match(region, /regenerat/i);
});

test('renderNewPlanIssueBody: first line is the plan marker, second line opens the region fence, closed by the end fence, then one trailing newline and nothing else — the same five-part shape renderNewIssueBody produces for a phase', () => {
  const body = renderNewPlanIssueBody(PLAN);
  const lines = body.split('\n');

  assert.equal(lines[0], planMarker(PLAN.id));
  assert.equal(lines[1], FENCE_BEGIN);
  assert.equal(lines[lines.length - 2], FENCE_END);
  assert.equal(lines[lines.length - 1], '', 'body must end with exactly one trailing newline');
  assert.equal(body.endsWith(`${FENCE_END}\n`), true);
  assert.equal(body.endsWith(`${FENCE_END}\n\n`), false, 'must not carry a second trailing newline');
});

test('renderNewPlanIssueBody: contains no interactive markdown checkbox in any form', () => {
  const body = renderNewPlanIssueBody(PLAN);
  assert.doesNotMatch(body, /\[ \]/, 'unchecked checkbox must never appear');
  assert.doesNotMatch(body, /\[x\]/i, 'checked checkbox must never appear (case-insensitive)');
});

test('renderPlanRegion: rendering is deterministic — the same plan renders byte-identically twice', () => {
  assert.equal(renderPlanRegion(PLAN), renderPlanRegion(PLAN));
  assert.equal(renderPlanRegion({ ...PLAN }), renderPlanRegion({ ...PLAN }));
});

test('spliceRegion: splicing a freshly rendered plan region into an existing plan-issue body preserves every byte outside the fence pair and does not move the region\'s position', () => {
  const above = 'A human added this note above the fence.';
  const below = 'And this one below the fence.';
  const oldRegion = renderPlanRegion({ ...PLAN, tasks: ['Old task'] });
  const body = `${planMarker(PLAN.id)}\n${above}\n${FENCE_BEGIN}\n${oldRegion}\n${FENCE_END}\n${below}\n`;

  const newRegion = renderPlanRegion({ ...PLAN, tasks: ['New task'] });
  const result = spliceRegion(body, newRegion);

  assert.equal(result.kind, SPLICE_RESULT.SPLICED);
  assert.ok(result.body.startsWith(`${planMarker(PLAN.id)}\n${above}\n${FENCE_BEGIN}`));
  assert.ok(result.body.endsWith(`${FENCE_END}\n${below}\n`));
  assert.ok(result.body.includes('New task'));
  assert.ok(!result.body.includes('Old task'));
});

/* --- Phase 5 (05-03 Task 1): the non-interactive task list's empty and encoding edges --- */

test('renderPlanRegion: a zero-task plan renders the Tasks heading followed by exactly one placeholder line, never an empty heading or an empty list', () => {
  const zeroTaskPlan = { ...PLAN, tasks: [] };
  const region = renderPlanRegion(zeroTaskPlan);
  assert.match(region, /^## Tasks$/m, 'heading must still be emitted');
  const placeholderLines = region.split('\n').filter((line) => line.startsWith('_This plan records no tasks'));
  assert.equal(placeholderLines.length, 1, 'exactly one placeholder line, not zero and not several');
  assert.doesNotMatch(region, /^○ |^▶ |^✓ /m, 'no glyph-prefixed task line may appear when there are zero tasks');
});

test('renderTaskList: an empty task list renders no task lines at all (empty string, zero glyph lines)', () => {
  assert.equal(renderTaskList('Todo', []), '');
});

test('renderPlanRegion: carries a one-line glyph legend directly beneath the Tasks heading naming all three glyphs and stating the glyph reflects the plan\'s own status, not per-task state', () => {
  const region = renderPlanRegion(PLAN);
  const lines = region.split('\n');
  const headingIndex = lines.indexOf('## Tasks');
  assert.ok(headingIndex >= 0);
  const legendLine = lines.slice(headingIndex + 1).find((line) => line.startsWith('Legend:'));
  assert.ok(legendLine, 'a legend line must exist beneath the Tasks heading');
  for (const glyph of Object.values(TASK_GLYPH)) {
    assert.ok(legendLine.includes(glyph), `legend must name glyph ${glyph}`);
  }
  assert.match(legendLine, /status/i, 'legend must state the glyph reflects the plan\'s own status');
  assert.doesNotMatch(legendLine, /\[ \]/, 'the legend itself must never render a checkbox');
});

test('renderTaskList: a task name built from an emoji (astral-plane code point), a combining acute accent, and a CJK character appears in the output with strict string equality against the input — no normalization, no escaping, no truncation', () => {
  const hostileName = '\u{1F680} café 日本語'; // rocket emoji, "cafe" + combining acute, CJK "Japanese language"
  const rendered = renderTaskList('Todo', [hostileName]);
  assert.equal(rendered, `${TASK_GLYPH.Todo} ${hostileName}`);
  assert.ok(rendered.includes(hostileName));

  const region = renderPlanRegion({ ...PLAN, tasks: [hostileName] });
  assert.ok(region.includes(hostileName), 'the hostile task name must appear byte-identical in the full region too');
});

test('renderPlanRegion: rendering is deterministic across interleaved calls to two different plans, each returning strictly equal strings on repeat', () => {
  const planA = { ...PLAN, id: 'A', tasks: ['Task A1', 'Task A2'] };
  const planB = { ...PLAN, id: 'B', tasks: ['Task B1'] };

  const a1 = renderPlanRegion(planA);
  const b1 = renderPlanRegion(planB);
  const a2 = renderPlanRegion(planA);
  const b2 = renderPlanRegion(planB);

  assert.equal(a1, a2, 'plan A renders byte-identically across interleaved calls');
  assert.equal(b1, b2, 'plan B renders byte-identically across interleaved calls');
  assert.notEqual(a1, b1, 'two distinct plans must not accidentally render identically');
});

test('src/github-sync-issue-body.cts declares no import beyond node:crypto — the module is pure with no fs, env, clock, or network access', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'github-sync-issue-body.cts'), 'utf8');
  const importLines = source.match(/^import\s+.+\s+from\s+['"][^'"]+['"];?\s*$/gm) || [];
  assert.ok(importLines.length > 0, 'the module must declare at least the crypto import');
  for (const line of importLines) {
    assert.match(line, /from\s+['"]node:crypto['"];?\s*$/, `unexpected import: ${line}`);
  }
  assert.doesNotMatch(source, /\brequire\(/, 'no CommonJS require() either');
  assert.doesNotMatch(source, /\bprocess\.env\b/);
  assert.doesNotMatch(source, /\bnew Date\(/);
  assert.doesNotMatch(source, /\bfs\./);
});

/* --- Phase 5 (05-03 Task 2): the dependency-reference slot --- */

test('DEPENDENCY_REF_SENTINEL is delimited by NUL code points (U+0000) on both sides', () => {
  assert.equal(DEPENDENCY_REF_SENTINEL.charCodeAt(0), 0);
  assert.equal(DEPENDENCY_REF_SENTINEL.charCodeAt(DEPENDENCY_REF_SENTINEL.length - 1), 0);
});

test('renderPlanRegion: a plan with two dependencies emits a Depends On section containing exactly two slots, in that order', () => {
  const plan = { ...PLAN, dependsOn: ['05-01', '05-02'] };
  const region = renderPlanRegion(plan);
  assert.match(region, /^## Depends On$/m);
  assert.equal(countDependencyRefSlots(region), 2);
});

test('renderPlanRegion: a plan with an empty dependsOn list emits no Depends On heading at all', () => {
  const plan = { ...PLAN, dependsOn: [] };
  const region = renderPlanRegion(plan);
  assert.doesNotMatch(region, /## Depends On/);
  assert.equal(countDependencyRefSlots(region), 0);
});

test('renderPlanRegion: a plan with no dependsOn property at all (omitted, not empty) renders the same way — no heading, zero slots', () => {
  const { dependsOn: _omit, ...planWithoutDeps } = { ...PLAN, dependsOn: ['05-01'] };
  const region = renderPlanRegion(planWithoutDeps);
  assert.doesNotMatch(region, /## Depends On/);
  assert.equal(countDependencyRefSlots(region), 0);
});

test('countDependencyRefSlots: equals plan.dependsOn.length across zero-, one-, and three-dependency fixtures', () => {
  for (const dependsOn of [[], ['05-01'], ['05-01', '05-02', '05-03']]) {
    const region = renderPlanRegion({ ...PLAN, dependsOn });
    assert.equal(countDependencyRefSlots(region), dependsOn.length, `expected ${dependsOn.length} slots for ${JSON.stringify(dependsOn)}`);
  }
});

test('countDependencyRefSlots: returns 0 for a region carrying no sentinel at all', () => {
  assert.equal(countDependencyRefSlots('a region with no dependency slots'), 0);
});

test('substituteDependencyRefs: replaces each slot positionally with the corresponding value, in order', () => {
  const region = renderPlanRegion({ ...PLAN, dependsOn: ['05-01', '05-02'] });
  const result = substituteDependencyRefs(region, ['#101', '#102']);
  assert.equal(result.kind, 'substituted');
  assert.ok(result.text.includes('#101'));
  assert.ok(result.text.includes('#102'));
  assert.equal(result.text.indexOf('#101') < result.text.indexOf('#102'), true, 'values must land in slot order');
  assert.equal(countDependencyRefSlots(result.text), 0, 'no sentinel survives a successful substitution');
});

test('substituteDependencyRefs: a zero-slot region with zero values returns the region unchanged', () => {
  const region = renderPlanRegion({ ...PLAN, dependsOn: [] });
  const result = substituteDependencyRefs(region, []);
  assert.equal(result.kind, 'substituted');
  assert.equal(result.text, region);
});

test('substituteDependencyRefs: a two-slot region given only one value returns a typed mismatch carrying no text property at all', () => {
  const region = renderPlanRegion({ ...PLAN, dependsOn: ['05-01', '05-02'] });
  const result = substituteDependencyRefs(region, ['#101']);
  assert.equal(result.kind, 'mismatch');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'text'), false, 'a mismatch must never carry a text property, not even an empty one');
  assert.match(result.detail, /2/);
  assert.match(result.detail, /1/);
});

test('substituteDependencyRefs: too many values for the observed slot count is also a typed mismatch', () => {
  const region = renderPlanRegion({ ...PLAN, dependsOn: ['05-01'] });
  const result = substituteDependencyRefs(region, ['#101', '#102']);
  assert.equal(result.kind, 'mismatch');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'text'), false);
});

test('substituteDependencyRefs: a task name forging the sentinel inflates the observed slot count, driving substitution to a typed mismatch rather than a wrong-but-plausible bind', () => {
  const hostilePlan = { ...PLAN, tasks: [`Task with a forged ${DEPENDENCY_REF_SENTINEL} reference`], dependsOn: ['05-01'] };
  const region = renderPlanRegion(hostilePlan);
  assert.equal(countDependencyRefSlots(region), 2, 'one real dependency slot plus one forged slot from the hostile task name');

  const result = substituteDependencyRefs(region, ['#101']);
  assert.equal(result.kind, 'mismatch', 'the count disagreement must be reported, never silently bound');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'text'), false);
});

test('contentHash: computed over the plan-id substituted region is unaffected by whatever issue numbers those same dependency plans would later resolve to at dispatch time', () => {
  const plan = { ...PLAN, dependsOn: ['05-01', '05-02'] };
  const region = renderPlanRegion(plan);

  // The value handed to contentHash (D-03) is the plan-id form.
  const preResolution = substituteDependencyRefs(region, plan.dependsOn);
  assert.equal(preResolution.kind, 'substituted');
  const hash = contentHash({ title: 'T', region: preResolution.text, milestoneNumber: 1 });

  // Two different dispatch-time runs where those same two plans resolve to
  // different real issue numbers produce different bodies...
  const dispatchRun1 = substituteDependencyRefs(region, ['#101', '#102']);
  const dispatchRun2 = substituteDependencyRefs(region, ['#555', '#777']);
  assert.notEqual(dispatchRun1.text, dispatchRun2.text, 'the dispatch-time body does vary by resolved issue number');

  // ...but the hash, always computed over the plan-id form, never varies.
  assert.equal(hash, contentHash({ title: 'T', region: preResolution.text, milestoneNumber: 1 }));
  assert.notEqual(hash, contentHash({ title: 'T', region: dispatchRun1.text, milestoneNumber: 1 }));
  assert.notEqual(hash, contentHash({ title: 'T', region: dispatchRun2.text, milestoneNumber: 1 }));
});

/* --- Phase 5 (05-03 Task 3): one field-state trio over a declared field list --- */

test('PHASE_FIELD_NAMES and PLAN_FIELD_NAMES: declared in the fixed orders the render/parse/compare trio reports them in', () => {
  assert.deepEqual([...PHASE_FIELD_NAMES], ['gsdId', 'phaseId', 'requirements', 'status']);
  assert.deepEqual([...PLAN_FIELD_NAMES], ['gsdId', 'phaseId', 'requirements', 'status', 'wave', 'autonomous']);
});

test('renderFieldState with no explicit names argument produces the identical four-key-in-order byte shape the pre-generalization implementation always produced (the upgrade-compatibility control)', () => {
  const values = { gsdId: 'issue:phase:03', phaseId: '03', requirements: ['PHASE-01', 'PHASE-02'], status: 'Done' };
  const serialized = renderFieldState(values);
  assert.equal(serialized, JSON.stringify({ gsdId: values.gsdId, phaseId: values.phaseId, requirements: values.requirements, status: values.status }));
});

test('a verbatim phase fieldState string recorded before this upgrade still parses as known and yields zero changed fields against its own re-rendered value', () => {
  // A real recorded shape: JSON.stringify({gsdId, phaseId, requirements, status}) in that exact key order.
  const recorded = '{"gsdId":"issue:phase:03","phaseId":"03","requirements":["PHASE-01"],"status":"Done"}';
  const parsed = parseFieldState(recorded);
  assert.equal(parsed.kind, 'known', 'a fieldState string recorded before this change must still parse as known');

  const rerendered = renderFieldState(parsed.values);
  assert.equal(rerendered, recorded, 'the phase variant re-renders byte-identically to what was recorded');
  assert.deepEqual(changedFields(parsed, parsed.values), [], 'no already-synced phase rewrites its field values on the first run after this upgrade');
});

test('the render-parse-compare round trip is closed for both declared variants, iterated in one loop', () => {
  const fixtures = [
    { names: PHASE_FIELD_NAMES, values: { gsdId: 'issue:phase:03', phaseId: '03', requirements: ['PHASE-01'], status: 'Done' } },
    { names: PLAN_FIELD_NAMES, values: { gsdId: 'issue:plan:05-03', phaseId: '05', requirements: ['PLAN-05'], status: 'In Progress', wave: 2, autonomous: true } },
  ];
  for (const { names, values } of fixtures) {
    const serialized = renderFieldState(values, names);
    const parsed = parseFieldState(serialized, names);
    assert.equal(parsed.kind, 'known', `round trip must decode for names ${JSON.stringify(names)}`);
    assert.deepEqual(changedFields(parsed, values, names), [], `round trip must report zero changed fields for names ${JSON.stringify(names)}`);
  }
});

test('changedFields: an unknown previous state under PLAN_FIELD_NAMES reports all six plan fields as changed, and under PHASE_FIELD_NAMES reports all four', () => {
  const planValues = { gsdId: 'a', phaseId: '05', requirements: [], status: 'Todo', wave: 1, autonomous: false };
  assert.deepEqual([...changedFields({ kind: 'unknown' }, planValues, PLAN_FIELD_NAMES)].sort(), [...PLAN_FIELD_NAMES].sort());

  const phaseValues = { gsdId: 'a', phaseId: '04', requirements: [], status: 'Todo' };
  assert.deepEqual([...changedFields({ kind: 'unknown' }, phaseValues)].sort(), [...PHASE_FIELD_NAMES].sort());
});

test('changedFields: changing only wave between two plan values yields exactly ["wave"]', () => {
  const base = { gsdId: 'a', phaseId: '05', requirements: [], status: 'Todo', wave: 1, autonomous: false };
  const previous = { kind: 'known', values: base };
  const desired = { ...base, wave: 2 };
  assert.deepEqual(changedFields(previous, desired, PLAN_FIELD_NAMES), ['wave']);
});

test('changedFields: changing only autonomous between two plan values yields exactly ["autonomous"]', () => {
  const base = { gsdId: 'a', phaseId: '05', requirements: [], status: 'Todo', wave: 1, autonomous: false };
  const previous = { kind: 'known', values: base };
  const desired = { ...base, autonomous: true };
  assert.deepEqual(changedFields(previous, desired, PLAN_FIELD_NAMES), ['autonomous']);
});

test('parseFieldState: a plan-variant string whose wave is neither a number nor null returns unknown', () => {
  const malformed = JSON.stringify({ gsdId: 'a', phaseId: '05', requirements: [], status: 'Todo', wave: 'two', autonomous: false });
  assert.equal(parseFieldState(malformed, PLAN_FIELD_NAMES).kind, 'unknown');
});

test('parseFieldState: a plan-variant string whose autonomous is not a boolean returns unknown', () => {
  const malformed = JSON.stringify({ gsdId: 'a', phaseId: '05', requirements: [], status: 'Todo', wave: 1, autonomous: 'yes' });
  assert.equal(parseFieldState(malformed, PLAN_FIELD_NAMES).kind, 'unknown');
});

test('parseFieldState: a plan-variant string carrying an entry outside the declared list (e.g. an extra key) returns unknown wholesale, not a partial parse', () => {
  const withExtra = JSON.stringify({ gsdId: 'a', phaseId: '05', requirements: [], status: 'Todo', wave: 1, autonomous: false, extra: 'nope' });
  assert.equal(parseFieldState(withExtra, PLAN_FIELD_NAMES).kind, 'unknown');
});

test('parseFieldState: a phase-variant string missing a declared key (e.g. only three of four present) returns unknown', () => {
  const missingStatus = JSON.stringify({ gsdId: 'a', phaseId: '04', requirements: [] });
  assert.equal(parseFieldState(missingStatus).kind, 'unknown');
});

test('a wave of null round-trips as null and is never conflated with 0 — different serialized strings and different changedFields results', () => {
  const withNull = { gsdId: 'a', phaseId: '05', requirements: [], status: 'Todo', wave: null, autonomous: false };
  const withZero = { gsdId: 'a', phaseId: '05', requirements: [], status: 'Todo', wave: 0, autonomous: false };

  const serializedNull = renderFieldState(withNull, PLAN_FIELD_NAMES);
  const serializedZero = renderFieldState(withZero, PLAN_FIELD_NAMES);
  assert.notEqual(serializedNull, serializedZero);

  const parsedNull = parseFieldState(serializedNull, PLAN_FIELD_NAMES);
  assert.equal(parsedNull.kind, 'known');
  assert.equal(parsedNull.values.wave, null);

  const changed = changedFields(parsedNull, withZero, PLAN_FIELD_NAMES);
  assert.deepEqual(changed, ['wave']);
});

test('renderFieldState/parseFieldState: no call site in github-sync-reconcile.cts passes a names argument for the phase path, and its own field-state tests remain green (compile-time contract, exercised by the suite run alongside this file)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'github-sync-reconcile.cts'), 'utf8');
  assert.doesNotMatch(source, /renderFieldState\([^)]*,\s*(PHASE|PLAN)_FIELD_NAMES/, 'the phase path must keep relying on the default PHASE_FIELD_NAMES argument');
  assert.doesNotMatch(source, /changedFields\([^)]*,\s*(PHASE|PLAN)_FIELD_NAMES/, 'the phase path must keep relying on the default PHASE_FIELD_NAMES argument');
});
