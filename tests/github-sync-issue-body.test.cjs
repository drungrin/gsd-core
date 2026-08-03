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
  planMarker,
  TASK_GLYPH,
  renderTaskList,
  renderPlanRegion,
  renderNewPlanIssueBody,
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
