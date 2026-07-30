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
const { PREFLIGHT_REASON } = require('../gsd-core/bin/lib/github-sync-auth.cjs');

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

/**
 * gh's own `exitAuthError` exit code, raised before any HTTP request is
 * issued whenever no credentials are configured at all. Observed live
 * against `gh version 2.96.0` during planning and re-observed by the
 * executor of plan 01-09 before authoring this test (see 01-09-SUMMARY.md).
 * Duplicated here as a local literal rather than imported: Task 1 runs
 * before Task 2 introduces the named `GH_AUTH_EXIT_CODE` constant in
 * src/github-sync-auth.cts, and this file's Tier 2 non-vacuity guard needs
 * it to exist from the start.
 */
const GH_AUTH_EXIT_CODE_OBSERVED = 4;

/**
 * Env-override object for a credential-free `gh` invocation: a freshly
 * created empty `GH_CONFIG_DIR` plus the three token env keys removed
 * (never emptied — `undefined` is what Node omits from the child's env
 * pairs, and an empty-valued token variable is a materially different
 * state from an absent one per D-10's `hasCiOrTokenEnvSignal`). Mirrors the
 * `noGhPath` helper's temp-directory shape above.
 */
function credentialFreeGhEnv() {
  const emptyConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-no-gh-config-'));
  return {
    GH_CONFIG_DIR: emptyConfigDir,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_ENTERPRISE_TOKEN: undefined,
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

  test('capability disabled: exits 0 with empty stdout and stderr', () => {
    const tmpDir = createTempProject();
    try {
      // github_sync.enabled is intentionally absent from .planning/config.json.
      const result = runPreflight(tmpDir, { PATH: noGhPath() });

      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
      assert.strictEqual(result.stdout, '', `stdout must be empty, got: "${result.stdout}"`);
      assert.strictEqual(result.stderr, '', `stderr must be empty, got: "${result.stderr}"`);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('registry dispatch: github-sync family resolves to the command router module', () => {
    const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
    const entry = registry.commandFamilies['github-sync'];
    assert.ok(entry, 'registry.commandFamilies must include a "github-sync" entry');
    assert.strictEqual(entry.module, 'github-sync-command-router.cjs');
    assert.strictEqual(entry.router, 'routeGithubSyncCommandRouter');
  });
});

/**
 * Plan 01-09 (REVIEW.md CR-01): a live, un-mocked proof of the single most
 * common real auth failure — no GitHub credentials configured at all —
 * through the real `gh` binary end to end. Every other test in this file
 * deliberately hides `gh` via the `noGhPath` helper; this is the first
 * that requires the real binary, which is exactly the layer CR-01 found
 * untested. Two
 * non-vacuity guards precede the assertions and each records an explicit
 * named skip rather than a silent pass — a guard that skips quietly is the
 * same defect class as a fixture authored from assumption rather than
 * observation, which is what this whole plan exists to correct.
 */
describe('github-sync preflight — live gh, no credentials configured (CR-01)', () => {
  test(
    'no credentials configured: real gh exits 0, reason is no_token, stderr names gh auth login',
    { timeout: 30000 },
    (t) => {
      const versionCheck = spawnSync('gh', ['--version'], { encoding: 'utf-8' });
      if (versionCheck.error || versionCheck.status !== 0) {
        t.skip('gh is not usable on PATH (spawn error or non-zero `gh --version` exit) — skipping live gh end-to-end test');
        return;
      }

      const credentialFreeEnv = credentialFreeGhEnv();
      try {
        const probe = spawnSync(
          'gh',
          ['api', 'graphql', '-f', 'query=query { viewer { projectsV2(first: 1) { totalCount } } }'],
          {
            encoding: 'utf-8',
            timeout: 30000,
            env: { ...process.env, ...credentialFreeEnv },
          },
        );
        if (probe.status !== GH_AUTH_EXIT_CODE_OBSERVED) {
          t.skip(
            `credential-free gh probe exited ${probe.status}, expected the observed auth exit code ` +
            `${GH_AUTH_EXIT_CODE_OBSERVED} — the host appears to carry ambient GitHub credentials the ` +
            `GH_CONFIG_DIR redirection did not isolate`,
          );
          return;
        }

        const tmpDir = createTempProject();
        try {
          enableGithubSync(path.join(tmpDir, '.planning'));
          const result = runPreflight(tmpDir, credentialFreeEnv);

          assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);

          let parsed;
          try {
            parsed = JSON.parse(result.stdout);
          } catch (e) {
            throw new Error(`stdout must parse as JSON. stdout: ${result.stdout}\nerror: ${e.message}`);
          }
          assert.strictEqual(parsed.ok, false, `expected ok:false, got: ${JSON.stringify(parsed)}`);
          assert.strictEqual(
            parsed.reason,
            PREFLIGHT_REASON.NO_TOKEN,
            `expected reason:${PREFLIGHT_REASON.NO_TOKEN}, got: ${JSON.stringify(parsed)}`,
          );
          assert.notStrictEqual(
            parsed.reason,
            PREFLIGHT_REASON.MISSING_GH,
            'reason must not be missing_gh — proves the real gh binary was found and executed',
          );
          assert.ok(
            result.stderr.includes('gh auth login'),
            `stderr must name gh auth login, got: "${result.stderr}"`,
          );
        } finally {
          cleanup(tmpDir);
        }
      } finally {
        cleanup(credentialFreeEnv.GH_CONFIG_DIR);
      }
    },
  );
});
