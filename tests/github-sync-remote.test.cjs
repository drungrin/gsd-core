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
  test('exhausts independent item, field, and sub-issue cursors in stable order', () => {
    const fake = fixtureExec(fixtures['two-pages']);
    const result = readRemoteSnapshot({ cwd: '/tmp', owner: 'octo', repo: 'example', projectNumber: 1, execGh: fake.execGh });

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
