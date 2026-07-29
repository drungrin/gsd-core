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
 * zero calls on both and an identical stderr message across every case.
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
const { spawnSync } = require('node:child_process');

const { createTempProject, cleanup, TOOLS_PATH } = require('./helpers.cjs');

const { routeGithubSyncCommandRouter } = require('../gsd-core/bin/lib/github-sync-command-router.cjs');

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
 * runGsdTools() discards stderr on a zero-exit process, and the whole point
 * of the disabled-path subprocess case is asserting on the non-empty stderr
 * that accompanies exit 0 (mirrors tests/github-sync-preflight-e2e.test.cjs).
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

  test('all seven subcommand strings: identical stderr, zero spawns, zero fs writes, exit stays 0', () => {
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

    const messagesPerCase = [];

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
      assert.strictEqual(stderrChunks.length, 1, `${label}: exactly one stderr write; got: ${JSON.stringify(stderrChunks)}`);
      messagesPerCase.push({ label, message: stderrChunks[0] });
    }

    assert.strictEqual(spawnCalls.length, 0,
      `spawnSync must never be called across all seven disabled cases; got ${spawnCalls.length} call(s)`);
    assert.strictEqual(fsWriteCalls.length, 0,
      `no filesystem write must occur across all seven disabled cases; got: ${JSON.stringify(fsWriteCalls)}`);

    const [{ label: firstLabel, message: firstMessage }] = messagesPerCase;
    for (const { label, message } of messagesPerCase) {
      assert.strictEqual(message, firstMessage,
        `${label}: disabled stderr message must be byte-identical to the "${firstLabel}" case; got: ${message}`);
    }

    assert.ok(firstMessage.includes('github_sync.enabled'),
      `disabled message must name github_sync.enabled; got: ${firstMessage}`);
    assert.ok(firstMessage.includes('.planning/config.json'),
      `disabled message must name .planning/config.json; got: ${firstMessage}`);
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

  test('disabled (key omitted entirely): "github-sync init" exits 0, non-empty stderr, zero filesystem writes', () => {
    const before = listFilesRecursive(tmpDir);
    const result = runGithubSync(['github-sync', 'init'], tmpDir);

    assert.strictEqual(result.status, 0, `expected exit 0; stderr: ${result.stderr}`);
    assert.ok(result.stderr.length > 0, `stderr must be non-empty; got: "${result.stderr}"`);

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

// ─── 3. SAFE-02 — every declared contribution carries onError: skip ─────────

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
