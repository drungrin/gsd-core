/* D-20 (plan 07-07): the repo-scoped, fail-closed marker reader and the pure
 * anti-forgery binding pass. Reader tests mirror
 * tests/github-sync-bootstrap-remote.test.cjs's readRepoLabels/readRepoMilestones
 * shape (a scripted execGh seam, argv inspection, never-throws proof).
 * Binding tests are pure — no execGh, no disk, no network. */
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  readIssuesWithMarkers,
  unboundIssueTargets,
  bindMarkers,
} = require('../gsd-core/bin/lib/github-sync-marker-search.cjs');

const { phaseMarker, planMarker, FENCE_BEGIN, FENCE_END } = require('../gsd-core/bin/lib/github-sync-issue-body.cjs');
const { issueKeyFor, planIssueKeyFor } = require('../gsd-core/bin/lib/github-sync-reconcile.cjs');

/** Scripts a sequence of REST bodies (or typed GhResult overrides) for the single execGh call each `readIssuesWithMarkers` invocation makes. */
function restExecGh(bodies) {
  const calls = [];
  return {
    calls,
    execGh(args, opts) {
      calls.push({ args, opts });
      const next = bodies.shift();
      if (next === undefined) throw new Error('no scripted REST response');
      if (next.exitCode !== undefined) return next;
      return { exitCode: 0, reason: 'ok', stderr: '', stdout: JSON.stringify(next) };
    },
  };
}

function issueEntry({ number, nodeId, body = '', state = 'open' }) {
  return { number, node_id: nodeId, body, state };
}

// ─── Task 1: readIssuesWithMarkers ─────────────────────────────────────────

describe('readIssuesWithMarkers', () => {
  test('a successful read returns available true and one entry per issue, carrying number, node ID, and body', () => {
    const body = `${phaseMarker('07')}\n${FENCE_BEGIN}\nregion\n${FENCE_END}\n`;
    const { execGh } = restExecGh([[[issueEntry({ number: 1, nodeId: 'I_1', body })]]]);
    const result = readIssuesWithMarkers({ cwd: '/repo', owner: 'octo', repo: 'repo', execGh });
    assert.equal(result.available, true);
    assert.deepEqual(result.entries, [{ number: 1, nodeId: 'I_1', body }]);
  });

  test('a subprocess exiting non-zero returns available false and an empty list', () => {
    const { execGh } = restExecGh([{ exitCode: 1, reason: 'gh_exit_nonzero', stdout: '', stderr: 'boom' }]);
    assert.doesNotThrow(() => {
      const result = readIssuesWithMarkers({ cwd: '/repo', owner: 'octo', repo: 'repo', execGh });
      assert.equal(result.available, false);
      assert.deepEqual(result.entries, []);
    });
  });

  test('a payload that fails to decode (unparseable JSON, a non-array body, or a malformed element) returns available false and an empty list, never throwing', () => {
    const cases = [
      'not json',
      [{ not: 'an array, this is an object' }],
      [[{ number: 1 }]], // missing node_id
      [[{ node_id: 'I_1', number: 'not-a-number' }]],
    ];
    for (const body of cases) {
      const { execGh } = restExecGh([body]);
      assert.doesNotThrow(() => {
        const result = readIssuesWithMarkers({ cwd: '/repo', owner: 'octo', repo: 'repo', execGh });
        assert.equal(result.available, false);
        assert.deepEqual(result.entries, []);
      });
    }
  });

  test('a read spanning more than one page returns entries from every page, in order', () => {
    const page1 = [issueEntry({ number: 1, nodeId: 'I_1' }), issueEntry({ number: 2, nodeId: 'I_2' })];
    const page2 = [issueEntry({ number: 3, nodeId: 'I_3' })];
    const { execGh, calls } = restExecGh([[page1, page2]]);
    const result = readIssuesWithMarkers({ cwd: '/repo', owner: 'octo', repo: 'repo', execGh });
    assert.equal(calls.length, 1, 'pagination is exhausted inside gh, exactly one execGh call');
    assert.equal(result.available, true);
    assert.deepEqual(result.entries.map((e) => e.number), [1, 2, 3]);
  });

  test('the command line carries an explicit GET method — asserted from the recorded argv, not from source', () => {
    const { execGh, calls } = restExecGh([[[]]]);
    readIssuesWithMarkers({ cwd: '/repo', owner: 'octo', repo: 'repo', execGh });
    const { args } = calls[0];
    const methodIndex = args.indexOf('-X');
    assert.ok(methodIndex >= 0, 'a -X flag is present');
    assert.equal(args[methodIndex + 1], 'GET');
  });

  test('issues in every state are enumerated — the request carries state=all alongside the explicit page size', () => {
    const { execGh, calls } = restExecGh([[[]]]);
    readIssuesWithMarkers({ cwd: '/repo', owner: 'octo', repo: 'repo', execGh });
    const { args } = calls[0];
    assert.equal(args[args.indexOf('state=all') - 1], '-f');
    assert.equal(args[args.indexOf('per_page=100') - 1], '-f');
    assert.ok(args.includes('--paginate'));
    assert.ok(args.includes('--slurp'));
  });

  test('the reader never throws — an unsafe owner/repo value never reaches execGh and still returns a typed unavailable result', () => {
    let called = false;
    assert.doesNotThrow(() => {
      const result = readIssuesWithMarkers({ cwd: '/repo', owner: '{owner}', repo: 'repo', execGh: () => { called = true; throw new Error('must not call execGh'); } });
      assert.equal(called, false);
      assert.equal(result.available, false);
      assert.deepEqual(result.entries, []);
    });
  });

  test('a closed issue is still enumerated (findable) alongside an open one', () => {
    const entries = [
      issueEntry({ number: 1, nodeId: 'I_1', state: 'open' }),
      issueEntry({ number: 2, nodeId: 'I_2', state: 'closed' }),
    ];
    const { execGh } = restExecGh([[entries]]);
    const result = readIssuesWithMarkers({ cwd: '/repo', owner: 'octo', repo: 'repo', execGh });
    assert.equal(result.available, true);
    assert.deepEqual(result.entries.map((e) => e.number).sort(), [1, 2]);
  });

  test('a null body decodes to an empty string, never a decode failure', () => {
    const { execGh } = restExecGh([[[{ number: 1, node_id: 'I_1', body: null, state: 'open' }]]]);
    const result = readIssuesWithMarkers({ cwd: '/repo', owner: 'octo', repo: 'repo', execGh });
    assert.equal(result.available, true);
    assert.deepEqual(result.entries, [{ number: 1, nodeId: 'I_1', body: '' }]);
  });
});

// ─── unboundIssueTargets ────────────────────────────────────────────────────

describe('unboundIssueTargets', () => {
  test('builds one target per desired phase/plan lacking a completion, and every logical key comes from issueKeyFor/planIssueKeyFor', () => {
    const desired = { phases: [{ id: '07' }, { id: '08' }], plans: [{ id: '07-01' }] };
    const completions = { [issueKeyFor('08')]: { nodeId: 'I_8' } };
    const targets = unboundIssueTargets(desired, completions);
    assert.deepEqual(
      targets.map((t) => t.logicalKey).sort(),
      [issueKeyFor('07'), planIssueKeyFor('07-01')].sort(),
    );
  });

  test('an empty result when every desired identifier already carries a completion', () => {
    const desired = { phases: [{ id: '07' }], plans: [] };
    const completions = { [issueKeyFor('07')]: { nodeId: 'I_7' } };
    assert.deepEqual(unboundIssueTargets(desired, completions), []);
  });
});

// ─── Task 2: bindMarkers ────────────────────────────────────────────────────

function fencedBody(marker, region = 'region text') {
  return `${marker}\n${FENCE_BEGIN}\n${region}\n${FENCE_END}\n`;
}

describe('bindMarkers', () => {
  test('a body carrying the exact phase marker inside the fenced region binds that issue to the phase logical key', () => {
    const target = { kind: 'phase', id: '07', logicalKey: issueKeyFor('07') };
    const read = { available: true, entries: [{ number: 5, nodeId: 'I_5', body: fencedBody(phaseMarker('07')) }] };
    const result = bindMarkers(read, [target]);
    assert.deepEqual(result.bindings, [{ logicalKey: issueKeyFor('07'), nodeId: 'I_5', issueNumber: 5 }]);
    assert.deepEqual(result.refusals, []);
  });

  test('a body carrying the exact plan marker inside the fenced region binds that issue to the plan logical key', () => {
    const target = { kind: 'plan', id: '07-01', logicalKey: planIssueKeyFor('07-01') };
    const read = { available: true, entries: [{ number: 6, nodeId: 'I_6', body: fencedBody(planMarker('07-01')) }] };
    const result = bindMarkers(read, [target]);
    assert.deepEqual(result.bindings, [{ logicalKey: planIssueKeyFor('07-01'), nodeId: 'I_6', issueNumber: 6 }]);
    assert.deepEqual(result.refusals, []);
  });

  test('a body carrying the exact marker OUTSIDE the fenced region binds nothing — otherwise identical to a binding case', () => {
    const target = { kind: 'phase', id: '07', logicalKey: issueKeyFor('07') };
    const outsideBody = `${FENCE_BEGIN}\nregion text\n${FENCE_END}\n${phaseMarker('07')}\n`;
    const read = { available: true, entries: [{ number: 5, nodeId: 'I_5', body: outsideBody }] };
    const result = bindMarkers(read, [target]);
    assert.deepEqual(result.bindings, []);
  });

  test('near-miss marker forms — different spacing, different quoting, a different comment form, and an extra attribute — each bind nothing', () => {
    const target = { kind: 'phase', id: '07', logicalKey: issueKeyFor('07') };
    const nearMisses = [
      '<!--gsd:phase id="07"-->', // no surrounding spaces
      '<!-- gsd:phase id=\'07\' -->', // single quotes
      '<!-- gsd:Phase id="07" -->', // different comment/attribute casing
      '<!-- gsd:phase id="07" extra="x" -->', // an extra attribute
    ];
    for (const marker of nearMisses) {
      const read = { available: true, entries: [{ number: 9, nodeId: 'I_9', body: fencedBody(marker) }] };
      const result = bindMarkers(read, [target]);
      assert.deepEqual(result.bindings, [], `near-miss form must not bind: ${marker}`);
    }
  });

  test('two issues carrying the same identifier marker inside their fenced regions bind nothing, and produce one ambiguity report entry naming the identifier and both issue numbers', () => {
    const target = { kind: 'phase', id: '07', logicalKey: issueKeyFor('07') };
    const read = {
      available: true,
      entries: [
        { number: 11, nodeId: 'I_11', body: fencedBody(phaseMarker('07')) },
        { number: 10, nodeId: 'I_10', body: fencedBody(phaseMarker('07')) },
      ],
    };
    const result = bindMarkers(read, [target]);
    assert.deepEqual(result.bindings, []);
    assert.deepEqual(result.refusals, [{ logicalKey: issueKeyFor('07'), issueNumbers: [10, 11], reason: 'ambiguous_marker_claim' }]);
  });

  test('an issue carrying markers for two different identifiers binds nothing for either and is reported', () => {
    const phaseTarget = { kind: 'phase', id: '07', logicalKey: issueKeyFor('07') };
    const planTarget = { kind: 'plan', id: '07-01', logicalKey: planIssueKeyFor('07-01') };
    const body = `${phaseMarker('07')}\n${planMarker('07-01')}\n${FENCE_BEGIN}\nregion\n${FENCE_END}\n`;
    const read = { available: true, entries: [{ number: 20, nodeId: 'I_20', body }] };
    const result = bindMarkers(read, [phaseTarget, planTarget]);
    assert.deepEqual(result.bindings, []);
    const multiClaim = result.refusals.find((r) => r.reason === 'multiple_identifiers_claimed');
    assert.ok(multiClaim, 'a multiple_identifiers_claimed refusal is present');
    assert.deepEqual(multiClaim.issueNumbers, [20]);
  });

  test('an issue carrying no marker is ignored silently — zero bindings, zero refusals', () => {
    const target = { kind: 'phase', id: '07', logicalKey: issueKeyFor('07') };
    const read = { available: true, entries: [{ number: 30, nodeId: 'I_30', body: fencedBody('some unrelated text') }] };
    const result = bindMarkers(read, [target]);
    assert.deepEqual(result.bindings, []);
    assert.deepEqual(result.refusals, []);
  });

  test('an unavailable read produces zero bindings and zero refusals, never a partial guess', () => {
    const target = { kind: 'phase', id: '07', logicalKey: issueKeyFor('07') };
    const read = { available: false, entries: [] };
    const result = bindMarkers(read, [target]);
    assert.deepEqual(result, { bindings: [], refusals: [] });
  });

  test('an empty target list short-circuits to zero bindings without inspecting any entry', () => {
    const read = { available: true, entries: [{ number: 1, nodeId: 'I_1', body: fencedBody(phaseMarker('07')) }] };
    const result = bindMarkers(read, []);
    assert.deepEqual(result, { bindings: [], refusals: [] });
  });

  test('output is ordered deterministically by logical key', () => {
    const targets = [
      { kind: 'phase', id: '09', logicalKey: issueKeyFor('09') },
      { kind: 'phase', id: '02', logicalKey: issueKeyFor('02') },
      { kind: 'plan', id: '01-01', logicalKey: planIssueKeyFor('01-01') },
    ];
    const read = {
      available: true,
      entries: [
        { number: 1, nodeId: 'I_09', body: fencedBody(phaseMarker('09')) },
        { number: 2, nodeId: 'I_02', body: fencedBody(phaseMarker('02')) },
        { number: 3, nodeId: 'I_0101', body: fencedBody(planMarker('01-01')) },
      ],
    };
    const result = bindMarkers(read, targets);
    assert.deepEqual(result.bindings.map((b) => b.logicalKey), [...result.bindings.map((b) => b.logicalKey)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
    assert.equal(result.bindings.length, 3);
  });

  test('every emitted logical key is produced by issueKeyFor/planIssueKeyFor — grep-verifiable, and asserted here by direct construction', () => {
    const target = { kind: 'phase', id: '07', logicalKey: issueKeyFor('07') };
    const read = { available: true, entries: [{ number: 5, nodeId: 'I_5', body: fencedBody(phaseMarker('07')) }] };
    const result = bindMarkers(read, [target]);
    assert.equal(result.bindings[0].logicalKey, issueKeyFor('07'));
  });
});
