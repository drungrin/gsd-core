'use strict';

/**
 * github-sync-command-router.test.cjs — exhaustive disabled-gate proof
 * (CAP-01/CAP-02) plus the SAFE-02 structural assertion (Phase 1, plan 01-03).
 *
 * Modeled on tests/graphify.test.cjs's spawnSync mock pattern (mock.restoreAll
 * in afterEach) and tests/graphify-command-cutover.test.cjs's cutover shape.
 *
 * Purpose: CAP-02 promises that EVERY command — including subcommand names
 * that are not registered, and the literal string 'init' — is a silent no-op
 * when github_sync.enabled is false. Only a gate that runs before subcommand
 * lookup (D-06) can keep this promise structurally. This file drives seven
 * subcommand strings (registered, unregistered, empty, and absent) through
 * the disabled path with spawn and filesystem-write traps armed, asserting
 * zero calls on both and no output across every case.
 *
 * Per 01-RESEARCH.md Pitfall 1: none of these disabled-path assertions expect
 * an "unknown subcommand" message — that would validate the wrong behavior.
 * The gate suppresses subcommand lookup entirely; the unknown-subcommand path
 * is proven separately (enabled + unregistered case, below).
 */

const { describe, test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { spawnSync, spawn } = require('node:child_process');

const { createTempProject, cleanup, TOOLS_PATH } = require('./helpers.cjs');
const realMapForInit = require('../gsd-core/bin/lib/github-sync-map.cjs');

const { routeGithubSyncCommandRouter } = require('../gsd-core/bin/lib/github-sync-command-router.cjs');
const { PREFLIGHT_REASON } = require('../gsd-core/bin/lib/github-sync-auth.cjs');
// G-02-2: the real compiled status module, not an injected renderer stub — a
// stub cannot prove the default-path/--raw wiring these tests exist to check.
const realStatus = require('../gsd-core/bin/lib/github-sync-status.cjs');

test('enabled status composes only read seams and never receives a write adapter', () => {
  const calls = [];
  const outputChunks = [];
  mock.method(fs, 'writeSync', (_fd, chunk) => { outputChunks.push(String(chunk)); return Buffer.byteLength(String(chunk)); });
  try {
    routeGithubSyncCommandRouter({
      args: ['github-sync', 'status'], cwd: '/fixture', raw: true,
      error: (message) => { throw new Error(message); },
      _isCapabilityActive: () => true,
      _target: { readSyncTarget(cwd) { calls.push(['target', cwd]); return { available: true, target: { owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 7 } }; } },
      _desired: { readDesiredState(cwd) { calls.push(['desired', cwd]); return { available: true }; } },
      _remote: { readRemoteSnapshot(options) { calls.push(['remote', options]); return { available: true }; } },
      _map: { readSyncMapStrict(cwd, repository) { calls.push(['map', cwd, repository]); return { kind: 'valid', map: { completions: { 'phase:01': { nodeId: 'item-01', issueNumber: 101 } } } }; }, writeSyncMapAtomically() { throw new Error('status must not write map'); } },
      _reconcile: { planReconciliation(...inputs) { calls.push(['reconcile', inputs.length]); return { operations: [], noops: [], blocked: [], uncertain: [] }; } },
      _status: { buildStatusV1(remote, plan) { calls.push(['status', remote.available, plan.operations.length]); return { version: 1, available: true }; }, renderStatusV1(dto) { return JSON.stringify(dto); } },
    });
  } finally {
    mock.restoreAll();
  }
  assert.deepEqual(calls, [['desired', '/fixture'], ['target', '/fixture'], ['map', '/fixture', { owner: 'octo', repo: 'example', number: 42 }], ['remote', { cwd: '/fixture', owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 7, issueNodeIdHints: [101] }], ['reconcile', 3], ['status', true, 0]]);
  assert.deepEqual(outputChunks, ['{"version":1,"available":true}']);
});

test('enabled status propagates its resolved target yet cannot apply or persist on available and unavailable paths', () => {
  const calls = [];
  mock.method(fs, 'writeSync', () => 1);
  try {
    for (const available of [true, false]) {
      routeGithubSyncCommandRouter({
        args: ['github-sync', 'status'], cwd: '/fixture', raw: true,
        error: (message) => { throw new Error(message); },
        _isCapabilityActive: () => true,
        _target: { readSyncTarget() { return { available: true, target: { owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 7 } }; } },
        _desired: { readDesiredState() { return { available: true }; } },
        _remote: { readRemoteSnapshot(options) { calls.push(['remote', available, options]); return { available, reason: available ? 'ok' : 'remote_unavailable' }; } },
        _map: {
          readSyncMapStrict(cwd, repository) { calls.push(['map', available, cwd, repository]); return { kind: 'valid', map: { completions: { 'phase:01': { nodeId: 'item-01', issueNumber: 101 } } } }; },
          writeSyncMapAtomically() { throw new Error('status must never persist a map'); },
        },
        _reconcile: { planReconciliation() { calls.push(['reconcile', available]); return { operations: [], noops: [], blocked: [], uncertain: [] }; } },
        _status: { buildStatusV1(remote, plan) { calls.push(['status', available, remote.available, plan]); return { version: 1, available: remote.available }; }, renderStatusV1(dto) { return JSON.stringify(dto); } },
        _apply: { applyMutationPlan() { throw new Error('status must never apply mutations'); } },
      });
    }
  } finally { mock.restoreAll(); }
  assert.deepEqual(calls, [
    ['map', true, '/fixture', { owner: 'octo', repo: 'example', number: 42 }],
    ['remote', true, { cwd: '/fixture', owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 7, issueNodeIdHints: [101] }],
    ['reconcile', true], ['status', true, true, { operations: [], noops: [], blocked: [], uncertain: [] }],
    ['map', false, '/fixture', { owner: 'octo', repo: 'example', number: 42 }],
    ['remote', false, { cwd: '/fixture', owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 7, issueNodeIdHints: [101] }],
    ['reconcile', false], ['status', false, false, { operations: [], noops: [], blocked: [], uncertain: [] }],
  ]);
});

test('enabled sync preflights, composes authoritative inputs, and passes the reconciler plan to the applier', () => {
  const calls = [];
  const chunks = [];
  mock.method(fs, 'writeSync', (_fd, chunk) => { chunks.push(String(chunk)); return Buffer.byteLength(String(chunk)); });
  try {
    routeGithubSyncCommandRouter({
      args: ['github-sync', 'sync'], cwd: '/fixture', raw: true,
      error: (message) => { throw new Error(message); },
      _isCapabilityActive: () => true,
      _target: { readSyncTarget(cwd) { calls.push(['target', cwd]); return { available: true, target: { owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 7 } }; } },
      _auth: { runPreflight(cwd) { calls.push(['preflight', cwd]); return { ok: true, reason: 'ok', message: 'ok' }; } },
      _desired: { readDesiredState(cwd) { calls.push(['desired', cwd]); return { available: true }; } },
      _remote: { readRemoteSnapshot(options) { calls.push(['remote', options]); return { available: true }; } },
      _map: { readSyncMapStrict(cwd, repository) { calls.push(['map', cwd, repository]); return { kind: 'valid', map: { completions: { 'phase:01': { nodeId: 'item-01', issueNumber: 101 }, 'phase:03': { nodeId: 'item-03', issueNumber: 303 } } } }; } },
      _reconcile: { planReconciliation(...inputs) { calls.push(['reconcile', inputs.length]); return { operations: [{ logicalKey: 'phase:01' }], noops: [], blocked: [], uncertain: [], pendingIssueUpdates: [] }; } },
      _issueUpdate: { prepareIssueUpdates(pending, adapters) { calls.push(['issueUpdate', pending.length, adapters.cwd]); return { operations: [], reports: [] }; } },
      _apply: { applyMutationPlan(plan, options) { calls.push(['apply', plan.operations[0].logicalKey, options.map]); return { kind: 'completed' }; } },
    });
  } finally { mock.restoreAll(); }
  assert.deepEqual(calls, [['preflight', '/fixture'], ['desired', '/fixture'], ['target', '/fixture'], ['map', '/fixture', { owner: 'octo', repo: 'example', number: 42 }], ['remote', { cwd: '/fixture', owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 7, issueNodeIdHints: [101, 303] }], ['reconcile', 3], ['issueUpdate', 0, '/fixture'], ['apply', 'phase:01', { completions: { 'phase:01': { nodeId: 'item-01', issueNumber: 101 }, 'phase:03': { nodeId: 'item-03', issueNumber: 303 } } }]]);
  assert.deepEqual(chunks, ['{\n  "kind": "completed",\n  "issueUpdateReports": [],\n  "subIssueCeilingWarnings": []\n}']);
});

// ─── Bug fix: collectIssueNodeIdHints must not feed bootstrap completions
// (project/milestone/field/option/label numbers) into the issue-number
// lookup — only completions that represent a real GitHub issue. Discovered
// live against UAT board #9 (`.planning/phases/04-phase-issue-sync/
// deferred-items.md` § "Plan 04-06"): a `project` completion's issueNumber
// (a project number) and a `milestone:<version>` completion's issueNumber (a
// milestone number) were both fed into `readRemoteSnapshot`'s
// issueNodeIdHints, which queried GitHub's issue-by-number lookup for each —
// GitHub correctly returned NOT_FOUND, cascading to a full
// `remote_unavailable`/`uncertain` failure on every `status`/`sync` call
// once a target was bootstrapped. No prior fixture combined a bootstrap
// completion with an issue-bearing one in the same map, which is exactly why
// this went undetected until a live run against a real, previously adopted
// board.
test('status hint collection excludes bootstrap completions (project/milestone) and passes only issue-bearing phase numbers', () => {
  const calls = [];
  mock.method(fs, 'writeSync', () => 1);
  try {
    routeGithubSyncCommandRouter({
      args: ['github-sync', 'status'], cwd: '/fixture', raw: true,
      error: (message) => { throw new Error(message); },
      _isCapabilityActive: () => true,
      _target: { readSyncTarget() { return { available: true, target: { owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 9 } }; } },
      _desired: { readDesiredState() { return { available: true }; } },
      _remote: { readRemoteSnapshot(options) { calls.push(['remote', options]); return { available: true }; } },
      _map: {
        readSyncMapStrict() {
          return {
            kind: 'valid',
            map: {
              completions: {
                // Bootstrap completions (D-05/D-07): issueNumber is the
                // generic remote-number slot reused for a project number and
                // a milestone number — never a real issue number.
                project: { logicalKey: 'project', nodeId: 'PVT_1', issueNumber: 9 },
                'milestone:v1-0': { logicalKey: 'milestone:v1-0', nodeId: 'MI_1', issueNumber: 4 },
                // Issue-bearing completions: the legacy pre-Phase-4
                // `phase:<id>` key (github-sync-reconcile.cts's
                // `resolvedIssueNodeId` still resolves these against
                // issueNodeIdHints) and the Phase 4 `issue:phase:<id>` key.
                'phase:01': { logicalKey: 'phase:01', nodeId: 'item-01', issueNumber: 101 },
                'issue:phase:02': { logicalKey: 'issue:phase:02', nodeId: 'ISSUE_02', issueNumber: 202 },
              },
            },
          };
        },
      },
      _reconcile: { planReconciliation() { return { operations: [], noops: [], blocked: [], uncertain: [] }; } },
      _status: { buildStatusV1(remote, plan) { calls.push(['status', remote.available, plan.operations.length]); return { version: 1, available: remote.available }; }, renderStatusV1(dto) { return JSON.stringify(dto); } },
    });
  } finally { mock.restoreAll(); }
  const remoteCall = calls.find(([label]) => label === 'remote');
  assert.deepEqual(remoteCall[1].issueNodeIdHints, [101, 202]);
});

test('enabled sync stops at preflight or unavailable desired state without reaching later seams', () => {
  const calls = [];
  const makeOptions = (preflight) => ({
    args: ['github-sync', 'sync'], cwd: '/fixture', raw: true,
    error: (message) => { throw new Error(message); },
    _isCapabilityActive: () => true,
    _auth: { runPreflight() { calls.push('preflight'); return preflight; } },
    _desired: { readDesiredState() { calls.push('desired'); return { available: false, reason: 'local_unavailable' }; } },
    _remote: { readRemoteSnapshot() { throw new Error('remote must not run'); } },
    _map: { readSyncMapStrict() { throw new Error('map must not run'); } },
    _reconcile: { planReconciliation() { throw new Error('reconcile must not run'); } },
    _apply: { applyMutationPlan() { throw new Error('apply must not run'); } },
  });
  mock.method(fs, 'writeSync', () => 1);
  try {
    routeGithubSyncCommandRouter(makeOptions({ ok: false, reason: 'outage', message: 'fixed preflight failure' }));
    assert.deepEqual(calls, ['preflight']);
    calls.length = 0;
    routeGithubSyncCommandRouter(makeOptions({ ok: true, reason: 'ok', message: 'ok' }));
    assert.deepEqual(calls, ['preflight', 'desired']);
  } finally { mock.restoreAll(); }
});

// ─── Plan 04-04 Task 3: wire the issue-update preparation stage into `sync`,
// and report orphans/pending updates from `status` with no new authority ──

describe('github-sync router: plan 04-04 Task 3 — issue-update preparation stage wiring', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  test('status against a plan with pending updates and orphans emits both groups and never calls the preparation stage', () => {
    const chunks = [];
    mock.method(fs, 'writeSync', (_fd, chunk) => { chunks.push(String(chunk)); return Buffer.byteLength(String(chunk)); });
    try {
      routeGithubSyncCommandRouter({
        args: ['github-sync', 'status'], cwd: '/fixture', raw: false,
        error: (message) => { throw new Error(message); },
        _isCapabilityActive: () => true,
        _status: realStatus,
        _target: { readSyncTarget() { return { available: true, target: { owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 7 } }; } },
        _desired: { readDesiredState() { return { available: true }; } },
        _remote: { readRemoteSnapshot() { return { available: true, reason: 'ok' }; } },
        _map: { readSyncMapStrict() { return { kind: 'valid', map: { completions: {} } }; } },
        _reconcile: {
          planReconciliation() {
            return {
              operations: [], noops: [], blocked: [], uncertain: [],
              orphans: [{ logicalKey: 'phase:09', issueNumber: 77 }],
              pendingIssueUpdates: [{ logicalKey: 'phase:03' }],
            };
          },
        },
        // Never wired to `status` — a throw here would fail this test if it were.
        _issueUpdate: { prepareIssueUpdates() { throw new Error('status must never call the preparation stage'); } },
      });
    } finally { mock.restoreAll(); }
    const out = chunks.join('');
    assert.match(out, /orphans: 1/);
    assert.match(out, /phase:09 \(77\)/);
    assert.match(out, /updates-pending: 1/);
    assert.match(out, /\n {2}- phase:03\n/);
  });

  test("sync against a plan with one pending update calls the preparation stage once, appends its produced operation after the plan's own operations, and dispatches the combined list deterministically", () => {
    const calls = [];
    mock.method(fs, 'writeSync', () => 1);
    try {
      routeGithubSyncCommandRouter({
        args: ['github-sync', 'sync'], cwd: '/fixture', raw: true,
        error: (message) => { throw new Error(message); },
        _isCapabilityActive: () => true,
        _auth: { runPreflight() { return { ok: true, reason: 'ok', message: 'ok' }; } },
        _desired: { readDesiredState() { return { available: true }; } },
        _target: { readSyncTarget() { return { available: true, target: { owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 7 } }; } },
        _map: { readSyncMapStrict() { return { kind: 'valid', map: { completions: {} } }; } },
        _remote: { readRemoteSnapshot() { return { available: true }; } },
        _reconcile: {
          planReconciliation() {
            return {
              operations: [{ logicalKey: 'phase:01', kind: 'create' }],
              noops: [], blocked: [], uncertain: [],
              pendingIssueUpdates: [{ logicalKey: 'phase:02' }],
            };
          },
        },
        _issueUpdate: {
          prepareIssueUpdates(pending, adapters) {
            calls.push(['issueUpdate', pending, adapters.cwd]);
            return { operations: [{ logicalKey: 'issue:phase:02', kind: 'update-issue' }], reports: [] };
          },
        },
        _apply: {
          applyMutationPlan(plan) {
            calls.push(['apply', plan.operations.map((op) => op.logicalKey)]);
            return { kind: 'completed' };
          },
        },
      });
    } finally { mock.restoreAll(); }
    assert.deepEqual(calls, [
      ['issueUpdate', [{ logicalKey: 'phase:02' }], '/fixture'],
      ['apply', ['phase:01', 'issue:phase:02']],
    ]);
  });

  test('sync against a plan whose only pending update is damaged dispatches nothing for it, surfaces the report in its result, and still exits 0', () => {
    process.exitCode = 0;
    const chunks = [];
    mock.method(fs, 'writeSync', (_fd, chunk) => { chunks.push(String(chunk)); return Buffer.byteLength(String(chunk)); });
    try {
      routeGithubSyncCommandRouter({
        args: ['github-sync', 'sync'], cwd: '/fixture', raw: true,
        error: (message) => { throw new Error(message); },
        _isCapabilityActive: () => true,
        _auth: { runPreflight() { return { ok: true, reason: 'ok', message: 'ok' }; } },
        _desired: { readDesiredState() { return { available: true }; } },
        _target: { readSyncTarget() { return { available: true, target: { owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 7 } }; } },
        _map: { readSyncMapStrict() { return { kind: 'valid', map: { completions: {} } }; } },
        _remote: { readRemoteSnapshot() { return { available: true }; } },
        _reconcile: {
          planReconciliation() {
            return { operations: [], noops: [], blocked: [], uncertain: [], pendingIssueUpdates: [{ logicalKey: 'phase:07' }] };
          },
        },
        _issueUpdate: {
          prepareIssueUpdates() {
            return { operations: [], reports: [{ logicalKey: 'phase:07', reason: 'region_damaged', detail: 'two begin fences' }] };
          },
        },
        _apply: { applyMutationPlan(plan) { return { kind: 'completed', operationsDispatched: plan.operations.length }; } },
      });
    } finally { mock.restoreAll(); }
    assert.strictEqual(process.exitCode, 0);
    const parsed = JSON.parse(chunks.join(''));
    assert.equal(parsed.operationsDispatched, 0);
    assert.deepEqual(parsed.issueUpdateReports, [{ logicalKey: 'phase:07', reason: 'region_damaged', detail: 'two begin fences' }]);
  });
});

// ─── Plan 05-07: the sub-issue-per-parent ceiling warning surfaces from
// both `status` and `sync`, and neither command gains new authority ────────

describe('github-sync router: plan 05-07 — sub-issue ceiling warning wiring', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  test('status against a plan with a sub-issue-ceiling warning emits the group and dispatches no mutation', () => {
    const chunks = [];
    mock.method(fs, 'writeSync', (_fd, chunk) => { chunks.push(String(chunk)); return Buffer.byteLength(String(chunk)); });
    try {
      routeGithubSyncCommandRouter({
        args: ['github-sync', 'status'], cwd: '/fixture', raw: false,
        error: (message) => { throw new Error(message); },
        _isCapabilityActive: () => true,
        _status: realStatus,
        _target: { readSyncTarget() { return { available: true, target: { owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 7 } }; } },
        _desired: { readDesiredState() { return { available: true }; } },
        _remote: { readRemoteSnapshot() { return { available: true, reason: 'ok' }; } },
        _map: { readSyncMapStrict() { return { kind: 'valid', map: { completions: {} } }; } },
        _reconcile: {
          planReconciliation() {
            return {
              operations: [], noops: [], blocked: [], uncertain: [],
              subIssueCeilingWarnings: [{ phaseId: '05', issueNumber: 900, count: 91, limit: 100 }],
            };
          },
        },
        // status is a dry run — neither seam below may ever be reached.
        _issueUpdate: { prepareIssueUpdates() { throw new Error('status must never call the preparation stage'); } },
        _apply: { applyMutationPlan() { throw new Error('status must never apply mutations'); } },
      });
    } finally { mock.restoreAll(); }
    const out = chunks.join('');
    assert.match(out, /sub-issue-ceiling-warnings: 1/);
    assert.match(out, /\n {2}- 05 \(91\/100\)\n/);
  });

  test('sync against a plan with a sub-issue-ceiling warning carries the warning in its result and still exits 0', () => {
    process.exitCode = 0;
    const chunks = [];
    mock.method(fs, 'writeSync', (_fd, chunk) => { chunks.push(String(chunk)); return Buffer.byteLength(String(chunk)); });
    try {
      routeGithubSyncCommandRouter({
        args: ['github-sync', 'sync'], cwd: '/fixture', raw: true,
        error: (message) => { throw new Error(message); },
        _isCapabilityActive: () => true,
        _auth: { runPreflight() { return { ok: true, reason: 'ok', message: 'ok' }; } },
        _desired: { readDesiredState() { return { available: true }; } },
        _target: { readSyncTarget() { return { available: true, target: { owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 7 } }; } },
        _map: { readSyncMapStrict() { return { kind: 'valid', map: { completions: {} } }; } },
        _remote: { readRemoteSnapshot() { return { available: true }; } },
        _reconcile: {
          planReconciliation() {
            return {
              operations: [{ logicalKey: 'phase:01', kind: 'create' }],
              noops: [], blocked: [], uncertain: [],
              subIssueCeilingWarnings: [{ phaseId: '05', issueNumber: 900, count: 91, limit: 100 }],
            };
          },
        },
        _issueUpdate: { prepareIssueUpdates() { return { operations: [], reports: [] }; } },
        _apply: { applyMutationPlan(plan) { return { kind: 'completed', operationsDispatched: plan.operations.length }; } },
      });
    } finally { mock.restoreAll(); }
    assert.strictEqual(process.exitCode, 0);
    const parsed = JSON.parse(chunks.join(''));
    assert.equal(parsed.operationsDispatched, 1);
    assert.deepEqual(parsed.subIssueCeilingWarnings, [{ phaseId: '05', issueNumber: 900, count: 91, limit: 100 }]);
  });

  test('sync against a plan predating warnings (no subIssueCeilingWarnings field at all) still carries an empty array in its result', () => {
    const chunks = [];
    mock.method(fs, 'writeSync', (_fd, chunk) => { chunks.push(String(chunk)); return Buffer.byteLength(String(chunk)); });
    try {
      routeGithubSyncCommandRouter({
        args: ['github-sync', 'sync'], cwd: '/fixture', raw: true,
        error: (message) => { throw new Error(message); },
        _isCapabilityActive: () => true,
        _auth: { runPreflight() { return { ok: true, reason: 'ok', message: 'ok' }; } },
        _desired: { readDesiredState() { return { available: true }; } },
        _target: { readSyncTarget() { return { available: true, target: { owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 7 } }; } },
        _map: { readSyncMapStrict() { return { kind: 'valid', map: { completions: {} } }; } },
        _remote: { readRemoteSnapshot() { return { available: true }; } },
        _reconcile: { planReconciliation() { return { operations: [], noops: [], blocked: [], uncertain: [] }; } },
        _issueUpdate: { prepareIssueUpdates() { return { operations: [], reports: [] }; } },
        _apply: { applyMutationPlan() { return { kind: 'completed' }; } },
      });
    } finally { mock.restoreAll(); }
    const parsed = JSON.parse(chunks.join(''));
    assert.deepEqual(parsed.subIssueCeilingWarnings, []);
  });
});

// ─── G-02-2: default status path renders human, --raw stays JSON ────────────
//
// The pre-existing two tests above inject a stub `renderStatusV1` and drive
// only `raw: true` — they prove composition, not the human/machine split.
// These three tests drive the real compiled status module (`realStatus`,
// imported above) as `_status` so the router's actual wiring is exercised:
// an injected renderer stub could pass even if the default path were still
// stranded on JSON, which is exactly how G-02-2 shipped broken.

describe('github-sync status: G-02-2 default-path/--raw wiring (real status module)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  function captureStdout() {
    const chunks = [];
    mock.method(fs, 'writeSync', (_fd, data, offset, length) => {
      const chunk = chunkOfWriteSyncArgs(data, offset, length);
      chunks.push(chunk);
      return Buffer.byteLength(chunk, 'utf8');
    });
    return chunks;
  }

  const AVAILABLE_TARGET = { owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 7 };

  function makeAvailableOptions(raw) {
    return {
      args: ['github-sync', 'status'], cwd: '/fixture', raw,
      error: (message) => { throw new Error(message); },
      _isCapabilityActive: () => true,
      _status: realStatus,
      _target: { readSyncTarget() { return { available: true, target: AVAILABLE_TARGET }; } },
      _desired: { readDesiredState() { return { available: true }; } },
      _remote: { readRemoteSnapshot() { return { available: true, reason: 'ok' }; } },
      _map: { readSyncMapStrict() { return { kind: 'valid', map: { completions: {} } }; } },
      _reconcile: {
        planReconciliation() {
          return {
            operations: [{ kind: 'create', logicalKey: 'phase:02' }],
            noops: [{ logicalKey: 'phase:01' }],
            blocked: [], uncertain: [],
          };
        },
      },
    };
  }

  test('default path (raw: false) prints the human summary — stdout does not parse as JSON and names the planned keys', () => {
    const chunks = captureStdout();
    try {
      routeGithubSyncCommandRouter(makeAvailableOptions(false));
    } finally { mock.restoreAll(); }
    const stdout = chunks.join('');
    assert.throws(() => JSON.parse(stdout), 'default status stdout must NOT parse as JSON (G-02-2)');
    assert.match(stdout, /github-sync status/);
    assert.match(stdout, /phase:02/, 'planned create must be named by its logical key');
    assert.match(stdout, /phase:01/, 'existing no-op must be named by its logical key');
  });

  test('--raw path (raw: true) still emits the unchanged compact v1 JSON', () => {
    const chunks = captureStdout();
    try {
      routeGithubSyncCommandRouter(makeAvailableOptions(true));
    } finally { mock.restoreAll(); }
    const stdout = chunks.join('');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(stdout); }, `--raw stdout must parse as JSON; got: ${stdout}`);
    assert.strictEqual(parsed.version, 1);
    assert.strictEqual(parsed.available, true);
    assert.deepEqual(parsed.creates, ['phase:02']);
    assert.deepEqual(parsed.updates, []);
    assert.deepEqual(parsed.noops, ['phase:01']);
  });

  test('unavailable remote on the default path (raw: false) prints the operator-facing message, not JSON, and leaves exit code untouched (D-16)', () => {
    const chunks = captureStdout();
    process.exitCode = 0;
    try {
      routeGithubSyncCommandRouter({
        args: ['github-sync', 'status'], cwd: '/fixture', raw: false,
        error: (message) => { throw new Error(message); },
        _isCapabilityActive: () => true,
        _status: realStatus,
        _target: { readSyncTarget() { return { available: true, target: AVAILABLE_TARGET }; } },
        _desired: { readDesiredState() { return { available: true }; } },
        _remote: { readRemoteSnapshot() { return { available: false, reason: 'remote_unavailable' }; } },
        _map: { readSyncMapStrict() { return { kind: 'valid', map: { completions: {} } }; } },
        _reconcile: { planReconciliation() { return { operations: [], noops: [], blocked: [], uncertain: [] }; } },
      });
    } finally { mock.restoreAll(); }
    assert.strictEqual(process.exitCode, 0, 'D-16: unavailable status must not gate the loop');
    const stdout = chunks.join('');
    assert.throws(() => JSON.parse(stdout), 'unavailable default-path stdout must NOT parse as JSON');
    assert.match(stdout, /github-sync status is unavailable/);
  });
});

// ─── G-02-4: a local github_sync.target fault is diagnosed, not misreported ─
//
// Before this fix, the status handler collapsed `!resolvedTarget.available`
// into `buildStatusV1({available:false, reason:'remote_unavailable'})`,
// producing output byte-identical to a genuine GitHub outage. These tests
// drive the real compiled status module (`realStatus`) so the router's
// actual field-propagation wiring is exercised, and assert the target-fault
// stdout is provably different from the remote-outage stdout emitted by the
// existing tests above.

describe('github-sync status: G-02-4 target-fault diagnosis (real status module)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  function captureStdout() {
    const chunks = [];
    mock.method(fs, 'writeSync', (_fd, data, offset, length) => {
      const chunk = chunkOfWriteSyncArgs(data, offset, length);
      chunks.push(chunk);
      return Buffer.byteLength(chunk, 'utf8');
    });
    return chunks;
  }

  function makeTargetFaultOptions(raw) {
    return {
      args: ['github-sync', 'status'], cwd: '/fixture', raw,
      error: (message) => { throw new Error(message); },
      _isCapabilityActive: () => true,
      _status: realStatus,
      _target: { readSyncTarget() { return { available: false, reason: 'target_unavailable', field: 'repository_number' }; } },
      _desired: { readDesiredState() { return { available: true }; } },
      _remote: { readRemoteSnapshot() { throw new Error('remote must not run on a local target fault'); } },
      _map: {
        readSyncMapStrict() { throw new Error('map must not be read on a local target fault'); },
        writeSyncMapAtomically() { throw new Error('status must never persist a map'); },
      },
    };
  }

  test('a repository_number target fault names the field, exits 0, and reaches neither remote nor map (raw: false)', () => {
    const chunks = captureStdout();
    process.exitCode = 0;
    try {
      routeGithubSyncCommandRouter(makeTargetFaultOptions(false));
    } finally { mock.restoreAll(); }
    const stdout = chunks.join('');
    assert.strictEqual(process.exitCode, 0, 'D-16: a local target fault must not gate the loop');
    assert.throws(() => JSON.parse(stdout), 'default target-fault stdout must NOT parse as JSON');
    assert.strictEqual(
      stdout,
      'github-sync status is unavailable because github_sync.target.repository_number in .planning/config.json is invalid. Set it to a positive whole number, then re-run.\n',
    );
  });

  test('a local target fault differs from a genuine remote outage, which keeps its pre-existing message (raw: false)', () => {
    const targetFaultChunks = captureStdout();
    routeGithubSyncCommandRouter(makeTargetFaultOptions(false));
    mock.restoreAll();
    const targetFaultStdout = targetFaultChunks.join('');

    const outageChunks = captureStdout();
    routeGithubSyncCommandRouter({
      args: ['github-sync', 'status'], cwd: '/fixture', raw: false,
      error: (message) => { throw new Error(message); },
      _isCapabilityActive: () => true,
      _status: realStatus,
      _target: { readSyncTarget() { return { available: true, target: { owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 7 } }; } },
      _desired: { readDesiredState() { return { available: true }; } },
      _remote: { readRemoteSnapshot() { return { available: false, reason: 'remote_unavailable' }; } },
      _map: { readSyncMapStrict() { return { kind: 'valid', map: { completions: {} } }; } },
      _reconcile: { planReconciliation() { return { operations: [], noops: [], blocked: [], uncertain: [] }; } },
    });
    mock.restoreAll();
    const outageStdout = outageChunks.join('');

    assert.notStrictEqual(targetFaultStdout, outageStdout, 'a local config fault must not read the same as a remote outage (G-02-4)');
    assert.match(outageStdout, /Retry shortly/);
    assert.doesNotMatch(targetFaultStdout, /Retry shortly/, 'retrying can never fix a local config fault');
  });

  test('--raw carries a typed target_unavailable blocker with the field as detail, and an empty uncertain list', () => {
    const chunks = captureStdout();
    try {
      routeGithubSyncCommandRouter(makeTargetFaultOptions(true));
    } finally { mock.restoreAll(); }
    const parsed = JSON.parse(chunks.join(''));
    assert.strictEqual(parsed.available, false);
    assert.deepEqual(parsed.blocked, [{ reason: 'target_unavailable', detail: 'repository_number' }]);
    assert.deepEqual(parsed.uncertain, []);
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Sorted recursive listing of a directory: relative path + byte size for
 * every file. Used to prove a disabled run performs literally zero
 * filesystem writes at the subprocess level (not just the traps it hits).
 */
function listFilesRecursive(dir) {
  const results = [];
  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const stat = fs.statSync(full);
        results.push({ path: path.relative(dir, full), size: stat.size });
      }
    }
  }
  walk(dir);
  results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return results;
}

/**
 * Direct spawnSync invocation of gsd-tools.cjs (not runGsdTools()) because
 * runGsdTools() discards streams on a zero-exit process, and the disabled-path
 * contract needs byte-accurate assertions that both streams stay empty.
 */
function runGithubSync(args, cwd, envOverrides = {}) {
  const result = spawnSync(process.execPath, [TOOLS_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, ...envOverrides },
  });
  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

/**
 * Async, non-blocking counterpart to `runGithubSync()`. Uses `spawn` (not
 * `spawnSync`) so multiple children can run concurrently — calling
 * `runGithubSync` in a loop would serialize the seven invocations and prove
 * nothing about concurrency (CAP-02).
 *
 * Returns `{ child, promise }`: `child` is the live handle (needed by the
 * interrupt test to send SIGTERM); `promise` resolves on the child's `close`
 * event with `{ status, signal, stdout, stderr }`. Never shells out via the
 * `shell` spawn option, and never invokes the GNU `timeout` binary — both are
 * non-portable on macOS/Windows.
 */
function spawnGithubSyncAsync(args, cwd) {
  const child = spawn(process.execPath, [TOOLS_PATH, ...args], {
    cwd,
    env: process.env,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const promise = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });
  return { child, promise };
}

function enableGithubSync(planningDir) {
  const configPath = path.join(planningDir, 'config.json');
  const config = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
    : {};
  config.github_sync = { enabled: true };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

// ─── 1. In-process: seven subcommand strings, zero I/O, identical message ────

describe('github-sync router: exhaustive disabled-gate proof (in-process)', () => {
  const CWD = '/fake/cwd';
  const RAW = false;

  // Registered, unregistered (including the literal 'init', unregistered
  // until a later phase), empty, and absent — one array so a future
  // subcommand string is one element away.
  const SUBCOMMAND_CASES = [
    { label: 'preflight (registered)', args: ['github-sync', 'preflight'] },
    { label: 'init (unregistered)', args: ['github-sync', 'init'] },
    { label: 'sync (unregistered)', args: ['github-sync', 'sync'] },
    { label: 'status (unregistered)', args: ['github-sync', 'status'] },
    { label: 'not-a-real-subcommand (unregistered)', args: ['github-sync', 'not-a-real-subcommand'] },
    { label: 'empty string subcommand', args: ['github-sync', ''] },
    { label: 'no subcommand at all', args: ['github-sync'] },
  ];

  afterEach(() => {
    mock.restoreAll();
  });

  function makeThrowingErrorCallback() {
    return (msg, reason) => {
      throw new Error(
        `error() must never be called on the disabled path (D-06 regression) — ` +
        `got msg="${msg}" reason="${reason}"`,
      );
    };
  }

  function makeThrowingAuth() {
    return {
      runPreflight() {
        throw new Error('runPreflight() must never be called on the disabled path (D-06 regression)');
      },
    };
  }

  test('all seven subcommand strings: silent, zero spawns, zero fs writes, exit stays 0', () => {
    const spawnCalls = [];
    mock.method(childProcess, 'spawnSync', (...callArgs) => {
      spawnCalls.push(callArgs);
      throw new Error('child_process.spawnSync must not be called on the disabled path');
    });

    const fsWriteCalls = [];
    for (const fsMethod of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync']) {
      mock.method(fs, fsMethod, (...callArgs) => {
        fsWriteCalls.push({ method: fsMethod, args: callArgs });
        throw new Error(`fs.${fsMethod} must not be called on the disabled path`);
      });
    }

    const stderrChunks = [];
    mock.method(process.stderr, 'write', (chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    for (const { label, args } of SUBCOMMAND_CASES) {
      stderrChunks.length = 0;
      process.exitCode = 0;

      routeGithubSyncCommandRouter({
        args,
        cwd: CWD,
        raw: RAW,
        error: makeThrowingErrorCallback(),
        _isCapabilityActive: () => false,
        _auth: makeThrowingAuth(),
      });

      assert.strictEqual(process.exitCode, 0, `${label}: process.exitCode must stay 0`);
      assert.deepStrictEqual(stderrChunks, [], `${label}: disabled path must not write stderr`);
    }

    assert.strictEqual(spawnCalls.length, 0,
      `spawnSync must never be called across all seven disabled cases; got ${spawnCalls.length} call(s)`);
    assert.strictEqual(fsWriteCalls.length, 0,
      `no filesystem write must occur across all seven disabled cases; got: ${JSON.stringify(fsWriteCalls)}`);

  });
});

// ─── 2. Subprocess: real zero-write proof + the enabled counter-proof ────────

describe('github-sync command family: subprocess disabled/enabled matrix', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('disabled (key omitted entirely): "github-sync init" exits 0, is silent, and makes zero filesystem writes', () => {
    const before = listFilesRecursive(tmpDir);
    const result = runGithubSync(['github-sync', 'init'], tmpDir);

    assert.strictEqual(result.status, 0, `expected exit 0; stderr: ${result.stderr}`);
    assert.strictEqual(result.stdout, '', `stdout must be empty; got: "${result.stdout}"`);
    assert.strictEqual(result.stderr, '', `stderr must be empty; got: "${result.stderr}"`);

    const after = listFilesRecursive(tmpDir);
    assert.deepStrictEqual(after, before,
      'the temp project\'s recursive file listing must be byte-identical before and after a disabled run');
  });

  test('enabled: "github-sync not-a-real-subcommand" does NOT take the disabled path — unknown-subcommand error', () => {
    enableGithubSync(path.join(tmpDir, '.planning'));

    const result = runGithubSync(['github-sync', 'not-a-real-subcommand'], tmpDir);

    assert.notStrictEqual(result.status, 0, 'an unregistered subcommand while enabled must not exit 0');
    assert.ok(result.stderr.includes('Unknown github-sync subcommand'),
      `expected the unknown-subcommand error; got: ${result.stderr}`);
    assert.ok(!result.stderr.includes('github_sync.enabled'),
      `must NOT be the disabled-path message (proves the gate is what suppresses it, not something else); got: ${result.stderr}`);
  });
});

// ─── 3. CAP-02 concurrency and interrupt evidence (subprocess) ───────────────
//
// Plan 01-03's must-have "Concurrent or interrupted github-sync invocations
// while disabled leave no file written and no partial state" was authored
// with `verification: backstop` — proven only by inference (zero I/O per
// single invocation implies safety under concurrency), never by an actual
// concurrent run. This block replaces the inference with a real one: seven
// children spawned essentially simultaneously (including a byte-identical
// duplicate `preflight` pair — the adjacency case — and the empty-string and
// no-subcommand-at-all degenerate cases), plus one child interrupted with
// SIGTERM mid-flight. No ordering is asserted across children; only each
// child's own content and the shared project's file listing are.

describe('github-sync router: CAP-02 concurrency and interrupt evidence (subprocess)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // One array so a future subcommand string is one element away. `preflight`
  // appears twice on purpose — two byte-identical simultaneous invocations
  // are the collision case the guarantee has to survive.
  const CONCURRENT_ARGS_CASES = [
    ['github-sync', 'preflight'],
    ['github-sync', 'preflight'],
    ['github-sync', 'init'],
    ['github-sync', 'sync'],
    ['github-sync', 'status'],
    ['github-sync', ''],
    ['github-sync'],
  ];

  test(
    'seven concurrent disabled invocations (including a byte-identical duplicate pair): all exit 0, byte-identical stderr, unchanged file tree (CAP-02)',
    { timeout: 60000 },
    async () => {
      const before = listFilesRecursive(tmpDir);

      // Start all seven children first, THEN await together — starting one
      // and awaiting it before starting the next would reintroduce the
      // serialization this test exists to eliminate.
      const spawned = CONCURRENT_ARGS_CASES.map((args) => spawnGithubSyncAsync(args, tmpDir));
      const results = await Promise.all(spawned.map((s) => s.promise));

      for (const [index, result] of results.entries()) {
        assert.strictEqual(result.status, 0,
          `CAP-02: child ${index} (args=${JSON.stringify(CONCURRENT_ARGS_CASES[index])}) must exit 0; stderr: ${result.stderr}`);
        assert.strictEqual(result.stdout, '',
          `CAP-02: child ${index} must keep stdout empty; got: "${result.stdout}"`);
        assert.strictEqual(result.stderr, '',
          `CAP-02: child ${index} must keep stderr empty; got: "${result.stderr}"`);
      }

      const after = listFilesRecursive(tmpDir);
      assert.deepStrictEqual(after, before,
        'CAP-02: the shared temp project\'s recursive file listing must be deep-equal before and after seven concurrent disabled invocations');
    },
  );

  test(
    'a disabled invocation interrupted with SIGTERM mid-flight leaves the file tree unchanged, whether it had already exited or not (CAP-02)',
    { timeout: 60000 },
    async () => {
      const before = listFilesRecursive(tmpDir);

      const { child, promise } = spawnGithubSyncAsync(['github-sync', 'preflight'], tmpDir);
      child.kill('SIGTERM');
      // Intentionally NOT asserting on result.status/result.signal: whether
      // the SIGTERM lands before or after the process finishes on its own is
      // a genuine race, and asserting on it would make this test flaky by
      // construction while proving nothing extra. The guarantee under test is
      // about the file tree, and it holds in both outcomes.
      await promise;

      const after = listFilesRecursive(tmpDir);
      assert.deepStrictEqual(after, before,
        'CAP-02: the temp project\'s recursive file listing must be deep-equal before and after a SIGTERM-interrupted disabled invocation, regardless of whether the signal beat the process to exit');
    },
  );
});

// ─── 4. D-11 containment matrix (throwing injected seams, WR-03) ────────────
//
// REVIEW.md WR-03: `activeCheck(...)` (call site A) and `auth.runPreflight(cwd)`
// (call site B) are called with no local try/catch. Neither throws today, but
// if either did, the exception would reach command-routing-hub.cjs's
// dispatch(), become a HandlerFailure, and set a non-zero exit code —
// contradicting D-11/SAFE-01's universal exit-0 contract. These tests inject
// throwing seams at both call sites and assert the containment holds for an
// Error, a bare string, and undefined alike, and that a distinctive marker
// carried in the thrown value never leaks into stdout or stderr.

/** Normalize a buffer-form or string-form fs.writeSync call to the chunk it emits. */
function chunkOfWriteSyncArgs(data, offset, length) {
  if (Buffer.isBuffer(data)) {
    const start = offset ?? 0;
    const end = length === undefined ? data.length : start + length;
    return data.subarray(start, end).toString('utf8');
  }
  return String(data);
}

describe('github-sync router: D-11 containment matrix (throwing injected seams)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  // One array so a thrown Error, a bare string, and undefined are each
  // exercised on both guarded call sites — the non-Error cases are not an
  // afterthought.
  const THROW_VARIANTS = [
    { label: 'Error', throwIt: (marker) => { throw new Error(marker); } },
    { label: 'bare string', throwIt: (marker) => { throw marker; } },
    { label: 'undefined', throwIt: () => { throw undefined; } },
  ];

  for (const { label, throwIt } of THROW_VARIANTS) {
    test(`capability-state resolution throwing a ${label}: exits 0, one stderr line, never reaches error() or _auth.runPreflight, no marker leak (WR-03/D-11)`, () => {
      const marker = `MARKER_CAP_STATE_${label.replace(/\s+/g, '_')}`;
      const stderrChunks = [];
      mock.method(process.stderr, 'write', (chunk) => { stderrChunks.push(String(chunk)); return true; });

      let errorCalled = false;
      let preflightCalled = false;
      process.exitCode = 0;

      routeGithubSyncCommandRouter({
        args: ['github-sync', 'preflight'],
        cwd: '/fake/cwd',
        raw: false,
        error: () => { errorCalled = true; },
        _isCapabilityActive: () => { throwIt(marker); },
        _auth: { runPreflight() { preflightCalled = true; return { ok: true, reason: PREFLIGHT_REASON.OK, message: 'x' }; } },
      });

      assert.strictEqual(process.exitCode, 0, `${label}: process.exitCode must stay 0`);
      assert.strictEqual(stderrChunks.length, 1, `${label}: exactly one stderr write; got: ${JSON.stringify(stderrChunks)}`);
      assert.strictEqual(errorCalled, false, `${label}: the injected error() callback must never be called`);
      assert.strictEqual(preflightCalled, false, `${label}: the injected _auth.runPreflight must never be called`);

      const stderrText = stderrChunks.join('');
      assert.ok(!stderrText.includes('github_sync.enabled'),
        `${label}: the containment message must be distinguishable from the ordinary disabled message; got: ${stderrText}`);
      assert.ok(!stderrText.includes(marker),
        `${label}: the thrown value's marker must never leak into stderr (binding-less catch); got: ${stderrText}`);
    });
  }

  for (const { label, throwIt } of THROW_VARIANTS) {
    test(`preflight call throwing a ${label}: exits 0, output has ok:false reason:OUTAGE, no marker leak (WR-03/D-11)`, () => {
      const marker = `MARKER_PREFLIGHT_${label.replace(/\s+/g, '_')}`;
      const stderrChunks = [];
      mock.method(process.stderr, 'write', (chunk) => { stderrChunks.push(String(chunk)); return true; });

      const stdoutChunks = [];
      mock.method(fs, 'writeSync', (fd, data, offset, length) => {
        const chunk = chunkOfWriteSyncArgs(data, offset, length);
        stdoutChunks.push(chunk);
        return Buffer.byteLength(chunk, 'utf8');
      });

      let errorCalled = false;
      process.exitCode = 0;

      routeGithubSyncCommandRouter({
        args: ['github-sync', 'preflight'],
        cwd: '/fake/cwd',
        raw: false,
        error: () => { errorCalled = true; },
        _isCapabilityActive: () => true,
        _auth: { runPreflight() { throwIt(marker); } },
      });

      assert.strictEqual(process.exitCode, 0, `${label}: process.exitCode must stay 0`);
      assert.strictEqual(errorCalled, false, `${label}: the injected error() callback must never be called — containment happens inside the handler`);

      const stdoutText = stdoutChunks.join('');
      let parsed;
      assert.doesNotThrow(() => { parsed = JSON.parse(stdoutText); },
        `${label}: output(...) must still emit valid JSON; got: ${stdoutText}`);
      assert.strictEqual(parsed.ok, false, `${label}: output object's ok must be strictly false; got: ${JSON.stringify(parsed)}`);
      assert.strictEqual(parsed.reason, PREFLIGHT_REASON.OUTAGE,
        `${label}: output object's reason must be strictly PREFLIGHT_REASON.OUTAGE; got: ${JSON.stringify(parsed)}`);
      assert.ok(typeof parsed.message === 'string' && parsed.message.length > 0,
        `${label}: output object's message must be a non-empty string; got: ${JSON.stringify(parsed)}`);

      const stderrText = stderrChunks.join('');
      assert.ok(!stdoutText.includes(marker),
        `${label}: the thrown value's marker must never leak into stdout (binding-less catch); got: ${stdoutText}`);
      assert.ok(!stderrText.includes(marker),
        `${label}: the thrown value's marker must never leak into stderr (binding-less catch); got: ${stderrText}`);
    });
  }
});

// ─── 5. SAFE-02 — every declared contribution carries onError: skip ─────────

describe('github-sync capability manifest: SAFE-02 structural rule', () => {
  test('hooks and contributions are arrays; every contribution declares onError: skip', () => {
    const manifestPath = path.join(__dirname, '..', 'capabilities', 'github-sync', 'capability.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    assert.ok(Array.isArray(manifest.hooks), 'capability.json "hooks" must be an array');
    assert.ok(Array.isArray(manifest.contributions), 'capability.json "contributions" must be an array');

    // Loop rather than an emptiness check — v1 declares zero contributions,
    // but the rule must survive the phases that add some.
    for (const contribution of manifest.contributions) {
      assert.strictEqual(contribution.onError, 'skip',
        `every declared contribution must carry onError: skip; got: ${JSON.stringify(contribution)}`);
    }
  });
});

// ─── 6. `init` — plan 03-02 registration, HIGH-1 map threading, HIGH-4 re-read ──

describe('github-sync router: init (plan 03-02, plan 03-03)', () => {
  const TARGET = { owner: 'octo', repo: 'repo', repositoryNumber: 1, projectNumber: 7 };
  const RESOLVE_TARGET_REASON = { CONFIGURED: 'configured', RESOLVED: 'resolved', UNRESOLVABLE: 'unresolvable' };

  /**
   * A `_bootstrapConfig` seam stub. `resolveTarget` reports `strictMapRead`
   * as `{ kind: 'absent' }` by default (plan 03-03's resolveTarget performs
   * the map read itself now, so the router no longer calls `map.readSyncMapStrict`
   * for `init`); `overrides.strictMapRead` lets a test inject a real strict-map
   * read for the HIGH-1 map-threading tests.
   */
  function bootstrapConfigStub(target, overrides = {}) {
    return {
      resolveTarget: () => ({
        target,
        reason: overrides.reason ?? RESOLVE_TARGET_REASON.CONFIGURED,
        strictMapRead: overrides.strictMapRead ?? { kind: 'absent' },
      }),
      readProjectTitle: () => overrides.projectTitle ?? null,
      // Plan 06-04: the closed-enum GraphQL layout member readViewLayout
      // always returns — a stub carrying no override still returns a
      // realistic value, never undefined reaching planBootstrap's argv.
      readViewLayout: overrides.readViewLayout ?? (() => overrides.viewLayout ?? 'BOARD_LAYOUT'),
      writeProjectNumber: overrides.writeProjectNumber ?? (() => ({ ok: true, reason: 'written' })),
      RESOLVE_TARGET_REASON,
    };
  }

  test('init appears in the registered subcommands and dispatches to a handler (reaches auth.runPreflight)', () => {
    let preflightCalled = false;
    routeGithubSyncCommandRouter({
      args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
      error: (message) => { throw new Error(message); },
      _isCapabilityActive: () => true,
      _auth: { runPreflight() { preflightCalled = true; return { ok: false, reason: 'outage', message: 'x' }; } },
    });
    assert.equal(preflightCalled, true);
  });

  test('init with the capability disabled produces no output and leaves process.exitCode at 0', () => {
    const chunks = [];
    mock.method(fs, 'writeSync', (_fd, chunk) => { chunks.push(String(chunk)); return Buffer.byteLength(String(chunk)); });
    process.exitCode = 0;
    try {
      routeGithubSyncCommandRouter({
        args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
        error: (message) => { throw new Error(message); },
        _isCapabilityActive: () => false,
      });
    } finally { mock.restoreAll(); }
    assert.equal(process.exitCode, 0);
    assert.deepEqual(chunks, []);
  });

  test('a thrown error inside the injected bootstrap seams leaves process.exitCode at 0 and emits a typed uncertain result', () => {
    const chunks = [];
    mock.method(fs, 'writeSync', (_fd, chunk) => { chunks.push(String(chunk)); return Buffer.byteLength(String(chunk)); });
    process.exitCode = 0;
    try {
      routeGithubSyncCommandRouter({
        args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
        error: (message) => { throw new Error(message); },
        _isCapabilityActive: () => true,
        _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
        _desired: { readDesiredState: () => ({ available: true }) },
        _bootstrapConfig: bootstrapConfigStub(TARGET),
        _bootstrapRemote: { readBootstrapRemoteState: () => { throw new Error('boom'); } },
      });
    } finally { mock.restoreAll(); }
    assert.equal(process.exitCode, 0);
    const parsed = JSON.parse(chunks.join(''));
    assert.equal(parsed.kind, 'uncertain');
    assert.equal(parsed.reason, 'init_unavailable');
  });

  test('a preflight failure carrying the wrong-scope reason names that scope failure specifically (unlike sync\'s collapse)', () => {
    const chunks = [];
    mock.method(fs, 'writeSync', (_fd, chunk) => { chunks.push(String(chunk)); return Buffer.byteLength(String(chunk)); });
    try {
      routeGithubSyncCommandRouter({
        args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
        error: (message) => { throw new Error(message); },
        _isCapabilityActive: () => true,
        _auth: { runPreflight: () => ({ ok: false, reason: PREFLIGHT_REASON.WRONG_SCOPE, message: 'missing project scope' }) },
      });
    } finally { mock.restoreAll(); }
    // Plan 03-06: `init`'s raw output is now the report DTO — the preflight
    // failure's own reason/message are forwarded verbatim into
    // report.outcome, not re-derived, so the wrong-scope reason still names
    // itself specifically (unlike sync's collapse to "preflight_unavailable").
    const parsed = JSON.parse(chunks.join(''));
    assert.equal(parsed.outcome.reason, PREFLIGHT_REASON.WRONG_SCOPE);
  });

  test('an init run whose desired-state seam reports unavailable produces the desired-unavailable blocked reason at exit code 0', () => {
    const chunks = [];
    mock.method(fs, 'writeSync', (_fd, chunk) => { chunks.push(String(chunk)); return Buffer.byteLength(String(chunk)); });
    process.exitCode = 0;
    try {
      routeGithubSyncCommandRouter({
        args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
        error: (message) => { throw new Error(message); },
        _isCapabilityActive: () => true,
        _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
        _desired: { readDesiredState: () => ({ available: false, reason: 'local_unavailable' }) },
        _bootstrapConfig: bootstrapConfigStub(TARGET),
        _bootstrapRemote: { readBootstrapRemoteState: () => ({ available: true, projectOutcome: 'resolved', statusField: null }) },
      });
    } finally { mock.restoreAll(); }
    assert.equal(process.exitCode, 0);
    const parsed = JSON.parse(chunks.join(''));
    assert.equal(parsed.outcome.kind, 'blocked');
    assert.equal(parsed.outcome.reason, 'desired_unavailable');
  });

  test('HIGH-1: the options pass writes into the map the structure pass returned, and the strict map is read exactly once', () => {
    const tmpDir = createTempProject();
    let mapReads = 0;
    try {
      routeGithubSyncCommandRouter({
        args: ['github-sync', 'init'], cwd: tmpDir, raw: true,
        error: (message) => { throw new Error(message); },
        _isCapabilityActive: () => true,
        _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
        _desired: { readDesiredState: () => ({ available: true }) },
        _bootstrapConfig: {
          // Plan 03-03: resolveTarget now performs the single strict-map
          // read itself (identity-then-map). Counting calls here proves the
          // router invokes resolveTarget — and therefore the map read it
          // performs — exactly once.
          resolveTarget: (callCwd) => {
            mapReads += 1;
            const strictMapRead = realMapForInit.readSyncMapStrict(callCwd, { owner: TARGET.owner, repo: TARGET.repo, number: TARGET.repositoryNumber });
            return { target: TARGET, reason: RESOLVE_TARGET_REASON.CONFIGURED, strictMapRead };
          },
          readProjectTitle: () => null,
          readViewLayout: () => 'BOARD_LAYOUT',
          writeProjectNumber: () => ({ ok: true, reason: 'written' }),
          RESOLVE_TARGET_REASON,
        },
        _bootstrapRemote: { readBootstrapRemoteState: () => ({ available: true, projectOutcome: 'resolved', statusField: null }) },
        _bootstrapPlan: {
          BOOTSTRAP_PASS: { STRUCTURE: 'structure', OPTIONS: 'options' },
          planBootstrap(_input, { pass }) {
            const context = { owner: TARGET.owner, repo: TARGET.repo, repositoryNumber: TARGET.repositoryNumber };
            if (pass === 'structure') {
              return {
                operations: [], noops: [], blocked: [], uncertain: [],
                checkpoints: [
                  { logicalKey: 'project', nodeId: 'PVT_1', completionContext: context },
                  { logicalKey: 'field:gsd-id', nodeId: 'FIELD_1', completionContext: context },
                ],
              };
            }
            return {
              operations: [], noops: [], blocked: [], uncertain: [],
              checkpoints: [
                { logicalKey: 'option:status:todo', nodeId: 'OPT_1', completionContext: context },
                { logicalKey: 'option:status:in-progress', nodeId: 'OPT_2', completionContext: context },
                { logicalKey: 'option:status:blocked', nodeId: 'OPT_3', completionContext: context },
              ],
            };
          },
        },
      });
      const mapPath = path.join(tmpDir, '.planning', '.github-sync.json');
      const written = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      assert.deepEqual(
        Object.keys(written.completions).sort(),
        ['field:gsd-id', 'option:status:blocked', 'option:status:in-progress', 'option:status:todo', 'project'].sort(),
      );
      assert.equal(mapReads, 1);
    } finally { cleanup(tmpDir); }
  });

  test('HIGH-1 (converged variant): the options pass confirms nothing, yet the reported final map still carries the structure pass\'s completions', () => {
    const tmpDir = createTempProject();
    try {
      const chunks = [];
      mock.method(fs, 'writeSync', (_fd, chunk) => { chunks.push(String(chunk)); return Buffer.byteLength(String(chunk)); });
      try {
        routeGithubSyncCommandRouter({
          args: ['github-sync', 'init'], cwd: tmpDir, raw: true,
          error: (message) => { throw new Error(message); },
          _isCapabilityActive: () => true,
          _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
          _desired: { readDesiredState: () => ({ available: true }) },
          _bootstrapConfig: {
            resolveTarget: (callCwd) => ({
              target: TARGET,
              reason: RESOLVE_TARGET_REASON.CONFIGURED,
              strictMapRead: realMapForInit.readSyncMapStrict(callCwd, { owner: TARGET.owner, repo: TARGET.repo, number: TARGET.repositoryNumber }),
            }),
            readProjectTitle: () => null,
            readViewLayout: () => 'BOARD_LAYOUT',
            writeProjectNumber: () => ({ ok: true, reason: 'written' }),
            RESOLVE_TARGET_REASON,
          },
          _bootstrapRemote: { readBootstrapRemoteState: () => ({ available: true, projectOutcome: 'resolved', statusField: null }) },
          _bootstrapPlan: {
            BOOTSTRAP_PASS: { STRUCTURE: 'structure', OPTIONS: 'options' },
            planBootstrap(_input, { pass }) {
              const context = { owner: TARGET.owner, repo: TARGET.repo, repositoryNumber: TARGET.repositoryNumber };
              if (pass === 'structure') {
                return { operations: [], noops: [], blocked: [], uncertain: [], checkpoints: [{ logicalKey: 'project', nodeId: 'PVT_1', completionContext: context }] };
              }
              return { operations: [], noops: [{ reason: 'nothing-to-do' }], blocked: [], uncertain: [], checkpoints: [] };
            },
          },
        });
      } finally { mock.restoreAll(); }
      // Plan 03-06: `init`'s raw output is the report DTO, which carries
      // per-stage counts rather than the raw map — the map-threading claim
      // is proven by reading the persisted file directly, as the sibling
      // HIGH-1 test above already does.
      const parsed = JSON.parse(chunks.join(''));
      assert.equal(parsed.outcome.kind, 'completed');
      const mapPath = path.join(tmpDir, '.planning', '.github-sync.json');
      const written = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      assert.ok(Object.keys(written.completions).includes('project'));
    } finally { cleanup(tmpDir); }
  });

  test('HIGH-4: the effective target feeds the conditional re-read — the second readBootstrapRemoteState call receives the structure pass\'s confirmed project number, not null', () => {
    const nullTarget = { owner: 'octo', repo: 'repo', repositoryNumber: 1, projectNumber: null };
    const remoteCalls = [];
    routeGithubSyncCommandRouter({
      args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
      error: (message) => { throw new Error(message); },
      _isCapabilityActive: () => true,
      _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
      _desired: { readDesiredState: () => ({ available: true }) },
      _bootstrapConfig: bootstrapConfigStub(nullTarget),
      _bootstrapRemote: {
        readBootstrapRemoteState(options) {
          remoteCalls.push(options.projectNumber);
          return { available: true, projectOutcome: options.projectNumber ? 'resolved' : 'unset', statusField: null };
        },
      },
      _bootstrapPlan: {
        BOOTSTRAP_PASS: { STRUCTURE: 'structure', OPTIONS: 'options' },
        planBootstrap(_input, { pass }) {
          if (pass === 'structure') return { operations: [{ logicalKey: 'project' }], noops: [], blocked: [], uncertain: [], checkpoints: [] };
          return { operations: [], noops: [], blocked: [], uncertain: [], checkpoints: [] };
        },
      },
      _apply: {
        applyMutationPlan(plan, options) {
          if (plan.operations.length > 0) {
            return {
              kind: 'completed',
              map: { version: '1', repository: { owner: 'octo', repo: 'repo', number: 1 }, completions: { project: { logicalKey: 'project', nodeId: 'PVT_NEW', issueNumber: 42, completedAt: 'now', owner: 'octo', repo: 'repo', repositoryNumber: 1 } } },
              outcomes: [{ logicalKey: 'project', operationKey: 'project', action: 'create', result: 'confirmed' }],
            };
          }
          return { kind: 'completed', map: options.map, outcomes: [] };
        },
      },
    });
    assert.deepEqual(remoteCalls, [null, 42]);
  });

  test('a run that mutated nothing issues exactly one remote read', () => {
    const remoteCalls = [];
    routeGithubSyncCommandRouter({
      args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
      error: (message) => { throw new Error(message); },
      _isCapabilityActive: () => true,
      _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
      _desired: { readDesiredState: () => ({ available: true }) },
      _bootstrapConfig: bootstrapConfigStub(TARGET),
      _bootstrapRemote: { readBootstrapRemoteState: (options) => { remoteCalls.push(options.projectNumber); return { available: true, projectOutcome: 'resolved', statusField: null }; } },
      _bootstrapPlan: {
        BOOTSTRAP_PASS: { STRUCTURE: 'structure', OPTIONS: 'options' },
        planBootstrap: () => ({ operations: [], noops: [{ reason: 'nothing-to-do' }], blocked: [], uncertain: [], checkpoints: [] }),
      },
    });
    assert.deepEqual(remoteCalls, [7]);
  });

  // ─── plan 03-04 Task 3: the re-read boundary, pinned in all four directions ──
  // The "converged run issues exactly one remote read" direction is already
  // covered by the test immediately above (zero operations, zero
  // checkpoints); these four cover the remaining directions the mutated-key
  // selector must get right.

  test('the re-read fires when the structure pass MUTATES a field key: the remote seam is called twice, and the options pass plan reflects the second snapshot\'s contents', () => {
    let callCount = 0;
    const remoteCalls = [];
    const optionsPassSawMaybe = [];
    routeGithubSyncCommandRouter({
      args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
      error: (message) => { throw new Error(message); },
      _isCapabilityActive: () => true,
      _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
      _desired: { readDesiredState: () => ({ available: true }) },
      _bootstrapConfig: bootstrapConfigStub(TARGET),
      _bootstrapRemote: {
        readBootstrapRemoteState() {
          callCount += 1;
          remoteCalls.push(callCount);
          const options = callCount === 1 ? [] : [{ id: 'id-maybe', name: 'Maybe', color: 'PURPLE', description: '' }];
          return { available: true, projectOutcome: 'resolved', statusField: null, fields: [{ id: 'F_auto', name: 'Autonomous', dataType: 'SINGLE_SELECT', options }] };
        },
      },
      _bootstrapPlan: {
        BOOTSTRAP_PASS: { STRUCTURE: 'structure', OPTIONS: 'options' },
        planBootstrap(input, { pass }) {
          if (pass === 'structure') {
            return { operations: [{ logicalKey: 'field:autonomous' }], noops: [], blocked: [], uncertain: [], checkpoints: [] };
          }
          const autoField = (input.remote.fields || []).find((f) => f.name === 'Autonomous');
          const hasMaybe = !!autoField && (autoField.options || []).some((o) => o.name === 'Maybe');
          optionsPassSawMaybe.push(hasMaybe);
          return { operations: [], noops: [], blocked: [], uncertain: [], checkpoints: [] };
        },
      },
      _apply: {
        applyMutationPlan(plan) {
          if (plan.operations.some((o) => o.logicalKey === 'field:autonomous')) {
            return {
              kind: 'completed',
              map: { version: '1', repository: { owner: 'octo', repo: 'repo', number: 1 }, completions: {} },
              outcomes: [{ logicalKey: 'field:autonomous', operationKey: 'field:autonomous', action: 'create', result: 'confirmed' }],
            };
          }
          return { kind: 'completed', map: { version: '1', repository: { owner: 'octo', repo: 'repo', number: 1 }, completions: {} }, outcomes: [] };
        },
      },
    });
    assert.deepEqual(remoteCalls, [1, 2]);
    assert.deepEqual(optionsPassSawMaybe, [true], 'the options pass must have been planned from the SECOND (re-read) snapshot, which carries Maybe');
  });

  test('the re-read does NOT fire on an adopt-only structure pass — six field checkpoints and a project checkpoint, zero mutations: the remote seam is called exactly once (the selector gate: checkpointedKeys would get this wrong, mutatedKeys gets it right)', () => {
    const remoteCalls = [];
    routeGithubSyncCommandRouter({
      args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
      error: (message) => { throw new Error(message); },
      _isCapabilityActive: () => true,
      _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
      _desired: { readDesiredState: () => ({ available: true }) },
      _bootstrapConfig: bootstrapConfigStub(TARGET),
      _bootstrapRemote: { readBootstrapRemoteState: (options) => { remoteCalls.push(options.projectNumber); return { available: true, projectOutcome: 'resolved', statusField: null }; } },
      _bootstrapPlan: {
        BOOTSTRAP_PASS: { STRUCTURE: 'structure', OPTIONS: 'options' },
        planBootstrap(_input, { pass }) {
          if (pass !== 'structure') return { operations: [], noops: [], blocked: [], uncertain: [], checkpoints: [] };
          const context = { owner: 'octo', repo: 'repo', repositoryNumber: 1 };
          const fieldKeys = ['field:gsd-id', 'field:phase', 'field:requirements', 'field:wave', 'field:autonomous', 'field:status'];
          return {
            operations: [], noops: [], blocked: [], uncertain: [],
            checkpoints: [
              { logicalKey: 'project', nodeId: 'PVT_1', completionContext: context },
              ...fieldKeys.map((key) => ({ logicalKey: key, nodeId: `NODE_${key}`, completionContext: context })),
            ],
          };
        },
      },
      _apply: {
        applyMutationPlan(plan, options) {
          if (plan.checkpoints.length > 0) {
            return {
              kind: 'completed',
              map: { version: '1', repository: { owner: 'octo', repo: 'repo', number: 1 }, completions: {} },
              // Every checkpoint folds to an observe/confirmed outcome, matching
              // the real applier's own behavior (github-sync-apply.cts) — never
              // action: 'create' or 'update', because nothing was mutated.
              outcomes: plan.checkpoints.map((c) => ({ logicalKey: c.logicalKey, operationKey: null, action: 'observe', result: 'confirmed' })),
            };
          }
          return { kind: 'completed', map: options.map, outcomes: [] };
        },
      },
    });
    assert.deepEqual(remoteCalls, [7]);
  });

  test('a structure pass that mutates only a label key also calls the remote seam exactly once — labels do not change the field/option surface', () => {
    const remoteCalls = [];
    routeGithubSyncCommandRouter({
      args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
      error: (message) => { throw new Error(message); },
      _isCapabilityActive: () => true,
      _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
      _desired: { readDesiredState: () => ({ available: true }) },
      _bootstrapConfig: bootstrapConfigStub(TARGET),
      _bootstrapRemote: { readBootstrapRemoteState: (options) => { remoteCalls.push(options.projectNumber); return { available: true, projectOutcome: 'resolved', statusField: null }; } },
      _bootstrapPlan: {
        BOOTSTRAP_PASS: { STRUCTURE: 'structure', OPTIONS: 'options' },
        planBootstrap(_input, { pass }) {
          if (pass !== 'structure') return { operations: [], noops: [], blocked: [], uncertain: [], checkpoints: [] };
          return { operations: [{ logicalKey: 'label:gsd-phase' }], noops: [], blocked: [], uncertain: [], checkpoints: [] };
        },
      },
      _apply: {
        applyMutationPlan(plan, options) {
          if (plan.operations.some((o) => o.logicalKey === 'label:gsd-phase')) {
            return {
              kind: 'completed',
              map: { version: '1', repository: { owner: 'octo', repo: 'repo', number: 1 }, completions: {} },
              outcomes: [{ logicalKey: 'label:gsd-phase', operationKey: 'label:gsd-phase', action: 'create', result: 'confirmed' }],
            };
          }
          return { kind: 'completed', map: options.map, outcomes: [] };
        },
      },
    });
    assert.deepEqual(remoteCalls, [7]);
  });

  // ─── plan 03-03: target_unavailable when resolveTarget cannot resolve ─────

  test('an unresolvable target (resolveTarget returns null) produces the target_unavailable blocked reason', () => {
    const chunks = [];
    mock.method(fs, 'writeSync', (_fd, chunk) => { chunks.push(String(chunk)); return Buffer.byteLength(String(chunk)); });
    process.exitCode = 0;
    try {
      routeGithubSyncCommandRouter({
        args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
        error: (message) => { throw new Error(message); },
        _isCapabilityActive: () => true,
        _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
        _desired: { readDesiredState: () => ({ available: true }) },
        _bootstrapConfig: {
          resolveTarget: () => ({ target: null, reason: RESOLVE_TARGET_REASON.UNRESOLVABLE, strictMapRead: null }),
          readProjectTitle: () => null,
          readViewLayout: () => 'BOARD_LAYOUT',
          writeProjectNumber: () => ({ ok: true, reason: 'written' }),
          RESOLVE_TARGET_REASON,
        },
      });
    } finally { mock.restoreAll(); }
    assert.equal(process.exitCode, 0);
    const parsed = JSON.parse(chunks.join(''));
    assert.equal(parsed.outcome.kind, 'blocked');
    assert.equal(parsed.outcome.reason, 'target_unavailable');
  });

  // ─── plan 03-03: the projectTitle config value is threaded to planBootstrap ─

  test('the configured project title is threaded into planBootstrap\'s input for both passes', () => {
    const titles = [];
    routeGithubSyncCommandRouter({
      args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
      error: (message) => { throw new Error(message); },
      _isCapabilityActive: () => true,
      _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
      _desired: { readDesiredState: () => ({ available: true }) },
      _bootstrapConfig: bootstrapConfigStub(TARGET, { projectTitle: 'Configured Board Title' }),
      _bootstrapRemote: { readBootstrapRemoteState: () => ({ available: true, projectOutcome: 'resolved', statusField: null }) },
      _bootstrapPlan: {
        BOOTSTRAP_PASS: { STRUCTURE: 'structure', OPTIONS: 'options' },
        planBootstrap(input) {
          titles.push(input.projectTitle);
          return { operations: [], noops: [{ reason: 'nothing-to-do' }], blocked: [], uncertain: [], checkpoints: [] };
        },
      },
    });
    assert.deepEqual(titles, ['Configured Board Title', 'Configured Board Title']);
  });

  // ─── plan 06-04: the configured view.layout value is threaded to planBootstrap ─

  test('readViewLayout is called exactly once per init run', () => {
    let readViewLayoutCalls = 0;
    routeGithubSyncCommandRouter({
      args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
      error: (message) => { throw new Error(message); },
      _isCapabilityActive: () => true,
      _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
      _desired: { readDesiredState: () => ({ available: true }) },
      _bootstrapConfig: bootstrapConfigStub(TARGET, {
        readViewLayout: () => { readViewLayoutCalls += 1; return 'TABLE_LAYOUT'; },
      }),
      _bootstrapRemote: { readBootstrapRemoteState: () => ({ available: true, projectOutcome: 'resolved', statusField: null }) },
      _bootstrapPlan: {
        BOOTSTRAP_PASS: { STRUCTURE: 'structure', OPTIONS: 'options' },
        planBootstrap: () => ({ operations: [], noops: [{ reason: 'nothing-to-do' }], blocked: [], uncertain: [], checkpoints: [] }),
      },
    });
    assert.equal(readViewLayoutCalls, 1);
  });

  test('the injected viewLayout value reaches both planBootstrap calls (structure and options passes)', () => {
    const layouts = [];
    routeGithubSyncCommandRouter({
      args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
      error: (message) => { throw new Error(message); },
      _isCapabilityActive: () => true,
      _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
      _desired: { readDesiredState: () => ({ available: true }) },
      _bootstrapConfig: bootstrapConfigStub(TARGET, { viewLayout: 'TABLE_LAYOUT' }),
      _bootstrapRemote: { readBootstrapRemoteState: () => ({ available: true, projectOutcome: 'resolved', statusField: null }) },
      _bootstrapPlan: {
        BOOTSTRAP_PASS: { STRUCTURE: 'structure', OPTIONS: 'options' },
        planBootstrap(input) {
          layouts.push(input.viewLayout);
          return { operations: [], noops: [{ reason: 'nothing-to-do' }], blocked: [], uncertain: [], checkpoints: [] };
        },
      },
    });
    assert.deepEqual(layouts, ['TABLE_LAYOUT', 'TABLE_LAYOUT']);
  });

  // ─── plan 03-03: the config write gate (D-02) ──────────────────────────────

  test('a create run (resolveTarget reason RESOLVED, structure pass confirms a project) writes the project number to config exactly once', () => {
    const writeCalls = [];
    routeGithubSyncCommandRouter({
      args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
      error: (message) => { throw new Error(message); },
      _isCapabilityActive: () => true,
      _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
      _desired: { readDesiredState: () => ({ available: true }) },
      _bootstrapConfig: bootstrapConfigStub({ owner: 'octo', repo: 'repo', repositoryNumber: 1, projectNumber: null }, {
        reason: RESOLVE_TARGET_REASON.RESOLVED,
        // IN-02: capture the full `target` argument, not just projectNumber,
        // so this test also pins the router's own baseTarget construction
        // (owner/repo/repositoryNumber from the resolved identity, no stray
        // projectNumber key) — not only the bootstrap-config unit behavior.
        writeProjectNumber: (_cwd, target, projectNumber) => { writeCalls.push({ target, projectNumber }); return { ok: true, reason: 'written' }; },
      }),
      _bootstrapRemote: { readBootstrapRemoteState: () => ({ available: true, projectOutcome: 'unset', statusField: null }) },
      _bootstrapPlan: {
        BOOTSTRAP_PASS: { STRUCTURE: 'structure', OPTIONS: 'options' },
        planBootstrap(_input, { pass }) {
          if (pass === 'structure') return { operations: [{ logicalKey: 'project' }], noops: [], blocked: [], uncertain: [], checkpoints: [] };
          return { operations: [], noops: [{ reason: 'nothing-to-do' }], blocked: [], uncertain: [], checkpoints: [] };
        },
      },
      _apply: {
        applyMutationPlan(plan, options) {
          if (plan.operations.length > 0) {
            return {
              kind: 'completed',
              map: { version: '1', repository: { owner: 'octo', repo: 'repo', number: 1 }, completions: { project: { logicalKey: 'project', nodeId: 'PVT_NEW', issueNumber: 88, completedAt: 'now', owner: 'octo', repo: 'repo', repositoryNumber: 1 } } },
              outcomes: [{ logicalKey: 'project', operationKey: 'project', action: 'create', result: 'confirmed' }],
            };
          }
          return { kind: 'completed', map: options.map, outcomes: [] };
        },
      },
    });
    assert.deepEqual(writeCalls, [
      { target: { owner: 'octo', repo: 'repo', repositoryNumber: 1 }, projectNumber: 88 },
    ]);
  });

  test('an already-configured (CONFIGURED) run records zero config writes', () => {
    const writeCalls = [];
    routeGithubSyncCommandRouter({
      args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
      error: (message) => { throw new Error(message); },
      _isCapabilityActive: () => true,
      _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
      _desired: { readDesiredState: () => ({ available: true }) },
      _bootstrapConfig: bootstrapConfigStub(TARGET, {
        writeProjectNumber: (_cwd, _target, projectNumber) => { writeCalls.push(projectNumber); return { ok: true, reason: 'written' }; },
      }),
      _bootstrapRemote: { readBootstrapRemoteState: () => ({ available: true, projectOutcome: 'resolved', statusField: null }) },
      _bootstrapPlan: {
        BOOTSTRAP_PASS: { STRUCTURE: 'structure', OPTIONS: 'options' },
        planBootstrap: () => ({ operations: [], noops: [{ reason: 'nothing-to-do' }], blocked: [], uncertain: [], checkpoints: [] }),
      },
    });
    assert.deepEqual(writeCalls, []);
  });

  test('a blocked run records zero config writes', () => {
    const writeCalls = [];
    routeGithubSyncCommandRouter({
      args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
      error: (message) => { throw new Error(message); },
      _isCapabilityActive: () => true,
      _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
      _desired: { readDesiredState: () => ({ available: true }) },
      _bootstrapConfig: bootstrapConfigStub(TARGET, {
        reason: RESOLVE_TARGET_REASON.RESOLVED,
        writeProjectNumber: (_cwd, _target, projectNumber) => { writeCalls.push(projectNumber); return { ok: true, reason: 'written' }; },
      }),
      _bootstrapRemote: { readBootstrapRemoteState: () => ({ available: true, projectOutcome: 'absent', statusField: null }) },
      _bootstrapPlan: {
        BOOTSTRAP_PASS: { STRUCTURE: 'structure', OPTIONS: 'options' },
        planBootstrap: () => ({ operations: [], noops: [], blocked: [{ reason: 'project_not_found', detail: 'not found' }], uncertain: [], checkpoints: [] }),
      },
    });
    assert.deepEqual(writeCalls, []);
  });

  test('a failing config write leaves process.exitCode at 0 and surfaces a notice on the typed result rather than throwing', () => {
    const chunks = [];
    mock.method(fs, 'writeSync', (_fd, chunk) => { chunks.push(String(chunk)); return Buffer.byteLength(String(chunk)); });
    process.exitCode = 0;
    try {
      routeGithubSyncCommandRouter({
        args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
        error: (message) => { throw new Error(message); },
        _isCapabilityActive: () => true,
        _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
        _desired: { readDesiredState: () => ({ available: true }) },
        _bootstrapConfig: bootstrapConfigStub({ owner: 'octo', repo: 'repo', repositoryNumber: 1, projectNumber: null }, {
          reason: RESOLVE_TARGET_REASON.RESOLVED,
          writeProjectNumber: () => ({ ok: false, reason: 'config_unreadable' }),
        }),
        _bootstrapRemote: { readBootstrapRemoteState: () => ({ available: true, projectOutcome: 'unset', statusField: null }) },
        _bootstrapPlan: {
          BOOTSTRAP_PASS: { STRUCTURE: 'structure', OPTIONS: 'options' },
          planBootstrap(_input, { pass }) {
            if (pass === 'structure') return { operations: [{ logicalKey: 'project' }], noops: [], blocked: [], uncertain: [], checkpoints: [] };
            return { operations: [], noops: [{ reason: 'nothing-to-do' }], blocked: [], uncertain: [], checkpoints: [] };
          },
        },
        _apply: {
          applyMutationPlan(plan, options) {
            if (plan.operations.length > 0) {
              return {
                kind: 'completed',
                map: { version: '1', repository: { owner: 'octo', repo: 'repo', number: 1 }, completions: { project: { logicalKey: 'project', nodeId: 'PVT_NEW', issueNumber: 99, completedAt: 'now', owner: 'octo', repo: 'repo', repositoryNumber: 1 } } },
                outcomes: [{ logicalKey: 'project', operationKey: 'project', action: 'create', result: 'confirmed' }],
              };
            }
            return { kind: 'completed', map: options.map, outcomes: [] };
          },
        },
      });
    } finally { mock.restoreAll(); }
    assert.equal(process.exitCode, 0);
    const parsed = JSON.parse(chunks.join(''));
    assert.equal(parsed.outcome.kind, 'completed');
    assert.equal(parsed.outcome.configWriteNotice, 'config_unreadable');
  });

  // ─── plan 03-06 Task 2: the init report — human/raw dispatch, exit-code-0 matrix, wrong-scope forwarding ──

  function captureStdout() {
    const chunks = [];
    mock.method(fs, 'writeSync', (_fd, chunk) => { chunks.push(String(chunk)); return Buffer.byteLength(String(chunk)); });
    return { chunks, restore: () => mock.restoreAll() };
  }

  test('init without the raw flag emits the human form (not JSON); with the raw flag it emits parseable JSON', () => {
    const human = captureStdout();
    try {
      routeGithubSyncCommandRouter({
        args: ['github-sync', 'init'], cwd: '/fixture', raw: false,
        error: (message) => { throw new Error(message); },
        _isCapabilityActive: () => true,
        _auth: { runPreflight: () => ({ ok: false, reason: 'outage', message: 'transient failure' }) },
      });
    } finally { human.restore(); }
    const humanOutput = human.chunks.join('');
    assert.throws(() => JSON.parse(humanOutput));
    assert.match(humanOutput, /github-sync init:/);
    assert.match(humanOutput, /outcome: blocked/);

    const machine = captureStdout();
    try {
      routeGithubSyncCommandRouter({
        args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
        error: (message) => { throw new Error(message); },
        _isCapabilityActive: () => true,
        _auth: { runPreflight: () => ({ ok: false, reason: 'outage', message: 'transient failure' }) },
      });
    } finally { machine.restore(); }
    const parsed = JSON.parse(machine.chunks.join(''));
    assert.equal(parsed.outcome.kind, 'blocked');
  });

  // No second flag alias exists in this family — the raw flag already in use
  // is the machine-readable path for init too.
  test('no --json flag literal is parsed or routed anywhere in the router', () => {
    const fs2 = require('node:fs');
    const src = fs2.readFileSync(require.resolve('../src/github-sync-command-router.cts'), 'utf8');
    const matches = (src.match(/(^|[^-])--json\b/gm) || []).filter((line) => !line.trim().startsWith('//'));
    assert.equal(matches.length, 0);
  });

  test('a preflight failing with the wrong-scope reason produces output containing the catalogued remediation, supplied through the existing _auth seam — developer variant', () => {
    const cap = captureStdout();
    try {
      routeGithubSyncCommandRouter({
        args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
        error: (message) => { throw new Error(message); },
        _isCapabilityActive: () => true,
        _auth: {
          runPreflight: () => ({
            ok: false, reason: PREFLIGHT_REASON.WRONG_SCOPE,
            message: 'github-sync preflight: your GitHub token is missing the `project` scope. Run `gh auth refresh -s project`, then re-run `gsd-tools github-sync preflight`.',
          }),
        },
      });
    } finally { cap.restore(); }
    const parsed = JSON.parse(cap.chunks.join(''));
    assert.match(parsed.outcome.remediation, /gh auth refresh -s project/);
  });

  test('a preflight failing with the wrong-scope reason produces output containing the catalogued remediation, supplied through the existing _auth seam — CI variant', () => {
    const cap = captureStdout();
    try {
      routeGithubSyncCommandRouter({
        args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
        error: (message) => { throw new Error(message); },
        _isCapabilityActive: () => true,
        _auth: {
          runPreflight: () => ({
            ok: false, reason: PREFLIGHT_REASON.WRONG_SCOPE,
            message: 'github-sync preflight: this token cannot reach GitHub Projects v2. Export a classic personal access token with the `project` scope as `GH_TOKEN` in this CI environment.',
          }),
        },
      });
    } finally { cap.restore(); }
    const parsed = JSON.parse(cap.chunks.join(''));
    assert.match(parsed.outcome.remediation, /GH_TOKEN/);
  });

  test('every failure path leaves the process exit code at 0: a blocked plan, a failed mutation, an uncertain checkpoint, a transport failure, and a failed config write', () => {
    const cases = [
      // blocked plan
      () => routeGithubSyncCommandRouter({
        args: ['github-sync', 'init'], cwd: '/fixture', raw: true, error: (m) => { throw new Error(m); },
        _isCapabilityActive: () => true,
        _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
        _desired: { readDesiredState: () => ({ available: false, reason: 'local_unavailable' }) },
        _bootstrapConfig: bootstrapConfigStub(TARGET),
        _bootstrapRemote: { readBootstrapRemoteState: () => ({ available: true, projectOutcome: 'resolved', statusField: null }) },
      }),
      // failed mutation
      () => routeGithubSyncCommandRouter({
        args: ['github-sync', 'init'], cwd: '/fixture', raw: true, error: (m) => { throw new Error(m); },
        _isCapabilityActive: () => true,
        _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
        _desired: { readDesiredState: () => ({ available: true }) },
        _bootstrapConfig: bootstrapConfigStub(TARGET),
        _bootstrapRemote: { readBootstrapRemoteState: () => ({ available: true, projectOutcome: 'resolved', statusField: null }) },
        _bootstrapPlan: {
          BOOTSTRAP_PASS: { STRUCTURE: 'structure', OPTIONS: 'options' },
          planBootstrap: () => ({ operations: [{ logicalKey: 'project' }], noops: [], blocked: [], uncertain: [], checkpoints: [] }),
        },
        _apply: { applyMutationPlan: () => ({ kind: 'failed', logicalKey: 'project', remediation: 'x', outcomes: [] }) },
      }),
      // uncertain plan
      () => routeGithubSyncCommandRouter({
        args: ['github-sync', 'init'], cwd: '/fixture', raw: true, error: (m) => { throw new Error(m); },
        _isCapabilityActive: () => true,
        _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
        _desired: { readDesiredState: () => ({ available: true }) },
        _bootstrapConfig: bootstrapConfigStub(TARGET),
        _bootstrapRemote: { readBootstrapRemoteState: () => ({ available: false, reason: 'remote_unavailable', projectOutcome: 'unavailable', statusField: null }) },
      }),
      // transport failure (preflight outage)
      () => routeGithubSyncCommandRouter({
        args: ['github-sync', 'init'], cwd: '/fixture', raw: true, error: (m) => { throw new Error(m); },
        _isCapabilityActive: () => true,
        _auth: { runPreflight: () => ({ ok: false, reason: 'outage', message: 'transient' }) },
      }),
      // failed config write (already covered above, repeated for the matrix)
      () => routeGithubSyncCommandRouter({
        args: ['github-sync', 'init'], cwd: '/fixture', raw: true, error: (m) => { throw new Error(m); },
        _isCapabilityActive: () => true,
        _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
        _desired: { readDesiredState: () => ({ available: true }) },
        _bootstrapConfig: bootstrapConfigStub({ owner: 'octo', repo: 'repo', repositoryNumber: 1, projectNumber: null }, {
          reason: RESOLVE_TARGET_REASON.RESOLVED,
          writeProjectNumber: () => ({ ok: false, reason: 'config_unreadable' }),
        }),
        _bootstrapRemote: { readBootstrapRemoteState: () => ({ available: true, projectOutcome: 'unset', statusField: null }) },
        _bootstrapPlan: {
          BOOTSTRAP_PASS: { STRUCTURE: 'structure', OPTIONS: 'options' },
          planBootstrap(_input, { pass }) {
            if (pass === 'structure') return { operations: [{ logicalKey: 'project' }], noops: [], blocked: [], uncertain: [], checkpoints: [] };
            return { operations: [], noops: [], blocked: [], uncertain: [], checkpoints: [] };
          },
        },
        _apply: {
          applyMutationPlan(plan, options) {
            if (plan.operations.length > 0) {
              return {
                kind: 'completed',
                map: { version: '1', repository: { owner: 'octo', repo: 'repo', number: 1 }, completions: { project: { logicalKey: 'project', nodeId: 'PVT_X', issueNumber: 5, completedAt: 'now', owner: 'octo', repo: 'repo', repositoryNumber: 1 } } },
                outcomes: [{ logicalKey: 'project', operationKey: 'project', action: 'create', result: 'confirmed' }],
              };
            }
            return { kind: 'completed', map: options.map, outcomes: [] };
          },
        },
      }),
    ];
    for (const runCase of cases) {
      process.exitCode = 0;
      const cap = captureStdout();
      try { runCase(); } finally { cap.restore(); }
      assert.equal(process.exitCode, 0);
    }
  });

  test('the pre-existing sync preflight test path is unaffected: sync still collapses a preflight failure to preflight_unavailable', () => {
    const cap = captureStdout();
    try {
      routeGithubSyncCommandRouter({
        args: ['github-sync', 'sync'], cwd: '/fixture', raw: true,
        error: (message) => { throw new Error(message); },
        _isCapabilityActive: () => true,
        _auth: { runPreflight: () => ({ ok: false, reason: PREFLIGHT_REASON.WRONG_SCOPE, message: 'x' }) },
      });
    } finally { cap.restore(); }
    const parsed = JSON.parse(cap.chunks.join(''));
    assert.equal(parsed.kind, 'blocked');
    assert.equal(parsed.reason, 'preflight_unavailable');
  });

  // ─── 06-07 gap closure (CR-01): the options-pass apply gate must read only
  // run-fatal blocked entries, never the bare array length — a per-view
  // VIEW_FIELD_UNRESOLVED skip must not discard the Status merge, the
  // Autonomous merge, or the other views that resolved cleanly. These tests
  // drive the REAL bootstrapPlan module (no `_bootstrapPlan` stub) —
  // stubbing it is exactly why the pre-existing blocked-outcome tests above
  // could not observe this defect (06-REVIEW.md CR-01).

  describe('github-sync router: init options-pass dispatch on a per-item view skip (06-07 gap closure, CR-01)', () => {
    /**
     * A resolved, linked project whose fields cover every GSD field except
     * `Wave` (so `planFields`' structure-pass create for Wave, and
     * `planViews`' By-Wave visible-field resolution, both exercise real
     * code) and whose Status/Autonomous options are each one short of GSD's
     * declared set (so both merges genuinely dispatch, not merely
     * checkpoint). `waveDataType` set makes Wave present-but-wrong-typed
     * instead of absent, driving the run-fatal FIELD_TYPE_MISMATCH case.
     */
    function crRemote({ waveDataType } = {}) {
      const statusFieldValue = { id: 'F_status', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'id-todo', name: 'Todo', color: 'GRAY', description: '' }] };
      const fields = [
        { id: 'F_id', name: 'GSD ID', dataType: 'TEXT', options: null },
        { id: 'F_phase', name: 'Phase', dataType: 'TEXT', options: null },
        { id: 'F_req', name: 'Requirements', dataType: 'TEXT', options: null },
        { id: 'F_auto', name: 'Autonomous', dataType: 'SINGLE_SELECT', options: [{ id: 'id-yes', name: 'Yes', color: 'GREEN', description: '' }] },
        statusFieldValue,
      ];
      if (waveDataType) fields.push({ id: 'F_wave', name: 'Wave', dataType: waveDataType, options: null });
      return {
        available: true, projectOutcome: 'resolved',
        repository: { nodeId: 'R_1', ownerNodeId: 'O_1', ownerLogin: 'octo', linkState: 'linked' },
        projectNodeId: 'PVT_1',
        statusField: statusFieldValue,
        fields,
        labels: [], milestones: [], views: [],
      };
    }

    function recordingApply() {
      const calls = [];
      return {
        calls,
        applyMutationPlan(plan, options) {
          calls.push(plan);
          return { kind: 'completed', map: options.map ?? null, outcomes: [] };
        },
      };
    }

    test('CR-01 regression: a run whose only blocked-class entry is VIEW_FIELD_UNRESOLVED (Wave missing) still dispatches the Status merge, the Autonomous merge, and the four cleanly-resolved views', () => {
      process.exitCode = 0;
      const apply = recordingApply();
      const cap = captureStdout();
      try {
        routeGithubSyncCommandRouter({
          args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
          error: (message) => { throw new Error(message); },
          _isCapabilityActive: () => true,
          _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
          _desired: { readDesiredState: () => ({ available: true }) },
          _bootstrapConfig: bootstrapConfigStub(TARGET),
          _bootstrapRemote: { readBootstrapRemoteState: () => crRemote() }, // Wave absent
          _apply: apply,
        });
      } finally { cap.restore(); }

      assert.equal(apply.calls.length, 2, 'applyMutationPlan must be called once per pass');
      const optionsCall = apply.calls[1];
      assert.ok(optionsCall.operations.length > 0);
      assert.ok(optionsCall.operations.some((o) => o.logicalKey === 'field:status'), 'the Status option merge must dispatch');
      assert.ok(optionsCall.operations.some((o) => o.logicalKey === 'field:autonomous'), 'the Autonomous option merge must dispatch');
      for (const key of ['view:roadmap', 'view:board', 'view:table-by-phase', 'view:backlog']) {
        assert.ok(optionsCall.operations.some((o) => o.logicalKey === key), `${key} must dispatch`);
      }
      assert.ok(!optionsCall.operations.some((o) => o.logicalKey === 'view:by-wave'), 'view:by-wave must not dispatch — its visible field is unresolved');

      const parsed = JSON.parse(cap.chunks.join(''));
      assert.equal(parsed.outcome.kind, 'completed');
    });

    test('exit posture: the CR-01 scenario leaves process.exitCode at 0', () => {
      process.exitCode = 0;
      const apply = recordingApply();
      const cap = captureStdout();
      try {
        routeGithubSyncCommandRouter({
          args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
          error: (message) => { throw new Error(message); },
          _isCapabilityActive: () => true,
          _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
          _desired: { readDesiredState: () => ({ available: true }) },
          _bootstrapConfig: bootstrapConfigStub(TARGET),
          _bootstrapRemote: { readBootstrapRemoteState: () => crRemote() },
          _apply: apply,
        });
      } finally { cap.restore(); }
      assert.equal(process.exitCode, 0);
    });

    test('a genuinely run-fatal blocked reason (field_type_mismatch) still aborts before either pass reaches apply: zero applyMutationPlan calls, a blocked outcome', () => {
      process.exitCode = 0;
      const apply = recordingApply();
      const cap = captureStdout();
      try {
        routeGithubSyncCommandRouter({
          args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
          error: (message) => { throw new Error(message); },
          _isCapabilityActive: () => true,
          _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
          _desired: { readDesiredState: () => ({ available: true }) },
          _bootstrapConfig: bootstrapConfigStub(TARGET),
          _bootstrapRemote: { readBootstrapRemoteState: () => crRemote({ waveDataType: 'TEXT' }) }, // Wave present, wrong type
          _apply: apply,
        });
      } finally { cap.restore(); }

      assert.equal(apply.calls.length, 0, 'a run-fatal condition suppresses both passes before either reaches apply');
      assert.equal(process.exitCode, 0);
      const parsed = JSON.parse(cap.chunks.join(''));
      assert.equal(parsed.outcome.kind, 'blocked');
      assert.equal(parsed.outcome.reason, 'field_type_mismatch');
    });

    test('fail-closed seam: an injected _bootstrapPlan that omits isRunFatalBlockedReason is treated as run-fatal on any blocked entry — the options-pass apply is skipped, matching every pre-existing router test above', () => {
      process.exitCode = 0;
      const apply = recordingApply();
      const cap = captureStdout();
      try {
        routeGithubSyncCommandRouter({
          args: ['github-sync', 'init'], cwd: '/fixture', raw: true,
          error: (message) => { throw new Error(message); },
          _isCapabilityActive: () => true,
          _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
          _desired: { readDesiredState: () => ({ available: true }) },
          _bootstrapConfig: bootstrapConfigStub(TARGET),
          _bootstrapRemote: { readBootstrapRemoteState: () => ({ available: true, projectOutcome: 'resolved', statusField: null }) },
          _bootstrapPlan: {
            // Deliberately no isRunFatalBlockedReason — a legacy/injected
            // seam that predates this predicate.
            BOOTSTRAP_PASS: { STRUCTURE: 'structure', OPTIONS: 'options' },
            planBootstrap(_input, { pass }) {
              if (pass === 'structure') return { operations: [], noops: [], blocked: [], uncertain: [], checkpoints: [] };
              return {
                operations: [{ logicalKey: 'view:backlog', args: [], kind: 'create-view' }],
                noops: [], blocked: [{ reason: 'view_field_unresolved', detail: 'view "By-Wave" needs field "Wave"' }], uncertain: [], checkpoints: [],
              };
            },
          },
          _apply: apply,
        });
      } finally { cap.restore(); }

      assert.equal(apply.calls.length, 1, 'only the structure pass reaches apply; the options pass is skipped by the fail-closed fallback');
      assert.equal(process.exitCode, 0);
      const parsed = JSON.parse(cap.chunks.join(''));
      assert.equal(parsed.outcome.kind, 'blocked');
    });
  });
});

// ─── Plan 07-01 (D-01/D-05/D-08/D-09): existence classification and the
// rebuild delegation — `sync` only, wired between the strictMap/remoteSnapshot
// reads and `planReconciliation`. Uses the REAL github-sync-map module for
// `recordCompletion`/`mergeCompletion` (never a hand-rolled stand-in) so the
// wholesale-replace trap (D-08's own warning) would actually be exercised. ──

describe('github-sync router: plan 07-01 — existence classification and rebuild delegation', () => {
  const realMap = require('../gsd-core/bin/lib/github-sync-map.cjs');
  const TARGET = { owner: 'octo', repo: 'repo', repositoryNumber: 1, projectNumber: 7 };
  const T0 = '2026-08-01T00:00:00.000Z';
  const T0_PLUS_60S = '2026-08-01T00:01:00.000Z';

  function baseProjectCompletion(overrides = {}) {
    return {
      logicalKey: 'project',
      nodeId: 'PVT_OLD',
      completedAt: '2026-07-01T00:00:00.000Z',
      owner: TARGET.owner,
      repo: TARGET.repo,
      repositoryNumber: TARGET.repositoryNumber,
      ...overrides,
    };
  }

  /** Wraps the real map module's pure functions with call-tracking read/write seams. */
  function makeMapSeam(initialMap) {
    let stored = initialMap;
    const writeCalls = [];
    return {
      seam: {
        readSyncMapStrict: () => ({ kind: 'valid', map: stored }),
        recordCompletion: (current, completion) => realMap.recordCompletion(current, completion),
        mergeCompletion: (previous, next, options) => realMap.mergeCompletion(previous, next, options),
        writeSyncMapAtomically: (cwd, map) => { writeCalls.push(map); stored = map; },
      },
      writeCalls,
      current: () => stored,
    };
  }

  function captureStdout() {
    const chunks = [];
    mock.method(fs, 'writeSync', (_fd, chunk) => { chunks.push(String(chunk)); return Buffer.byteLength(String(chunk)); });
    return { chunks, restore: () => mock.restoreAll() };
  }

  test('a first confirmed absence records absenceCount 1 + absenceFirstSeenAt, dispatches ZERO bootstrap operations, and still reaches reconciliation', () => {
    const mapSeam = makeMapSeam(realMap.recordCompletion(null, baseProjectCompletion()));
    const bootstrapPlanCalls = [];
    const applyCalls = [];
    const remoteCalls = [];
    const cap = captureStdout();
    try {
      routeGithubSyncCommandRouter({
        args: ['github-sync', 'sync'], cwd: '/fixture', raw: true,
        error: (message) => { throw new Error(message); },
        _isCapabilityActive: () => true,
        _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
        _desired: { readDesiredState: () => ({ available: true }) },
        _target: { readSyncTarget: () => ({ available: true, target: TARGET }) },
        _map: mapSeam.seam,
        _remote: {
          readRemoteSnapshot: (options) => { remoteCalls.push(options); return { available: true }; },
        },
        _bootstrapRemote: {
          readBootstrapRemoteState: () => ({ available: true, projectOutcome: 'absent' }),
        },
        _bootstrapPlan: {
          BOOTSTRAP_PASS: { STRUCTURE: 'structure', OPTIONS: 'options' },
          planBootstrap: (input, options) => { bootstrapPlanCalls.push(options.pass); return { operations: [], noops: [], blocked: [], uncertain: [], checkpoints: [] }; },
        },
        _bootstrapConfig: { readProjectTitle: () => null, readViewLayout: () => 'BOARD_LAYOUT' },
        _reconcile: { planReconciliation: () => ({ operations: [{ logicalKey: 'phase:01' }], noops: [], blocked: [], uncertain: [], pendingIssueUpdates: [] }) },
        _issueUpdate: { prepareIssueUpdates: () => ({ operations: [], reports: [] }) },
        _apply: { applyMutationPlan: (plan) => { applyCalls.push((plan.operations[0] || {}).logicalKey ?? null); return { kind: 'completed', outcomes: [] }; } },
        _clock: { now: () => 0, nowIso: () => T0, sleep: () => {} },
      });
    } finally { cap.restore(); }

    assert.deepEqual(bootstrapPlanCalls, [], 'first confirmed absence must dispatch zero bootstrap operations');
    assert.deepEqual(applyCalls, ['phase:01'], 'only the reconciliation apply runs');
    assert.equal(remoteCalls.length, 1, 'no post-rebuild re-read on a non-triggering run');

    assert.equal(mapSeam.writeCalls.length, 1);
    const written = mapSeam.writeCalls[0];
    assert.equal(written.completions.project.absenceCount, 1);
    assert.equal(written.completions.project.absenceFirstSeenAt, T0);
    // D-08's wholesale-replace trap: the pre-existing nodeId must survive the merge.
    assert.equal(written.completions.project.nodeId, 'PVT_OLD');

    assert.equal(process.exitCode, 0);
  });

  test('a second confirmed absence past the 60000ms gate runs BOTH planBootstrap passes and then planReconciliation, in that order, inside one invocation', () => {
    const mapSeam = makeMapSeam(realMap.recordCompletion(null, baseProjectCompletion({ absenceCount: 1, absenceFirstSeenAt: T0 })));
    const bootstrapPlanCalls = [];
    const applyCalls = [];
    const remoteCalls = [];
    const bootstrapRemoteCalls = [];
    const cap = captureStdout();
    try {
      routeGithubSyncCommandRouter({
        args: ['github-sync', 'sync'], cwd: '/fixture', raw: true,
        error: (message) => { throw new Error(message); },
        _isCapabilityActive: () => true,
        _auth: { runPreflight: () => ({ ok: true, reason: 'ok', message: 'ok' }) },
        _desired: { readDesiredState: () => ({ available: true }) },
        _target: { readSyncTarget: () => ({ available: true, target: TARGET }) },
        _map: mapSeam.seam,
        _remote: {
          readRemoteSnapshot: (options) => { remoteCalls.push(options); return { available: true }; },
        },
        _bootstrapRemote: {
          readBootstrapRemoteState: (options) => { bootstrapRemoteCalls.push(options); return { available: true, projectOutcome: 'absent' }; },
        },
        _bootstrapPlan: {
          BOOTSTRAP_PASS: { STRUCTURE: 'structure', OPTIONS: 'options' },
          planBootstrap: (input, options) => {
            bootstrapPlanCalls.push(options.pass);
            if (options.pass === 'structure') {
              return { operations: [{ logicalKey: 'project' }], noops: [], blocked: [], uncertain: [], checkpoints: [] };
            }
            return { operations: [{ logicalKey: 'option:status:todo' }], noops: [], blocked: [], uncertain: [], checkpoints: [] };
          },
        },
        _bootstrapConfig: { readProjectTitle: () => null, readViewLayout: () => 'BOARD_LAYOUT' },
        _reconcile: { planReconciliation: () => ({ operations: [{ logicalKey: 'phase:01' }], noops: [], blocked: [], uncertain: [], pendingIssueUpdates: [] }) },
        _issueUpdate: { prepareIssueUpdates: () => ({ operations: [], reports: [] }) },
        _apply: {
          applyMutationPlan: (plan) => {
            const tag = (plan.operations[0] || {}).logicalKey ?? null;
            applyCalls.push(tag);
            if (tag === 'project') {
              return {
                kind: 'completed',
                outcomes: [{ logicalKey: 'project', operationKey: 'project', action: 'create', result: 'confirmed' }],
                map: { version: '1', repository: TARGET, completions: { project: baseProjectCompletion({ nodeId: 'PVT_NEW', absenceCount: 2, absenceFirstSeenAt: T0 }) } },
              };
            }
            return { kind: 'completed', outcomes: [] };
          },
        },
        _clock: { now: () => 60000, nowIso: () => T0_PLUS_60S, sleep: () => {} },
      });
    } finally { cap.restore(); }

    assert.deepEqual(bootstrapPlanCalls, ['structure', 'options'], 'both planBootstrap passes run, structure before options');
    assert.deepEqual(applyCalls, ['project', 'option:status:todo', 'phase:01'], 'the bootstrap structure apply, then the options apply, then reconciliation — in that order, one invocation');
    assert.ok(bootstrapRemoteCalls.length >= 1, 'the bootstrap remote read backing the classification ran');
    assert.equal(remoteCalls.length, 2, 'the post-rebuild snapshot is re-read before reconciliation plans against it');

    assert.equal(mapSeam.writeCalls.length, 1, 'the absence marker write happens exactly once, before the rebuild delegation');
    assert.equal(mapSeam.writeCalls[0].completions.project.absenceCount, 2);

    assert.equal(process.exitCode, 0);
  });

  // ─── Plan 07-01 Task 2 (T-07-04, SAFE-03): status must stay a dry run —
  // pins the property RESEARCH.md Pitfall 6 identified as implicit: the
  // absence counter advances only on `sync`, never on `status`. ───────────

  test('T-07-04: three consecutive status invocations against a confirmed-absent project never write the sync map and never dispatch a bootstrap operation', () => {
    const initialMap = realMap.recordCompletion(null, baseProjectCompletion());
    let writeCalls = 0;
    const bootstrapCalls = [];
    const cap = captureStdout();
    try {
      for (let i = 0; i < 3; i += 1) {
        routeGithubSyncCommandRouter({
          args: ['github-sync', 'status'], cwd: '/fixture', raw: true,
          error: (message) => { throw new Error(message); },
          _isCapabilityActive: () => true,
          _target: { readSyncTarget: () => ({ available: true, target: TARGET }) },
          _desired: { readDesiredState: () => ({ available: true }) },
          _remote: { readRemoteSnapshot: () => ({ available: true }) },
          _map: {
            readSyncMapStrict: () => ({ kind: 'valid', map: initialMap }),
            writeSyncMapAtomically: () => { writeCalls += 1; },
          },
          _bootstrapRemote: { readBootstrapRemoteState: () => { bootstrapCalls.push(1); return { available: true, projectOutcome: 'absent' }; } },
          _reconcile: { planReconciliation: () => ({ operations: [], noops: [], blocked: [], uncertain: [] }) },
          _status: { buildStatusV1: (remote, plan) => ({ version: 1, available: remote.available, operations: plan.operations.length }), renderStatusV1: (dto) => JSON.stringify(dto) },
        });
      }
    } finally { cap.restore(); }

    assert.equal(writeCalls, 0, 'status must never write the sync map');
    assert.deepEqual(bootstrapCalls, [], 'status never runs bootstrap-remote reads — it has no classification path at all');
    assert.deepEqual(initialMap.completions.project, baseProjectCompletion(), 'the map object itself is untouched across three status invocations — sync-map file equality, not merely no error thrown');
  });
});
