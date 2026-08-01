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

const contract = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/github-sync/graphql-documents-contract.json'), 'utf8'),
);

// The repo forbids a new package-manager install for a two-scalar selection-set
// guard, so these documents are parsed with a small brace-depth walker rather
// than a GraphQL dependency (T-02-SC).
function extractSelectionBody(query, anchor) {
  const anchorIndex = query.indexOf(anchor);
  if (anchorIndex === -1) return null;
  const braceStart = query.indexOf('{', anchorIndex);
  if (braceStart === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < query.length; i++) {
    if (query[i] === '{') depth++;
    else if (query[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;
  return query.slice(braceStart + 1, end);
}

function collectDepthZeroIdentifiers(text) {
  const identifiers = [];
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') { depth--; i++; continue; }
    if (depth === 0 && /[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
      identifiers.push(text.slice(i, j));
      i = j;
      continue;
    }
    i++;
  }
  return identifiers;
}

// Returns { fragmentTarget, fields, bareOutsideFragment } for the selection body
// anchored at `anchor` in `query`. If the body opens with an inline fragment
// (`... on Type { ... }`), descends into the fragment's balanced body and
// reports any trailing selection outside it; otherwise reports the depth-zero
// identifiers of the body directly (a bare, non-fragment selection).
function parseSelection(query, anchor) {
  const body = extractSelectionBody(query, anchor);
  if (body === null) return null;
  const trimmed = body.trim();
  const fragmentMatch = trimmed.match(/^\.\.\.\s*on\s+(\w+)\s*\{/);
  if (!fragmentMatch) {
    return { fragmentTarget: null, fields: collectDepthZeroIdentifiers(trimmed), bareOutsideFragment: false };
  }
  const fragmentStart = fragmentMatch[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = fragmentStart; i < trimmed.length; i++) {
    if (trimmed[i] === '{') depth++;
    else if (trimmed[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const inner = trimmed.slice(fragmentStart + 1, end);
  const rest = trimmed.slice(end + 1).trim();
  return { fragmentTarget: fragmentMatch[1], fields: collectDepthZeroIdentifiers(inner), bareOutsideFragment: rest.length > 0 };
}

function selectionAnchor(name, entry) {
  if (entry.connection) return 'nodes';
  if (name === 'project') return 'projectV2';
  return 'issue(number';
}

// Drives a full readRemoteSnapshot run (one item whose content resolves an
// issue number, so subIssues dispatches too, plus an issueNodeIdHints entry so
// issueId dispatches) and returns a Map of connection name -> the exact query
// text dispatched for it. This is the reader's actual argv, not DOCUMENTS
// (which stays unexported per this plan's prohibitions) — the guard below can
// only fail against what the reader really sends.
function captureDispatchedDocuments() {
  const calls = [];
  readRemoteSnapshot({
    cwd: '/tmp',
    owner: 'octo',
    repo: 'example',
    repositoryNumber: 1,
    projectNumber: 1,
    issueNodeIdHints: [101],
    execGh(args) {
      const query = args.find((arg) => arg.startsWith('query='));
      const connection = ['project', 'items', 'fields', 'subIssues', 'issueId'].find((name) => query.includes(`github-sync:${name}`));
      calls.push({ connection, query: query.slice('query='.length) });
      const page = connection === 'project'
        ? { id: 'PVT_proj_node_contract' }
        : connection === 'items'
          ? { nodes: [{ id: 'ITEM-1', content: { id: 'ISSUE_NODE_101', number: 101 } }], pageInfo: { hasNextPage: false, endCursor: null } }
          : connection === 'fields'
            ? { nodes: [{ id: 'PVTF_contract_1', name: 'Status' }], pageInfo: { hasNextPage: false, endCursor: null } }
            : connection === 'subIssues'
              ? { nodes: [{ id: 'SUB-CONTRACT-1', number: 1 }], pageInfo: { hasNextPage: false, endCursor: null } }
              : { id: 'ISSUE_NODE_101' };
      return { exitCode: 0, reason: 'ok', stdout: JSON.stringify(envelope(connection, page)), stderr: '' };
    },
  });
  const documents = new Map();
  for (const call of calls) {
    if (!documents.has(call.connection)) documents.set(call.connection, call.query);
  }
  return documents;
}

describe('DOCUMENTS schema contract', () => {
  test('every document actually dispatched has a contract entry, and vice versa (Guard 1: completeness)', () => {
    const documents = captureDispatchedDocuments();
    assert.deepStrictEqual([...documents.keys()].sort(), Object.keys(contract.documents).sort());
  });

  test('every union/interface-typed connection selects only through a recorded inline fragment (Guard 2: union safety)', () => {
    const documents = captureDispatchedDocuments();
    for (const [name, entry] of Object.entries(contract.documents)) {
      if (entry.nodeKind !== 'UNION' && entry.nodeKind !== 'INTERFACE') continue;
      const selection = parseSelection(documents.get(name), selectionAnchor(name, entry));
      assert.ok(selection.fragmentTarget, `${name} (nodeKind ${entry.nodeKind}) must select through an inline fragment, not bare scalars on the abstract type`);
      assert.ok(entry.fragmentTargets.includes(selection.fragmentTarget), `${name} fragment target "${selection.fragmentTarget}" is not one of the recorded valid targets ${JSON.stringify(entry.fragmentTargets)}`);
      assert.strictEqual(selection.bareOutsideFragment, false, `${name} must not select any field outside its inline fragment`);
    }
  });

  test('every dispatched document selects exactly its recorded field set (Guard 3: selection parity)', () => {
    const documents = captureDispatchedDocuments();
    for (const [name, entry] of Object.entries(contract.documents)) {
      const selection = parseSelection(documents.get(name), selectionAnchor(name, entry));
      assert.deepStrictEqual([...selection.fields].sort(), [...entry.selects].sort(), `${name} selection drifted from the recorded contract`);
    }
  });

  test('every paginated document selects pageInfo { hasNextPage endCursor } (Guard 4: pagination, SYNC-04)', () => {
    const documents = captureDispatchedDocuments();
    for (const [name, entry] of Object.entries(contract.documents)) {
      if (!entry.paginated) continue;
      const pageInfo = parseSelection(documents.get(name), 'pageInfo');
      assert.ok(pageInfo, `${name} must select pageInfo`);
      assert.deepStrictEqual([...pageInfo.fields].sort(), ['endCursor', 'hasNextPage']);
    }
  });

  test('every recorded fixture node key set equals its document\'s recorded selection (Guard 5: fixture parity, DOC-03)', () => {
    for (const [name, entry] of Object.entries(contract.documents)) {
      if (!entry.connection) continue;
      for (const [fixtureName, fixture] of Object.entries(fixtures)) {
        const pages = fixture[name];
        if (!Array.isArray(pages)) continue;
        for (const page of pages) {
          for (const node of page.nodes ?? []) {
            const keys = Object.keys(node).filter((key) => key !== 'parentIssueNumber');
            assert.deepStrictEqual(keys.sort(), [...entry.selects].sort(), `fixtures.${fixtureName}.${name} node ${JSON.stringify(node)} drifted from the recorded selection ${JSON.stringify(entry.selects)}`);
          }
        }
      }
    }
  });
});

// Captures the FULL argv of every dispatched gh call (not just the query=
// argument), so flag-level regressions are visible to assertions.
function captureDispatchedArgv() {
  const calls = [];
  readRemoteSnapshot({
    cwd: '/tmp',
    owner: 'octo',
    repo: 'example',
    repositoryNumber: 1,
    projectNumber: 1,
    issueNodeIdHints: [101],
    execGh(args) {
      calls.push([...args]);
      const query = args.find((arg) => arg.startsWith('query='));
      const connection = ['project', 'items', 'fields', 'subIssues', 'issueId'].find((name) => query.includes(`github-sync:${name}`));
      const page = connection === 'project'
        ? { id: 'PVT_proj_node_contract' }
        : connection === 'items'
          ? { nodes: [{ id: 'ITEM-1', content: { id: 'ISSUE_NODE_101', number: 101 } }], pageInfo: { hasNextPage: false, endCursor: null } }
          : connection === 'fields'
            ? { nodes: [{ id: 'PVTF_contract_1', name: 'Status' }], pageInfo: { hasNextPage: false, endCursor: null } }
            : connection === 'subIssues'
              ? { nodes: [{ id: 'SUB-CONTRACT-1', number: 1 }], pageInfo: { hasNextPage: false, endCursor: null } }
              : { id: 'ISSUE_NODE_101' };
      return { exitCode: 0, reason: 'ok', stdout: JSON.stringify(envelope(connection, page)), stderr: '' };
    },
  });
  return calls;
}

// `gh`'s typed `-F/--field` flag performs magic value substitution BEFORE the
// request is built: a value starting with `@` is read from a local file (`@-`
// from stdin), and `{owner}`/`{repo}`/`{branch}` are expanded from the local
// git repo. This is not shell injection — array argv already prevents that —
// it is gh's own documented field semantics, so it survives spawnSync entirely.
//
// Confirmed live against gh 2.96.0: `-F owner=@canary.txt` transmits the
// FILE CONTENTS to api.github.com, while `-f owner=@canary.txt` sends the
// literal string. readSyncTarget validates owner/repo only as non-empty
// strings, so any value reaching `-F` is an exfiltration vector.
describe('gh field-flag safety (no local-file read via -F)', () => {
  test('every -F value is a bare integer; unvalidated strings ride -f', () => {
    for (const args of captureDispatchedArgv()) {
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== '-F') continue;
        const pair = args[i + 1];
        const value = pair.slice(pair.indexOf('=') + 1);
        assert.match(
          value,
          /^\d+$/,
          `-F ${pair} carries a non-integer value. gh's typed -F flag expands a leading "@" into a local file read and substitutes {owner}/{repo}/{branch}. Only validated positive integers may use -F; every string variable must use -f.`,
        );
      }
    }
  });

  test('owner and repo are never dispatched on -F', () => {
    for (const args of captureDispatchedArgv()) {
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== '-F') continue;
        const key = args[i + 1].slice(0, args[i + 1].indexOf('='));
        assert.ok(
          key !== 'owner' && key !== 'repo',
          `${key} is a config-sourced string with no charset restriction and must use -f, not -F`,
        );
      }
    }
  });

  test('a config-sourced owner beginning with @ reaches gh verbatim, not as a file read', () => {
    const dispatched = [];
    readRemoteSnapshot({
      cwd: '/tmp',
      owner: '@/etc/passwd',
      repo: 'example',
      repositoryNumber: 1,
      projectNumber: 1,
      issueNodeIdHints: [101],
      execGh(args) {
        dispatched.push([...args]);
        const query = args.find((arg) => arg.startsWith('query='));
        const connection = ['project', 'items', 'fields', 'subIssues', 'issueId'].find((name) => query.includes(`github-sync:${name}`));
        const page = connection === 'project'
          ? { id: 'PVT_proj_node_contract' }
          : connection === 'items'
            ? { nodes: [{ id: 'ITEM-1', content: { id: 'ISSUE_NODE_101', number: 101 } }], pageInfo: { hasNextPage: false, endCursor: null } }
            : connection === 'fields'
              ? { nodes: [{ id: 'PVTF_contract_1', name: 'Status' }], pageInfo: { hasNextPage: false, endCursor: null } }
              : connection === 'subIssues'
                ? { nodes: [{ id: 'SUB-CONTRACT-1', number: 1 }], pageInfo: { hasNextPage: false, endCursor: null } }
                : { id: 'ISSUE_NODE_101' };
        return { exitCode: 0, reason: 'ok', stdout: JSON.stringify(envelope(connection, page)), stderr: '' };
      },
    });
    const ownerArgs = dispatched.flatMap((args) => args.filter((arg) => arg.startsWith('owner=')));
    assert.ok(ownerArgs.length > 0, 'expected at least one owner argument to be dispatched');
    for (const args of dispatched) {
      const index = args.findIndex((arg) => arg.startsWith('owner='));
      if (index === -1) continue;
      assert.equal(args[index - 1], '-f', 'an @-prefixed owner must be dispatched with -f so gh sends it verbatim instead of reading the named file');
    }
  });
});
