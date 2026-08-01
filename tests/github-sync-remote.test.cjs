'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { readRemoteSnapshot, REMOTE_REASON } = require('../gsd-core/bin/lib/github-sync-remote.cjs');
const fixtures = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/github-sync/remote-pages.json'), 'utf8'),
);

function envelope(connection, page) {
  if (connection === 'issueId') return { data: { repository: { issue: page } } };
  if (connection === 'project') return { data: { viewer: { projectV2: page } } };
  if (connection === 'subIssues') return { data: { repository: { issue: { subIssues: page } } } };
  return { data: { viewer: { projectV2: { [connection]: page } } } };
}

function fixtureExec(fixture) {
  const calls = [];
  const cursors = { items: 0, fields: 0, subIssues: 0 };
  const subIssueCursors = new Map();
  return {
    calls,
    execGh(args) {
      const query = args.find((arg) => arg.startsWith('query='));
      const connection = ['project', 'items', 'fields', 'subIssues', 'issueId'].find((name) => query.includes(`github-sync:${name}`));
      calls.push({ connection, args });
      const issueArg = args.find((arg) => arg.startsWith('issueNumber='));
      const issueNumber = issueArg ? Number(issueArg.slice('issueNumber='.length)) : null;
      const cursor = connection === 'subIssues' ? (subIssueCursors.get(issueNumber) ?? 0) : cursors[connection]++;
      if (connection === 'subIssues') subIssueCursors.set(issueNumber, cursor + 1);
      const page = connection === 'project'
        ? fixture.project
        : connection === 'issueId'
          ? fixture.issueIds[String(issueNumber)]
          : fixture[connection][cursor];
      return { exitCode: 0, reason: 'ok', stdout: JSON.stringify(envelope(connection, page)), stderr: '' };
    },
  };
}

describe('readRemoteSnapshot', () => {
  test('exhausts 101-plus items and every discovered Issue parent sub-issue connection with target identity', () => {
    assert.equal(fixtures['over-100-pages'].generated, true);
    const calls = [];
    const itemNodes = Array.from({ length: 101 }, (_, index) => ({
      id: `ITEM-${index + 1}`,
      content: index === 0 ? { id: 'ISSUE_NODE_101', number: 101 } : index === 1 ? { id: 'ISSUE_NODE_202', number: 202 } : null,
    }));
    const subNodes = Array.from({ length: 101 }, (_, index) => ({ id: `SUB-101-${index + 1}`, number: index + 1 }));
    const pages = {
      items: [
        { nodes: itemNodes.slice(0, 100), pageInfo: { hasNextPage: true, endCursor: 'items-2' } },
        { nodes: itemNodes.slice(100), pageInfo: { hasNextPage: false, endCursor: null } },
      ],
      fields: [
        { nodes: [{ id: 'PVTF_field_1', name: 'Status' }], pageInfo: { hasNextPage: true, endCursor: 'fields-2' } },
        { nodes: [{ id: 'PVTSSF_field_2', name: 'Title' }], pageInfo: { hasNextPage: false, endCursor: null } },
      ],
      subIssues: {
        101: [
          { nodes: subNodes.slice(0, 100), pageInfo: { hasNextPage: true, endCursor: 'sub-101-2' } },
          { nodes: subNodes.slice(100), pageInfo: { hasNextPage: false, endCursor: null } },
        ],
        202: [{ nodes: [{ id: 'SUB-202-1', number: 1 }], pageInfo: { hasNextPage: false, endCursor: null } }],
      },
    };
    const cursors = { items: 0, fields: 0, 101: 0, 202: 0 };
    const result = readRemoteSnapshot({
      cwd: '/tmp', owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 7,
      execGh(args) {
        const query = args.find((arg) => arg.startsWith('query='));
        const connection = ['project', 'items', 'fields', 'subIssues'].find((name) => query.includes(`github-sync:${name}`));
        const issueArg = args.find((arg) => arg.startsWith('issueNumber='));
        const parent = connection === 'subIssues' ? Number(issueArg.slice('issueNumber='.length)) : null;
        calls.push({ connection, parent, args });
        const page = connection === 'project'
          ? { id: 'PVT_proj_node_1' }
          : connection === 'subIssues'
            ? pages.subIssues[parent][cursors[parent]++]
            : pages[connection][cursors[connection]++];
        return { exitCode: 0, reason: 'ok', stdout: JSON.stringify(envelope(connection, page)), stderr: '' };
      },
    });

    assert.equal(result.available, true);
    assert.deepEqual(result.target, {
      owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 7, projectNodeId: 'PVT_proj_node_1',
    });
    assert.equal(result.items.length, 101);
    assert.equal(result.fields.length, 2);
    assert.equal(result.subIssues.length, 102);
    assert.deepEqual(result.items.slice(0, 2).map((entry) => entry.content), [
      { id: 'ISSUE_NODE_101', number: 101 },
      { id: 'ISSUE_NODE_202', number: 202 },
    ]);
    assert.deepEqual(result.subIssues.filter((entry) => entry.parentIssueNumber === 101).map((entry) => entry.id), subNodes.map((node) => node.id));
    assert.deepEqual(result.subIssues.filter((entry) => entry.parentIssueNumber === 202).map((entry) => entry.id), ['SUB-202-1']);
    assert.deepEqual(calls.map(({ connection, parent }) => [connection, parent]), [['project', null], ['items', null], ['items', null], ['fields', null], ['fields', null], ['subIssues', 101], ['subIssues', 101], ['subIssues', 202]]);
    for (const call of calls) {
      assert.ok(call.args.includes('owner=octo') || call.connection !== 'subIssues');
      assert.ok(call.args.includes('repo=example') || call.connection !== 'subIssues');
      assert.ok(call.args.includes('projectNumber=7') || call.connection === 'subIssues');
    }
  });

  test('exhausts independent item, field, and sub-issue cursors in stable order', () => {
    const fake = fixtureExec(fixtures['two-pages']);
    const result = readRemoteSnapshot({ cwd: '/tmp', owner: 'octo', repo: 'example', repositoryNumber: 1, projectNumber: 1, subIssueNumber: 101, execGh: fake.execGh });

    assert.strictEqual(result.available, true);
    assert.equal(result.target.projectNodeId, 'PVT_proj_node_1');
    assert.deepStrictEqual(result.items.map((node) => node.id), ['ITEM-1', 'ITEM-2']);
    assert.deepStrictEqual(result.fields.map((node) => ({ id: node.id, name: node.name })), [
      { id: 'PVTF_field_1', name: 'Status' },
      { id: 'PVTSSF_field_2', name: 'Title' },
    ]);
    assert.deepStrictEqual(result.subIssues.map((node) => node.id), ['SUB-1', 'SUB-2', 'SUB-1', 'SUB-2']);
    assert.deepStrictEqual(fake.calls.map((call) => call.connection), ['project', 'items', 'items', 'fields', 'fields', 'subIssues', 'subIssues', 'subIssues', 'subIssues']);
  });

  test('dispatches a fields document that selects scalars inside an inline fragment on ProjectV2FieldCommon', () => {
    const fake = fixtureExec(fixtures['two-pages']);
    readRemoteSnapshot({ cwd: '/tmp', owner: 'octo', repo: 'example', repositoryNumber: 1, projectNumber: 1, execGh: fake.execGh });
    const fieldsCall = fake.calls.find((call) => call.connection === 'fields');
    const query = fieldsCall.args.find((arg) => arg.startsWith('query=')).slice('query='.length);
    assert.match(
      query,
      /fields\(first:100,after:\$endCursor\)\s*\{\s*nodes\s*\{\s*\.\.\.\s*on\s+ProjectV2FieldCommon\s*\{\s*id\s+name\s*\}\s*\}/,
      'the fields document must select id/name inside an inline fragment on the ProjectV2FieldCommon interface, not directly on the ProjectV2FieldConfiguration union',
    );
  });

  test('returns stable empty arrays when all fixture connections are empty', () => {
    const fake = fixtureExec(fixtures.empty);
    const result = readRemoteSnapshot({ cwd: '/tmp', owner: 'octo', repo: 'example', repositoryNumber: 1, projectNumber: 1, execGh: fake.execGh });

    assert.deepStrictEqual(result, {
      available: true,
      reason: REMOTE_REASON.OK,
      target: { owner: 'octo', repo: 'example', repositoryNumber: 1, projectNumber: 1, projectNodeId: 'PVT_proj_node_empty' },
      items: [],
      fields: [],
      subIssues: [],
      issueNodeIds: {},
    });
  });

  test('selects the project node ID before paginated reads and fails closed on a missing or empty project ID', () => {
    const fake = fixtureExec(fixtures['two-pages']);
    const result = readRemoteSnapshot({ cwd: '/tmp', owner: 'octo', repo: 'example', repositoryNumber: 1, projectNumber: 1, execGh: fake.execGh });
    assert.equal(result.available, true);
    assert.equal(result.target.projectNodeId, 'PVT_proj_node_1');
    assert.equal(fake.calls[0].connection, 'project');

    const unavailable = readRemoteSnapshot({
      cwd: '/tmp', owner: 'octo', repo: 'example', repositoryNumber: 1, projectNumber: 1,
      execGh(args) {
        const query = args.find((arg) => arg.startsWith('query='));
        if (query.includes('github-sync:project')) {
          return { exitCode: 0, reason: 'ok', stdout: JSON.stringify(envelope('project', fixtures['project-missing-id'].project)), stderr: 'secret project failure' };
        }
        throw new Error('project failure must short-circuit pagination');
      },
    });
    assert.deepStrictEqual(unavailable, {
      available: false,
      reason: REMOTE_REASON.UNAVAILABLE,
      items: [],
      fields: [],
      subIssues: [],
    });
  });

  test('resolves deduped ascending issue node ID hints and omits null issues', () => {
    const fake = fixtureExec(fixtures.empty);
    const result = readRemoteSnapshot({
      cwd: '/tmp',
      owner: 'octo',
      repo: 'example',
      repositoryNumber: 1,
      projectNumber: 1,
      issueNodeIdHints: [303, 101, 303, 101],
      execGh: fake.execGh,
    });

    assert.equal(result.available, true);
    assert.deepEqual(result.issueNodeIds, { 101: 'ISSUE_NODE_101' });
    assert.deepEqual(
      fake.calls.map((call) => [call.connection, call.args.find((arg) => arg.startsWith('issueNumber=')) ?? null]),
      [
        ['project', null],
        ['items', null],
        ['fields', null],
        ['issueId', 'issueNumber=101'],
        ['issueId', 'issueNumber=303'],
      ],
    );
  });

  test('fails closed when a hinted issue node-ID read fails at the transport boundary', () => {
    const result = readRemoteSnapshot({
      cwd: '/tmp',
      owner: 'octo',
      repo: 'example',
      repositoryNumber: 1,
      projectNumber: 1,
      issueNodeIdHints: [101],
      execGh(args) {
        const query = args.find((arg) => arg.startsWith('query='));
        if (query.includes('github-sync:project')) {
          return { exitCode: 0, reason: 'ok', stdout: JSON.stringify(envelope('project', fixtures.empty.project)), stderr: '' };
        }
        if (query.includes('github-sync:items')) {
          return { exitCode: 0, reason: 'ok', stdout: JSON.stringify(envelope('items', fixtures.empty.items[0])), stderr: '' };
        }
        if (query.includes('github-sync:fields')) {
          return { exitCode: 0, reason: 'ok', stdout: JSON.stringify(envelope('fields', fixtures.empty.fields[0])), stderr: '' };
        }
        if (query.includes('github-sync:issueId')) {
          return { exitCode: 1, reason: 'gh_exit_nonzero', stdout: '', stderr: 'secret issue lookup failure' };
        }
        throw new Error(`unexpected query: ${query}`);
      },
    });

    assert.deepEqual(result, {
      available: false,
      reason: REMOTE_REASON.UNAVAILABLE,
      items: [],
      fields: [],
      subIssues: [],
    });
  });

  test('returns typed unavailable data without raw GraphQL output for errors and non-progressing cursors', () => {
    const graphqlError = readRemoteSnapshot({
      cwd: '/tmp',
      owner: 'octo',
      repo: 'example',
      repositoryNumber: 1,
      projectNumber: 1,
      execGh: () => ({ exitCode: 0, reason: 'ok', stdout: JSON.stringify(fixtures['graphql-error']), stderr: 'secret raw output' }),
    });
    assert.deepStrictEqual(graphqlError, {
      available: false,
      reason: REMOTE_REASON.UNAVAILABLE,
      items: [],
      fields: [],
      subIssues: [],
    });

    const stalled = readRemoteSnapshot({
      cwd: '/tmp',
      owner: 'octo',
      repo: 'example',
      repositoryNumber: 1,
      projectNumber: 1,
      execGh: () => ({ exitCode: 0, reason: 'ok', stdout: JSON.stringify(envelope('items', {
        nodes: [{ id: 'ITEM-1', content: { number: 101 } }],
        pageInfo: { hasNextPage: true, endCursor: null },
      })), stderr: '' }),
    });
    assert.strictEqual(stalled.available, false);
    assert.strictEqual(stalled.reason, REMOTE_REASON.UNAVAILABLE);
  });
});
