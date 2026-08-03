/* Pure-adapter tests for the read-splice-write preparation stage: a fake execGh injected through
 * the options-object seam, never a real gh spawn. Every test runs offline. */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareIssueUpdates, ISSUE_UPDATE_REASON } = require('../gsd-core/bin/lib/github-sync-issue-update.cjs');
const { FENCE_BEGIN, FENCE_END, DEPENDENCY_REF_SENTINEL } = require('../gsd-core/bin/lib/github-sync-issue-body.cjs');

function fakeExecGh(responses) {
  const calls = [];
  const queue = [...responses];
  const fn = (args, opts) => {
    calls.push({ args, opts });
    const next = queue.shift();
    if (!next) throw new Error('fakeExecGh invoked more times than responses were supplied');
    return next;
  };
  fn.calls = calls;
  return fn;
}

function pendingUpdate(overrides = {}) {
  return {
    logicalKey: 'phase:04',
    issueKey: 'issue:phase:04',
    issueNumber: 55,
    issueNodeId: 'ISSUE_NODE_04',
    title: 'Phase Four',
    region: 'fresh interior',
    milestoneNumber: 3,
    milestoneKey: 'milestone:v1.0',
    contentHash: 'freshhash123',
    completionContext: { owner: 'octo', repo: 'repo', repositoryNumber: 42 },
    ...overrides,
  };
}

function issueResponse(body, overrides = {}) {
  return { exitCode: 0, stdout: JSON.stringify({ node_id: 'ISSUE_NODE_04', number: 55, body, ...overrides }), stderr: '' };
}

function argEntry(args, predicate) {
  return args.find((entry) => predicate(entry));
}

test('one pending update whose fetched body contains a well-formed fence pair produces exactly one patch operation with no labels entry anywhere', () => {
  const body = `Hello\n${FENCE_BEGIN}\nold region\n${FENCE_END}\nBye`;
  const execGh = fakeExecGh([issueResponse(body)]);
  const update = pendingUpdate();

  const result = prepareIssueUpdates([update], { cwd: '/fixture', execGh });

  assert.equal(result.operations.length, 1);
  assert.deepEqual(result.reports, []);
  const op = result.operations[0];

  assert.equal(op.args[0], 'api');
  assert.ok(op.args[1].includes('/issues/55'));
  assert.deepEqual(op.args.slice(2, 4), ['-X', 'PATCH']);

  const titleEntry = argEntry(op.args, (a) => typeof a === 'string' && a.startsWith('title='));
  assert.equal(titleEntry, `title=${update.title}`);
  assert.equal(op.args[op.args.indexOf(titleEntry) - 1], '-f');

  const bodyEntry = argEntry(op.args, (a) => typeof a === 'string' && a.startsWith('body='));
  assert.equal(bodyEntry, `body=Hello\n${FENCE_BEGIN}\n${update.region}\n${FENCE_END}\nBye`);
  assert.equal(op.args[op.args.indexOf(bodyEntry) - 1], '-f');

  const milestoneRefIndex = op.args.findIndex((a) => typeof a === 'object' && a !== null && a.prefix === 'milestone=');
  assert.ok(milestoneRefIndex > 0);
  assert.equal(op.args[milestoneRefIndex - 1], '-F');
  assert.deepEqual(op.args[milestoneRefIndex], { from: update.milestoneKey, part: 'number', prefix: 'milestone=' });

  // Scan every argv entry, not one index — the whole-run guarantee is "no
  // labels entry of any kind", not merely "not immediately after -f".
  for (const arg of op.args) {
    if (typeof arg === 'string') assert.doesNotMatch(arg, /labels/i);
    else assert.notEqual(arg.prefix, 'labels[]=');
  }

  assert.equal(op.transport, 'rest');
  assert.equal(op.action, 'update');
  assert.equal(op.hasPointsBudget, false);
  assert.equal(op.contentCreation, false);
  assert.equal(op.captures.length, 1);
  assert.deepEqual(op.captures[0], {
    kind: 'node', logicalKey: update.issueKey, nodeIdPath: 'node_id', numberPath: 'number',
    plannerFields: { contentHash: update.contentHash },
  });
});

test('the spliced body preserves the fetched body\'s text outside the fences byte-for-byte', () => {
  const before = 'Line one.\nLine two with **markdown** and a ```code fence```.\n';
  const after = '\nFooter text.\n';
  const body = `${before}${FENCE_BEGIN}\nstale interior\n${FENCE_END}${after}`;
  const execGh = fakeExecGh([issueResponse(body)]);
  const update = pendingUpdate({ region: 'fresh interior' });

  const result = prepareIssueUpdates([update], { cwd: '/f', execGh });
  const bodyEntry = argEntry(result.operations[0].args, (a) => typeof a === 'string' && a.startsWith('body='));
  const spliced = bodyEntry.slice('body='.length);

  assert.ok(spliced.startsWith(before));
  assert.ok(spliced.endsWith(after));
  assert.ok(spliced.includes('fresh interior'));
  assert.ok(!spliced.includes('stale interior'));
});

test("the patch operation's capture carries the pending update's content hash in its planner fields, so a successful patch makes the next run a no-op", () => {
  const body = `${FENCE_BEGIN}\nold\n${FENCE_END}`;
  const execGh = fakeExecGh([issueResponse(body)]);
  const update = pendingUpdate({ contentHash: 'deadbeef' });

  const result = prepareIssueUpdates([update], { cwd: '/f', execGh });
  assert.equal(result.operations[0].captures[0].plannerFields.contentHash, 'deadbeef');
});

test('a fetched body with no fence pair produces a patch operation carrying a self-healed body: the original text first, a fresh region appended', () => {
  const body = 'Just some prose, no fences here.';
  const execGh = fakeExecGh([issueResponse(body)]);
  const update = pendingUpdate();

  const result = prepareIssueUpdates([update], { cwd: '/f', execGh });
  const bodyEntry = argEntry(result.operations[0].args, (a) => typeof a === 'string' && a.startsWith('body='));
  assert.equal(bodyEntry, `body=${body}\n${FENCE_BEGIN}\n${update.region}\n${FENCE_END}\n`);
});

test('a fetched body with damaged fences produces no operation and one report entry naming the logical key, the issue number, and a damaged reason with the splice\'s own detail string', () => {
  const body = `${FENCE_BEGIN}${FENCE_BEGIN}${FENCE_END}`; // two begins, one end: damaged
  const execGh = fakeExecGh([issueResponse(body)]);
  const update = pendingUpdate();

  const result = prepareIssueUpdates([update], { cwd: '/f', execGh });
  assert.deepEqual(result.operations, []);
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].logicalKey, update.logicalKey);
  assert.equal(result.reports[0].issueNumber, update.issueNumber);
  assert.equal(result.reports[0].reason, ISSUE_UPDATE_REASON.REGION_DAMAGED);
  assert.ok(result.reports[0].detail.length > 0);
});

test('a read that fails — non-zero exit — produces no operation and one report entry with a distinct unreadable reason', () => {
  const execGh = fakeExecGh([{ exitCode: 1, stdout: '', stderr: 'boom' }]);
  const update = pendingUpdate();

  const result = prepareIssueUpdates([update], { cwd: '/f', execGh });
  assert.deepEqual(result.operations, []);
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].reason, ISSUE_UPDATE_REASON.ISSUE_UNREADABLE);
});

test('a read whose body decodes to a REST error shape produces no operation and one unreadable report', () => {
  const execGh = fakeExecGh([{ exitCode: 0, stdout: JSON.stringify({ message: 'Not Found' }), stderr: '' }]);
  const update = pendingUpdate();

  const result = prepareIssueUpdates([update], { cwd: '/f', execGh });
  assert.deepEqual(result.operations, []);
  assert.equal(result.reports[0].reason, ISSUE_UPDATE_REASON.ISSUE_UNREADABLE);
});

test('a read whose output is unparseable JSON produces no operation and one unreadable report — the stage never throws', () => {
  const execGh = fakeExecGh([{ exitCode: 0, stdout: 'not json at all', stderr: '' }]);
  const update = pendingUpdate();

  assert.doesNotThrow(() => prepareIssueUpdates([update], { cwd: '/f', execGh }));
  const result = prepareIssueUpdates([update], { cwd: '/f', execGh: fakeExecGh([{ exitCode: 0, stdout: 'not json at all', stderr: '' }]) });
  assert.deepEqual(result.operations, []);
  assert.equal(result.reports[0].reason, ISSUE_UPDATE_REASON.ISSUE_UNREADABLE);
});

test('several pending updates where one is damaged and one reads cleanly produce one operation and one report — one bad issue never suppresses the rest of the run', () => {
  const damagedUpdate = pendingUpdate({ logicalKey: 'phase:01', issueKey: 'issue:phase:01', issueNumber: 10 });
  const cleanUpdate = pendingUpdate({ logicalKey: 'phase:02', issueKey: 'issue:phase:02', issueNumber: 20 });
  const damagedBody = `${FENCE_BEGIN}${FENCE_BEGIN}${FENCE_END}`;
  const cleanBody = `pre\n${FENCE_BEGIN}\nold\n${FENCE_END}\npost`;
  const execGh = fakeExecGh([
    { exitCode: 0, stdout: JSON.stringify({ node_id: 'N1', number: 10, body: damagedBody }), stderr: '' },
    { exitCode: 0, stdout: JSON.stringify({ node_id: 'N2', number: 20, body: cleanBody }), stderr: '' },
  ]);

  const result = prepareIssueUpdates([damagedUpdate, cleanUpdate], { cwd: '/f', execGh });
  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0].logicalKey, cleanUpdate.issueKey);
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].logicalKey, damagedUpdate.logicalKey);
});

test('operations are returned in the same order as the pending updates they came from, so dispatch order is deterministic', () => {
  const a = pendingUpdate({ logicalKey: 'phase:01', issueKey: 'issue:phase:01', issueNumber: 1 });
  const b = pendingUpdate({ logicalKey: 'phase:02', issueKey: 'issue:phase:02', issueNumber: 2 });
  const body = `${FENCE_BEGIN}\nx\n${FENCE_END}`;
  const execGh = fakeExecGh([
    { exitCode: 0, stdout: JSON.stringify({ node_id: 'N1', number: 1, body }), stderr: '' },
    { exitCode: 0, stdout: JSON.stringify({ node_id: 'N2', number: 2, body }), stderr: '' },
  ]);

  const result = prepareIssueUpdates([a, b], { cwd: '/f', execGh });
  assert.deepEqual(result.operations.map((op) => op.logicalKey), [a.issueKey, b.issueKey]);
});

test('an empty pending list issues zero execGh calls', () => {
  const execGh = fakeExecGh([]);
  const result = prepareIssueUpdates([], { cwd: '/f', execGh });
  assert.deepEqual(result, { operations: [], reports: [] });
  assert.equal(execGh.calls.length, 0);
});

test('a pending update whose target owner or repo fails the path-safety charset check issues zero execGh calls and produces one report', () => {
  const execGh = fakeExecGh([]);
  const hostileValues = ['{owner}', 'owner/evil', 'owner@evil', 'ow ner'];
  for (const hostile of hostileValues) {
    const update = pendingUpdate({ completionContext: { owner: hostile, repo: 'repo', repositoryNumber: 42 } });
    const result = prepareIssueUpdates([update], { cwd: '/f', execGh });
    assert.deepEqual(result.operations, [], `expected zero operations for hostile owner ${hostile}`);
    assert.equal(result.reports.length, 1, `expected one report for hostile owner ${hostile}`);
    assert.equal(result.reports[0].reason, ISSUE_UPDATE_REASON.ISSUE_UNREADABLE);
  }
  assert.equal(execGh.calls.length, 0);
});

test('a pending update missing an issue number issues zero execGh calls and produces one report', () => {
  const execGh = fakeExecGh([]);
  const update = pendingUpdate({ issueNumber: undefined });
  const result = prepareIssueUpdates([update], { cwd: '/f', execGh });
  assert.deepEqual(result.operations, []);
  assert.equal(result.reports.length, 1);
  assert.equal(execGh.calls.length, 0);
});

test("every read issues an explicit method flag (never gh's default), matching the readRestList LIVE FINDING", () => {
  const body = `${FENCE_BEGIN}\nold\n${FENCE_END}`;
  const execGh = fakeExecGh([issueResponse(body)]);
  prepareIssueUpdates([pendingUpdate()], { cwd: '/f', execGh });
  assert.deepEqual(execGh.calls[0].args.slice(2, 4), ['-X', 'GET']);
});

// ─── Plan 05-06 Task 2: dependency-reference slots in the update path ──────

test('a pending update whose region carries a dependency-reference sentinel splices into the fetched body and produces the same concatenating shape for its PATCH, with no labels entry anywhere', () => {
  const region = `## Depends On\n\n${DEPENDENCY_REF_SENTINEL}`;
  const body = `${FENCE_BEGIN}\nold\n${FENCE_END}`;
  const execGh = fakeExecGh([issueResponse(body)]);
  const update = pendingUpdate({ region, dependsOn: ['04-01'] });

  const result = prepareIssueUpdates([update], { cwd: '/f', execGh });
  assert.deepEqual(result.reports, []);
  assert.equal(result.operations.length, 1);
  const op = result.operations[0];

  const bodyConcat = op.args.find((a) => a && typeof a === 'object' && Array.isArray(a.parts));
  assert.ok(bodyConcat, 'the PATCH body argv entry must be a concatenating entry, not a plain string, when dependsOn is non-empty');
  const refParts = bodyConcat.parts.filter((part) => typeof part === 'object');
  assert.equal(refParts.length, 1);
  assert.deepEqual(refParts[0], { from: 'issue:plan:04-01', part: 'number', prefix: '#' });
  const literalParts = bodyConcat.parts.filter((part) => typeof part === 'string');
  assert.ok(literalParts.every((part) => !part.includes(DEPENDENCY_REF_SENTINEL)), 'no literal segment carries the raw sentinel');
  assert.ok(literalParts[0].startsWith('body='));

  // Still no labels entry of any kind, exactly as the plain-body PATCH proves above.
  for (const arg of op.args) {
    if (typeof arg === 'string') assert.doesNotMatch(arg, /labels/i);
    else if (arg && typeof arg === 'object' && !Array.isArray(arg.parts)) assert.notEqual(arg.prefix, 'labels[]=');
  }
});

test('a pending update with zero dependencies produces a plain string body entry, exactly as before this plan', () => {
  const body = `${FENCE_BEGIN}\nold\n${FENCE_END}`;
  const execGh = fakeExecGh([issueResponse(body)]);
  const update = pendingUpdate({ dependsOn: [] });

  const result = prepareIssueUpdates([update], { cwd: '/f', execGh });
  const op = result.operations[0];
  assert.ok(op.args.some((a) => typeof a === 'string' && a.startsWith('body=')));
  assert.equal(op.args.some((a) => a && typeof a === 'object' && Array.isArray(a.parts)), false);
});

test('a splice whose result carries a slot count different from the dependency count produces a typed refusal, not a dispatched body', () => {
  const region = `## Depends On\n\n${DEPENDENCY_REF_SENTINEL}, ${DEPENDENCY_REF_SENTINEL}`; // two slots
  const body = `${FENCE_BEGIN}\nold\n${FENCE_END}`;
  const execGh = fakeExecGh([issueResponse(body)]);
  const update = pendingUpdate({ region, dependsOn: ['04-01'] }); // only one dependency id

  const result = prepareIssueUpdates([update], { cwd: '/f', execGh });
  assert.deepEqual(result.operations, []);
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].reason, ISSUE_UPDATE_REASON.DEPENDENCY_SLOT_MISMATCH);
  assert.equal(result.reports[0].logicalKey, update.logicalKey);
  assert.match(result.reports[0].detail, /2/);
  assert.match(result.reports[0].detail, /1/);
});
