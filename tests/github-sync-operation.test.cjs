'use strict';

/**
 * github-sync-operation.test.cjs — exhaustive coverage of the standalone
 * operation contract module (Phase 3, plan 03-01, Task 3). The module has
 * no consumers yet, so this file is its only exercise.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  OPERATION_TRANSPORT,
  ARGV_REF_PART,
  OPERATION_ACTION,
  OPERATION_OUTCOME,
  isOperation,
  isArgvRef,
  isAdoptionCheckpoint,
  resolveArgv,
  decodeResponseRoot,
  decodeCompletions,
  confirmedKeys,
  checkpointedKeys,
  mutatedKeys,
} = require('../gsd-core/bin/lib/github-sync-operation.cjs');

const CONTEXT = { owner: 'drungrin', repo: 'gsd-core', repositoryNumber: 1305171933 };

function baseOperation(overrides = {}) {
  return {
    kind: 'create-field',
    logicalKey: 'field:gsd-id',
    args: ['api', 'graphql', '-f', 'query=mutation{...}'],
    completionContext: CONTEXT,
    transport: OPERATION_TRANSPORT.GRAPHQL,
    action: OPERATION_ACTION.CREATE,
    hasPointsBudget: true,
    contentCreation: false,
    captures: [
      { kind: 'node', logicalKey: 'field:gsd-id', nodeIdPath: 'createProjectV2Field.projectV2Field.id' },
    ],
    ...overrides,
  };
}

function baseCheckpoint(overrides = {}) {
  return {
    logicalKey: 'field:status',
    nodeId: 'PVTF_lADOfield123',
    completionContext: CONTEXT,
    ...overrides,
  };
}

describe('resolveArgv', () => {
  test('plain strings pass through untouched and preserve order exactly', () => {
    const argv = ['api', 'graphql', '-f', 'query=mutation{}'];
    const result = resolveArgv(argv, null);
    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.argv, argv);
  });

  test('a reference entry resolves to the prefix concatenated with the referenced node id, and the preceding element is the raw-value flag', () => {
    const argv = ['-f', { from: 'project', part: ARGV_REF_PART.NODE_ID, prefix: 'projectId=' }];
    const map = { project: { nodeId: 'PVT_project_1' } };
    const result = resolveArgv(argv, map);
    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.argv, ['-f', 'projectId=PVT_project_1']);
    const resolvedIndex = result.argv.indexOf('projectId=PVT_project_1');
    assert.equal(result.argv[resolvedIndex - 1], '-f');
  });

  test('a reference asking for the remote number renders the completion number slot as a decimal string', () => {
    const argv = ['-f', { from: 'project-link', part: ARGV_REF_PART.NUMBER, prefix: 'repositoryNumber=' }];
    const map = { 'project-link': { nodeId: 'R_repo_1', remoteNumber: 1305171933 } };
    const result = resolveArgv(argv, map);
    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.argv, ['-f', 'repositoryNumber=1305171933']);
  });

  test('unresolved: the map is null', () => {
    const argv = [{ from: 'project', part: ARGV_REF_PART.NODE_ID, prefix: 'projectId=' }];
    const result = resolveArgv(argv, null);
    assert.equal(result.ok, false);
    assert.equal(result.missingLogicalKey, 'project');
  });

  test('unresolved: the key is absent from the map', () => {
    const argv = [{ from: 'field:gsd-id', part: ARGV_REF_PART.NODE_ID, prefix: 'fieldId=' }];
    const result = resolveArgv(argv, { project: { nodeId: 'PVT_project_1' } });
    assert.equal(result.ok, false);
    assert.equal(result.missingLogicalKey, 'field:gsd-id');
  });

  test('unresolved: the referenced completion node id is the empty string', () => {
    const argv = [{ from: 'project', part: ARGV_REF_PART.NODE_ID, prefix: 'projectId=' }];
    const result = resolveArgv(argv, { project: { nodeId: '' } });
    assert.equal(result.ok, false);
    assert.equal(result.missingLogicalKey, 'project');
  });

  test('unresolved: a number reference points at a completion with no number slot', () => {
    const argv = [{ from: 'project', part: ARGV_REF_PART.NUMBER, prefix: 'n=' }];
    const result = resolveArgv(argv, { project: { nodeId: 'PVT_project_1' } });
    assert.equal(result.ok, false);
    assert.equal(result.missingLogicalKey, 'project');
  });
});

describe('isArgvRef', () => {
  test('accepts a well-formed reference', () => {
    assert.equal(isArgvRef({ from: 'project', part: ARGV_REF_PART.NODE_ID, prefix: 'projectId=' }), true);
  });

  test('rejects a plain string, a missing from, and an unknown part', () => {
    assert.equal(isArgvRef('projectId=abc'), false);
    assert.equal(isArgvRef({ part: ARGV_REF_PART.NODE_ID, prefix: 'x=' }), false);
    assert.equal(isArgvRef({ from: 'project', part: 'bogus', prefix: 'x=' }), false);
  });
});

describe('decodeResponseRoot', () => {
  test('GraphQL: returns the inner data object', () => {
    const root = decodeResponseRoot(OPERATION_TRANSPORT.GRAPHQL, JSON.stringify({ data: { foo: 'bar' } }));
    assert.deepStrictEqual(root, { foo: 'bar' });
  });

  test('GraphQL: null for a non-empty errors array', () => {
    const root = decodeResponseRoot(OPERATION_TRANSPORT.GRAPHQL, JSON.stringify({ data: null, errors: [{ message: 'nope' }] }));
    assert.strictEqual(root, null);
  });

  test('GraphQL: null for a body with no data key', () => {
    const root = decodeResponseRoot(OPERATION_TRANSPORT.GRAPHQL, JSON.stringify({ foo: 'bar' }));
    assert.strictEqual(root, null);
  });

  test('GraphQL: null for a bare array', () => {
    const root = decodeResponseRoot(OPERATION_TRANSPORT.GRAPHQL, JSON.stringify([1, 2, 3]));
    assert.strictEqual(root, null);
  });

  test('GraphQL: null for unparseable text', () => {
    const root = decodeResponseRoot(OPERATION_TRANSPORT.GRAPHQL, 'not json');
    assert.strictEqual(root, null);
  });

  test('REST: returns the top-level parsed object for a bare JSON object with no data envelope', () => {
    const root = decodeResponseRoot(OPERATION_TRANSPORT.REST, JSON.stringify({ id: 123, node_id: 'LA_label_1', name: 'bug' }));
    assert.deepStrictEqual(root, { id: 123, node_id: 'LA_label_1', name: 'bug' });
  });

  test('REST: null for a JSON array', () => {
    const root = decodeResponseRoot(OPERATION_TRANSPORT.REST, JSON.stringify([{ id: 1 }]));
    assert.strictEqual(root, null);
  });

  test('REST: null for unparseable text', () => {
    const root = decodeResponseRoot(OPERATION_TRANSPORT.REST, 'not json');
    assert.strictEqual(root, null);
  });

  test('REST: rejects an error body whose status is a string (the live-observed shape)', () => {
    const root = decodeResponseRoot(OPERATION_TRANSPORT.REST, JSON.stringify({
      message: 'Validation Failed',
      errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }],
      documentation_url: 'https://docs.github.com/rest/issues/labels#create-a-label',
      status: '422',
    }));
    assert.strictEqual(root, null);
  });

  test('REST: rejects an error body whose status is a number', () => {
    const root = decodeResponseRoot(OPERATION_TRANSPORT.REST, JSON.stringify({ message: 'Not Found', status: 404 }));
    assert.strictEqual(root, null);
  });

  test('REST: rejects an error body with no status at all', () => {
    const root = decodeResponseRoot(OPERATION_TRANSPORT.REST, JSON.stringify({ message: 'Not Found' }));
    assert.strictEqual(root, null);
  });
});

describe('decodeCompletions', () => {
  test('a single node capture returns a one-element array carrying the node id, and the number when a number path is declared and present', () => {
    const operation = baseOperation({
      captures: [{
        kind: 'node',
        logicalKey: 'field:gsd-id',
        nodeIdPath: 'createProjectV2Field.projectV2Field.id',
        numberPath: 'createProjectV2Field.projectV2Field.number',
      }],
    });
    const root = { createProjectV2Field: { projectV2Field: { id: 'PVTF_field_1', number: 3 } } };
    const result = decodeCompletions(operation, root, '2026-08-01T00:00:00Z');
    assert.deepStrictEqual(result, [{ logicalKey: 'field:gsd-id', nodeId: 'PVTF_field_1', remoteNumber: 3, completedAt: '2026-08-01T00:00:00Z' }]);
  });

  test('null when the declared node-id path is absent', () => {
    const operation = baseOperation({
      captures: [{ kind: 'node', logicalKey: 'field:gsd-id', nodeIdPath: 'createProjectV2Field.projectV2Field.id' }],
    });
    const root = { createProjectV2Field: { projectV2Field: {} } };
    assert.strictEqual(decodeCompletions(operation, root, '2026-08-01T00:00:00Z'), null);
  });

  test('null when the node-id path resolves to a non-string', () => {
    const operation = baseOperation({
      captures: [{ kind: 'node', logicalKey: 'field:gsd-id', nodeIdPath: 'createProjectV2Field.projectV2Field.id' }],
    });
    const root = { createProjectV2Field: { projectV2Field: { id: 42 } } };
    assert.strictEqual(decodeCompletions(operation, root, '2026-08-01T00:00:00Z'), null);
  });

  test('null when the node-id path resolves to the empty string', () => {
    const operation = baseOperation({
      captures: [{ kind: 'node', logicalKey: 'field:gsd-id', nodeIdPath: 'createProjectV2Field.projectV2Field.id' }],
    });
    const root = { createProjectV2Field: { projectV2Field: { id: '' } } };
    assert.strictEqual(decodeCompletions(operation, root, '2026-08-01T00:00:00Z'), null);
  });

  test('an each-capture over a six-element list whose key map holds five of the six match values produces exactly 5 completions, none carrying the sixth key', () => {
    const operation = baseOperation({
      captures: [{
        kind: 'each',
        listPath: 'updateProjectV2Field.projectV2Field.options',
        matchPath: 'name',
        nodeIdPath: 'id',
        keyMap: {
          Todo: 'option:status:todo',
          'In Progress': 'option:status:in-progress',
          Blocked: 'option:status:blocked',
          Done: 'option:status:done',
          Deferred: 'option:status:deferred',
        },
      }],
    });
    const root = {
      updateProjectV2Field: {
        projectV2Field: {
          options: [
            { name: 'Todo', id: 'opt-1' },
            { name: 'In Progress', id: 'opt-2' },
            { name: 'Blocked', id: 'opt-3' },
            { name: 'Done', id: 'opt-4' },
            { name: 'Deferred', id: 'opt-5' },
            { name: 'Custom Developer Status', id: 'opt-6' },
          ],
        },
      },
    };
    const result = decodeCompletions(operation, root, '2026-08-01T00:00:00Z');
    assert.equal(result.length, 5);
    assert.ok(!result.some((completion) => completion.logicalKey === 'Custom Developer Status'));
    assert.ok(result.some((completion) => completion.logicalKey === 'option:status:in-progress' && completion.nodeId === 'opt-2'));
  });

  test('an each-capture matching zero elements returns null — a mutation reporting success but returning none of GSD\'s own objects fails closed', () => {
    const operation = baseOperation({
      captures: [{
        kind: 'each',
        listPath: 'updateProjectV2Field.projectV2Field.options',
        matchPath: 'name',
        nodeIdPath: 'id',
        keyMap: { Todo: 'option:status:todo' },
      }],
    });
    const root = { updateProjectV2Field: { projectV2Field: { options: [{ name: 'Unrelated', id: 'opt-9' }] } } };
    assert.strictEqual(decodeCompletions(operation, root, '2026-08-01T00:00:00Z'), null);
  });
});

describe('isOperation', () => {
  test('accepts a well-formed operation', () => {
    assert.equal(isOperation(baseOperation()), true);
  });

  test('rejects an operation with an empty captures array', () => {
    assert.equal(isOperation(baseOperation({ captures: [] })), false);
  });

  test('rejects a capture with an empty node-id path', () => {
    assert.equal(isOperation(baseOperation({ captures: [{ kind: 'node', logicalKey: 'x', nodeIdPath: '' }] })), false);
  });

  test('rejects an argv entry that is neither a string nor a well-formed reference', () => {
    assert.equal(isOperation(baseOperation({ args: ['api', 42] })), false);
    assert.equal(isOperation(baseOperation({ args: ['api', { from: 'x' }] })), false);
  });

  test('rejects an unknown transport value', () => {
    assert.equal(isOperation(baseOperation({ transport: 'soap' })), false);
  });

  test('rejects an unknown action value', () => {
    assert.equal(isOperation(baseOperation({ action: 'destroy' })), false);
  });

  test('rejects an operation whose action is observe (reserved for adoption checkpoints, never a dispatched operation)', () => {
    assert.equal(isOperation(baseOperation({ action: OPERATION_ACTION.OBSERVE })), false);
  });

  test('rejects a non-boolean points-budget flag', () => {
    assert.equal(isOperation(baseOperation({ hasPointsBudget: 'yes' })), false);
  });
});

describe('isAdoptionCheckpoint', () => {
  test('accepts a well-formed checkpoint with no remote number', () => {
    assert.equal(isAdoptionCheckpoint(baseCheckpoint()), true);
  });

  test('accepts a well-formed checkpoint with a positive safe-integer remote number', () => {
    assert.equal(isAdoptionCheckpoint(baseCheckpoint({ remoteNumber: 42 })), true);
  });

  test('rejects an empty logical key', () => {
    assert.equal(isAdoptionCheckpoint(baseCheckpoint({ logicalKey: '' })), false);
  });

  test('rejects an empty node id', () => {
    assert.equal(isAdoptionCheckpoint(baseCheckpoint({ nodeId: '' })), false);
  });

  test('rejects a node id supplied as a number rather than a string', () => {
    assert.equal(isAdoptionCheckpoint(baseCheckpoint({ nodeId: 12345 })), false);
  });

  test('rejects a zero remote number', () => {
    assert.equal(isAdoptionCheckpoint(baseCheckpoint({ remoteNumber: 0 })), false);
  });

  test('rejects a negative remote number', () => {
    assert.equal(isAdoptionCheckpoint(baseCheckpoint({ remoteNumber: -3 })), false);
  });

  test('rejects a fractional remote number', () => {
    assert.equal(isAdoptionCheckpoint(baseCheckpoint({ remoteNumber: 1.5 })), false);
  });

  test('rejects a missing completion context', () => {
    const checkpoint = baseCheckpoint();
    delete checkpoint.completionContext;
    assert.equal(isAdoptionCheckpoint(checkpoint), false);
  });

  test('rejects a malformed completion context', () => {
    assert.equal(isAdoptionCheckpoint(baseCheckpoint({ completionContext: { owner: 'drungrin' } })), false);
  });
});

describe('outcome journal selectors: confirmedKeys, checkpointedKeys, mutatedKeys', () => {
  test('the canonical case: one create-confirmed, one observe-confirmed, one observe-unchanged, one already-exists — 2 confirmed, 3 checkpointed, 1 mutated', () => {
    const outcomes = [
      { logicalKey: 'option:status:todo', operationKey: 'op-1', action: OPERATION_ACTION.CREATE, result: OPERATION_OUTCOME.CONFIRMED },
      { logicalKey: 'field:status', operationKey: null, action: OPERATION_ACTION.OBSERVE, result: OPERATION_OUTCOME.CONFIRMED },
      { logicalKey: 'project', operationKey: null, action: OPERATION_ACTION.OBSERVE, result: OPERATION_OUTCOME.UNCHANGED },
      { logicalKey: 'label:gsd-phase', operationKey: 'op-2', action: OPERATION_ACTION.CREATE, result: OPERATION_OUTCOME.ALREADY_EXISTS },
    ];
    assert.equal(confirmedKeys(outcomes).length, 2);
    assert.equal(checkpointedKeys(outcomes).length, 3);
    assert.equal(mutatedKeys(outcomes).length, 1);
    assert.deepStrictEqual(mutatedKeys(outcomes), ['option:status:todo']);
  });

  test('confirmedKeys preserves dispatch order and duplicates rather than deduplicating', () => {
    const outcomes = [
      { logicalKey: 'a', operationKey: 'op-1', action: OPERATION_ACTION.UPDATE, result: OPERATION_OUTCOME.CONFIRMED },
      { logicalKey: 'a', operationKey: 'op-1', action: OPERATION_ACTION.UPDATE, result: OPERATION_OUTCOME.CONFIRMED },
      { logicalKey: 'b', operationKey: 'op-2', action: OPERATION_ACTION.CREATE, result: OPERATION_OUTCOME.CONFIRMED },
    ];
    assert.deepStrictEqual(confirmedKeys(outcomes), ['a', 'a', 'b']);
  });

  test('checkpointedKeys excludes an already-exists result', () => {
    const outcomes = [
      { logicalKey: 'a', operationKey: 'op-1', action: OPERATION_ACTION.CREATE, result: OPERATION_OUTCOME.ALREADY_EXISTS },
    ];
    assert.deepStrictEqual(checkpointedKeys(outcomes), []);
  });
});
