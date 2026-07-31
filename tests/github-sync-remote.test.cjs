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
  if (connection === 'subIssues') return { data: { repository: { issue: { subIssues: page } } } };
  return { data: { viewer: { projectV2: { [connection]: page } } } };
}

function fixtureExec(fixture) {
  const calls = [];
  const cursors = { items: 0, fields: 0, subIssues: 0 };
  return {
    calls,
    execGh(args) {
      const query = args.find((arg) => arg.startsWith('query='));
      const connection = ['items', 'fields', 'subIssues'].find((name) => query.includes(`github-sync:${name}`));
      calls.push({ connection, args });
      const page = fixture[connection][cursors[connection]++];
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
      content: index === 0 ? { number: 101 } : index === 1 ? { number: 202 } : null,
    }));
    const subNodes = Array.from({ length: 101 }, (_, index) => ({ id: `SUB-101-${index + 1}`, number: index + 1 }));
    const pages = {
      items: [
        { nodes: itemNodes.slice(0, 100), pageInfo: { hasNextPage: true, endCursor: 'items-2' } },
        { nodes: itemNodes.slice(100), pageInfo: { hasNextPage: false, endCursor: null } },
      ],
      fields: [
        { nodes: [{ id: 'FIELD-1' }], pageInfo: { hasNextPage: true, endCursor: 'fields-2' } },
        { nodes: [{ id: 'FIELD-2' }], pageInfo: { hasNextPage: false, endCursor: null } },
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
      cwd: '/tmp', owner: 'octo', repo: 'example', projectNumber: 7,
      execGh(args) {
        const query = args.find((arg) => arg.startsWith('query='));
        const connection = ['items', 'fields', 'subIssues'].find((name) => query.includes(`github-sync:${name}`));
        const issueArg = args.find((arg) => arg.startsWith('issueNumber='));
        const parent = connection === 'subIssues' ? Number(issueArg.slice('issueNumber='.length)) : null;
        calls.push({ connection, parent, args });
        const page = connection === 'subIssues' ? pages.subIssues[parent][cursors[parent]++] : pages[connection][cursors[connection]++];
        return { exitCode: 0, reason: 'ok', stdout: JSON.stringify(envelope(connection, page)), stderr: '' };
      },
    });

    assert.equal(result.available, true);
    assert.deepEqual(result.target, { owner: 'octo', repo: 'example', projectNumber: 7 });
    assert.equal(result.items.length, 101);
    assert.equal(result.fields.length, 2);
    assert.equal(result.subIssues.length, 102);
    assert.deepEqual(result.subIssues.filter((entry) => entry.parentIssueNumber === 101).map((entry) => entry.node.id), subNodes.map((node) => node.id));
    assert.deepEqual(result.subIssues.filter((entry) => entry.parentIssueNumber === 202).map((entry) => entry.node.id), ['SUB-202-1']);
    assert.deepEqual(calls.map(({ connection, parent }) => [connection, parent]), [['items', null], ['items', null], ['fields', null], ['fields', null], ['subIssues', 101], ['subIssues', 101], ['subIssues', 202]]);
    for (const call of calls) {
      assert.ok(call.args.includes('owner=octo') || call.connection !== 'subIssues');
      assert.ok(call.args.includes('repo=example') || call.connection !== 'subIssues');
      assert.ok(call.args.includes('projectNumber=7') || call.connection === 'subIssues');
    }
  });

  test('exhausts independent item, field, and sub-issue cursors in stable order', () => {
    const fake = fixtureExec(fixtures['two-pages']);
    const result = readRemoteSnapshot({ cwd: '/tmp', owner: 'octo', repo: 'example', projectNumber: 1, subIssueNumber: 101, execGh: fake.execGh });

    assert.strictEqual(result.available, true);
    assert.deepStrictEqual(result.items.map((node) => node.id), ['ITEM-1', 'ITEM-2']);
    assert.deepStrictEqual(result.fields.map((node) => node.id), ['FIELD-1', 'FIELD-2']);
    assert.deepStrictEqual(result.subIssues.map((node) => node.id), ['SUB-1', 'SUB-2']);
    assert.deepStrictEqual(fake.calls.map((call) => call.connection), ['items', 'items', 'fields', 'fields', 'subIssues', 'subIssues']);
  });

  test('returns stable empty arrays when all fixture connections are empty', () => {
    const fake = fixtureExec(fixtures.empty);
    const result = readRemoteSnapshot({ cwd: '/tmp', owner: 'octo', repo: 'example', projectNumber: 1, execGh: fake.execGh });

    assert.deepStrictEqual(result, {
      available: true,
      reason: REMOTE_REASON.OK,
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
