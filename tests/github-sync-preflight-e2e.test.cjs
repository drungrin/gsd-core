'use strict';

/**
 * github-sync-preflight-e2e.test.cjs — hermetic end-to-end proof that
 * `gsd-tools github-sync preflight` reaches the capability router through
 * registry dispatch and degrades to exit 0 on every path (Phase 1, plan 01-01).
 *
 * Uses a real `spawnSync` invocation of gsd-tools.cjs (not the runGsdTools()
 * helper) because runGsdTools() discards stderr on a zero-exit process, and
 * this suite's whole point is asserting on the actionable stderr message that
 * accompanies an `ok: false` exit-0 result (D-11/SAFE-01).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { createTempProject, cleanup, TOOLS_PATH } = require('./helpers.cjs');

function enableGithubSync(planningDir) {
  const configPath = path.join(planningDir, 'config.json');
  const config = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
    : {};
  config.github_sync = { enabled: true };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * PATH containing only a fresh empty directory plus the running node
 * binary's directory. Guarantees `gh` cannot be found on PATH regardless of
 * whether the host machine has a real `gh` installed — the RED case for
 * SAFE-01's "missing gh binary" degrade path.
 */
function noGhPath() {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-no-gh-'));
  return `${emptyDir}${path.delimiter}${path.dirname(process.execPath)}`;
}

function runPreflight(cwd, envOverrides = {}) {
  const result = spawnSync(process.execPath, [TOOLS_PATH, 'github-sync', 'preflight'], {
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

describe('github-sync preflight — end to end', () => {
  test('missing gh binary: exits 0, stdout JSON ok:false reason:missing_gh, non-empty actionable stderr', () => {
    const tmpDir = createTempProject();
    try {
      enableGithubSync(path.join(tmpDir, '.planning'));
      const result = runPreflight(tmpDir, { PATH: noGhPath() });

      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);

      let parsed;
      try {
        parsed = JSON.parse(result.stdout);
      } catch (e) {
        throw new Error(`stdout must parse as JSON. stdout: ${result.stdout}\nerror: ${e.message}`);
      }
      assert.strictEqual(parsed.ok, false, `expected ok:false, got: ${JSON.stringify(parsed)}`);
      assert.strictEqual(parsed.reason, 'missing_gh', `expected reason:missing_gh, got: ${JSON.stringify(parsed)}`);

      assert.ok(
        typeof result.stderr === 'string' && result.stderr.length > 0,
        `stderr must carry a non-empty actionable message, got: "${result.stderr}"`,
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  test('capability disabled: exits 0, stderr names github_sync.enabled and .planning/config.json', () => {
    const tmpDir = createTempProject();
    try {
      // github_sync.enabled is intentionally absent from .planning/config.json.
      const result = runPreflight(tmpDir, { PATH: noGhPath() });

      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
      assert.ok(
        result.stderr.includes('github_sync.enabled'),
        `stderr must name github_sync.enabled, got: "${result.stderr}"`,
      );
      assert.ok(
        result.stderr.includes('.planning/config.json'),
        `stderr must name .planning/config.json, got: "${result.stderr}"`,
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  test('registry dispatch: github-sync family resolves to the command router module', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
    const entry = registry.commandFamilies['github-sync'];
    assert.ok(entry, 'registry.commandFamilies must include a "github-sync" entry');
    assert.strictEqual(entry.module, 'github-sync-command-router.cjs');
    assert.strictEqual(entry.router, 'routeGithubSyncCommandRouter');
  });
});
