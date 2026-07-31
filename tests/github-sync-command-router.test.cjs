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

const { routeGithubSyncCommandRouter } = require('../gsd-core/bin/lib/github-sync-command-router.cjs');
const { PREFLIGHT_REASON } = require('../gsd-core/bin/lib/github-sync-auth.cjs');

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
      _map: { readSyncMapStrict(cwd, repository) { calls.push(['map', cwd, repository]); return { kind: 'absent' }; }, writeSyncMapAtomically() { throw new Error('status must not write map'); } },
      _reconcile: { planReconciliation(...inputs) { calls.push(['reconcile', inputs.length]); return { operations: [], noops: [], blocked: [], uncertain: [] }; } },
      _status: { buildStatusV1(remote, plan) { calls.push(['status', remote.available, plan.operations.length]); return { version: 1, available: true }; }, renderStatusV1(dto) { return JSON.stringify(dto); } },
    });
  } finally {
    mock.restoreAll();
  }
  assert.deepEqual(calls, [['desired', '/fixture'], ['target', '/fixture'], ['remote', { cwd: '/fixture', owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 7 }], ['map', '/fixture', { owner: 'octo', repo: 'example', number: 42 }], ['reconcile', 3], ['status', true, 0]]);
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
          readSyncMapStrict(cwd, repository) { calls.push(['map', available, cwd, repository]); return { kind: 'absent' }; },
          writeSyncMapAtomically() { throw new Error('status must never persist a map'); },
        },
        _reconcile: { planReconciliation() { calls.push(['reconcile', available]); return { operations: [], noops: [], blocked: [], uncertain: [] }; } },
        _status: { buildStatusV1(remote, plan) { calls.push(['status', available, remote.available, plan]); return { version: 1, available: remote.available }; }, renderStatusV1(dto) { return JSON.stringify(dto); } },
        _apply: { applyMutationPlan() { throw new Error('status must never apply mutations'); } },
      });
    }
  } finally { mock.restoreAll(); }
  assert.deepEqual(calls, [
    ['remote', true, { cwd: '/fixture', owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 7 }],
    ['map', true, '/fixture', { owner: 'octo', repo: 'example', number: 42 }],
    ['reconcile', true], ['status', true, true, { operations: [], noops: [], blocked: [], uncertain: [] }],
    ['remote', false, { cwd: '/fixture', owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 7 }],
    ['map', false, '/fixture', { owner: 'octo', repo: 'example', number: 42 }],
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
      _map: { readSyncMapStrict(cwd, repository) { calls.push(['map', cwd, repository]); return { kind: 'absent' }; } },
      _reconcile: { planReconciliation(...inputs) { calls.push(['reconcile', inputs.length]); return { operations: [{ logicalKey: 'phase:01' }], noops: [], blocked: [], uncertain: [] }; } },
      _apply: { applyMutationPlan(plan, options) { calls.push(['apply', plan.operations[0].logicalKey, options.map]); return { kind: 'completed' }; } },
    });
  } finally { mock.restoreAll(); }
  assert.deepEqual(calls, [['preflight', '/fixture'], ['desired', '/fixture'], ['target', '/fixture'], ['remote', { cwd: '/fixture', owner: 'octo', repo: 'example', repositoryNumber: 42, projectNumber: 7 }], ['map', '/fixture', { owner: 'octo', repo: 'example', number: 42 }], ['reconcile', 3], ['apply', 'phase:01', null]]);
  assert.deepEqual(chunks, ['{\n  "kind": "completed"\n}']);
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
