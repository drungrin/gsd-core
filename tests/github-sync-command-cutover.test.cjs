'use strict';

/**
 * github-sync-command-cutover.test.cjs — CAP-04 registry-dispatch equivalence
 * proof (Phase 1, plan 01-03). Modeled directly on
 * tests/graphify-command-cutover.test.cjs's REGISTRY/DISPATCH/JSON-ERRORS
 * shape, narrowed to what plan 01-03 actually asserts.
 *
 * Test categories:
 *   1. REGISTRY            — commandFamilies + configSchema entries for github-sync
 *   2. DISPATCH             — the family reaches the router via the generic
 *                              default-case registry path (real subprocess run)
 *   3. NO-HARDCODED-BRANCH   — gsd-tools.cjs carries no case label / router
 *                              require for this family (read from disk, inside
 *                              the suite — not a shell grep)
 *   4. ERROR PATHS           — GSD_JSON_ERRORS structured error shape for an
 *                              unregistered subcommand
 *
 * Deliberately does NOT assert on bySkill or capabilityClusters — plan 01-04
 * populates the manifest's `skills` array, so an assertion pinned to the
 * current empty-skills registry would go red the moment that plan lands.
 * Those two views are covered by tests/github-sync-collision.test.cjs instead.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const registry = require('../gsd-core/bin/lib/capability-registry.cjs');

// ─── helpers ────────────────────────────────────────────────────────────────

function runJsonErrors(args, tmpDir, env = {}) {
  const result = runGsdTools(args, tmpDir, { ...env, GSD_JSON_ERRORS: '1' });
  assert.strictEqual(result.success, false,
    `Expected failure with GSD_JSON_ERRORS=1 for args: ${args.join(' ')}\n` +
    `stdout: ${result.output}\nstderr: ${result.error}`);
  let parsed;
  try {
    parsed = JSON.parse(result.error);
  } catch (e) {
    throw new Error(
      `GSD_JSON_ERRORS=1 must emit valid JSON on stderr.\n` +
      `Args: ${args.join(' ')}\nstderr: ${result.error}\nparse error: ${e.message}`,
    );
  }
  return parsed;
}

function assertTypedError(parsed, expectedReason, label) {
  assert.strictEqual(parsed.ok, false, `${label}: error object must have ok: false`);
  assert.strictEqual(parsed.reason, expectedReason,
    `${label}: reason must be "${expectedReason}", got: ${parsed.reason}`);
  assert.ok(typeof parsed.message === 'string' && parsed.message.length > 0,
    `${label}: message must be a non-empty string`);
}

function enableGithubSync(planningDir) {
  const configPath = path.join(planningDir, 'config.json');
  const config = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
    : {};
  config.github_sync = { enabled: true };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * PATH containing only a fresh empty directory plus the running node binary's
 * directory. Guarantees `gh` cannot be found regardless of whether the host
 * machine has a real `gh` installed — makes the DISPATCH case deterministic
 * (no network, no token, no dependence on developer-machine state), mirroring
 * tests/github-sync-preflight-e2e.test.cjs's noGhPath() helper.
 */
function noGhPath() {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-no-gh-'));
  return `${emptyDir}${path.delimiter}${path.dirname(process.execPath)}`;
}

// ─── 1. REGISTRY ─────────────────────────────────────────────────────────────

describe('github-sync cutover: registry entries correct', () => {
  test('commandFamilies["github-sync"] entry present and well-shaped', () => {
    const entry = registry.commandFamilies['github-sync'];
    assert.ok(entry, 'commandFamilies["github-sync"] must be present');
    assert.strictEqual(entry.capId, 'github-sync',
      'commandFamilies["github-sync"].capId must be "github-sync"');
    assert.strictEqual(entry.module, 'github-sync-command-router.cjs',
      'commandFamilies["github-sync"].module must be "github-sync-command-router.cjs"');
    assert.strictEqual(entry.router, 'routeGithubSyncCommandRouter',
      'commandFamilies["github-sync"].router must be "routeGithubSyncCommandRouter"');
  });

  test('configSchema["github_sync.enabled"] entry present, owner github-sync, default false', () => {
    const entry = registry.configSchema['github_sync.enabled'];
    assert.ok(entry, 'configSchema["github_sync.enabled"] must be present');
    assert.strictEqual(entry.owner, 'github-sync', 'configSchema owner must be "github-sync"');
    assert.strictEqual(entry.type, 'boolean', 'configSchema type must be "boolean"');
    assert.strictEqual(entry.default, false, 'configSchema default must be false');
  });
});

// ─── 2. DISPATCH — command reaches the router via default-case registry ──────

describe('github-sync cutover: dispatch path (default-case → capability registry)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('enabled + gh-free PATH: "github-sync preflight" reaches the router — stdout JSON {ok, reason}, exit 0', () => {
    enableGithubSync(path.join(tmpDir, '.planning'));
    const result = runGsdTools(['github-sync', 'preflight'], tmpDir, { PATH: noGhPath() });

    assert.ok(result.success, `Expected success (degrade path, exit 0); error: ${result.error}`);
    let parsed;
    try {
      parsed = JSON.parse(result.output);
    } catch (e) {
      throw new Error(`stdout must parse as JSON. stdout: ${result.output}\nerror: ${e.message}`);
    }
    assert.strictEqual(typeof parsed.ok, 'boolean', `parsed.ok must be boolean; got: ${JSON.stringify(parsed)}`);
    assert.strictEqual(typeof parsed.reason, 'string', `parsed.reason must be a string; got: ${JSON.stringify(parsed)}`);

    const isUnknownCommand = (result.error || '').includes('Unknown command: github-sync');
    assert.strictEqual(isUnknownCommand, false, 'Must not emit "Unknown command: github-sync"');
  });
});

// ─── 3. NO-HARDCODED-BRANCH — gsd-tools.cjs is provably branch-free ──────────

describe('github-sync cutover: no hardcoded branch in gsd-tools.cjs', () => {
  test('gsd-tools.cjs contains no case label naming the family and no require of the router module', () => {
    const gsdToolsPath = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
    const source = fs.readFileSync(gsdToolsPath, 'utf8');

    // No `case 'github-sync':` (or double-quoted equivalent) — matches the
    // pattern a hardcoded cutover-regression branch would introduce.
    assert.doesNotMatch(source, /case\s+['"]github-sync['"]\s*:/,
      'gsd-tools.cjs must contain no case label naming "github-sync"');

    // No direct require of the router module — dispatch must resolve only
    // through commandFamilies['github-sync'] in the generated registry.
    assert.doesNotMatch(source, /github-sync-command-router\.cjs/,
      'gsd-tools.cjs must contain no require of github-sync-command-router.cjs');
  });
});

// ─── 4. ERROR PATHS — GSD_JSON_ERRORS structured shape ───────────────────────

describe('github-sync cutover: --json-errors structured output', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('enabled + unregistered subcommand + GSD_JSON_ERRORS=1 → structured ok:false JSON on stderr', () => {
    enableGithubSync(path.join(tmpDir, '.planning'));
    const parsed = runJsonErrors(['github-sync', 'bogus-xyzzy'], tmpDir, { PATH: noGhPath() });
    assertTypedError(parsed, 'sdk_unknown_command', 'unregistered github-sync subcommand');
    assert.ok(
      parsed.message.includes('github-sync') || parsed.message.includes('Unknown'),
      `message should mention github-sync or Unknown subcommand; got: ${parsed.message}`,
    );
  });
});
