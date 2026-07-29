'use strict';

/**
 * github-sync-auth.test.cjs — classification, message-selection, and cache
 * coverage for the auth preflight (Phase 1, plan 01-02).
 *
 * Task 1: classifyGhResult's six-way (plus null-payload) matrix, precedence,
 * and determinism. Asserts on the returned reason constant, never on
 * message text (#2974 precedent).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyGhResult,
  selectPreflightMessage,
  runPreflight,
  PREFLIGHT_REASON,
} = require('../gsd-core/bin/lib/github-sync-auth.cjs');
const { GH_REASON } = require('../gsd-core/bin/lib/github-sync-gh.cjs');

function ghResult(overrides) {
  return {
    exitCode: 1,
    stdout: '',
    stderr: '',
    reason: GH_REASON.EXIT_NONZERO,
    ...overrides,
  };
}

describe('classifyGhResult', () => {
  test('exit 0 with a data-bearing stdout classifies as ok', () => {
    const result = ghResult({ exitCode: 0, stdout: '{"data":{"viewer":{}}}', reason: GH_REASON.OK });
    assert.strictEqual(classifyGhResult(result), PREFLIGHT_REASON.OK);
  });

  test('gh-not-found reason classifies as missing_gh', () => {
    const result = ghResult({ exitCode: 127, reason: GH_REASON.ENOENT });
    assert.strictEqual(classifyGhResult(result), PREFLIGHT_REASON.MISSING_GH);
  });

  test('gh-timed-out reason classifies as outage', () => {
    const result = ghResult({ exitCode: 124, reason: GH_REASON.TIMEOUT, timeout_ms: 15000 });
    assert.strictEqual(classifyGhResult(result), PREFLIGHT_REASON.OUTAGE);
  });

  test('stderr with "required scopes", any case, surrounding text, classifies as wrong_scope', () => {
    const result = ghResult({
      stderr: 'gh: Your token has not been granted the REQUIRED SCOPES to execute this query.',
    });
    assert.strictEqual(classifyGhResult(result), PREFLIGHT_REASON.WRONG_SCOPE);
  });

  test('stderr with "not been granted", lowercase, classifies as wrong_scope', () => {
    const result = ghResult({ stderr: 'your token has not been granted access' });
    assert.strictEqual(classifyGhResult(result), PREFLIGHT_REASON.WRONG_SCOPE);
  });

  test('stderr with bad credentials classifies as no_token', () => {
    const result = ghResult({ stderr: 'gh: Bad credentials (HTTP 401)' });
    assert.strictEqual(classifyGhResult(result), PREFLIGHT_REASON.NO_TOKEN);
  });

  test('stderr mentioning HTTP 401 without "bad credentials" wording classifies as no_token', () => {
    const result = ghResult({ stderr: 'gh: request failed: HTTP 401' });
    assert.strictEqual(classifyGhResult(result), PREFLIGHT_REASON.NO_TOKEN);
  });

  test('stderr mentioning a rate limit classifies as rate_limited', () => {
    const result = ghResult({ stderr: 'gh: API rate limit exceeded for user' });
    assert.strictEqual(classifyGhResult(result), PREFLIGHT_REASON.RATE_LIMITED);
  });

  test('stderr mentioning a secondary rate limit classifies as rate_limited', () => {
    const result = ghResult({ stderr: 'gh: You have exceeded a secondary rate limit' });
    assert.strictEqual(classifyGhResult(result), PREFLIGHT_REASON.RATE_LIMITED);
  });

  test('stderr mentioning HTTP 5xx classifies as outage', () => {
    const result = ghResult({ stderr: 'gh: request failed: HTTP 503' });
    assert.strictEqual(classifyGhResult(result), PREFLIGHT_REASON.OUTAGE);
  });

  test('stderr mentioning a bad gateway classifies as outage', () => {
    const result = ghResult({ stderr: 'gh: 502 Bad Gateway' });
    assert.strictEqual(classifyGhResult(result), PREFLIGHT_REASON.OUTAGE);
  });

  test('stderr mentioning service unavailability classifies as outage', () => {
    const result = ghResult({ stderr: 'gh: Service Unavailable' });
    assert.strictEqual(classifyGhResult(result), PREFLIGHT_REASON.OUTAGE);
  });

  test('a non-zero result matching no signal classifies as outage (defensive default)', () => {
    const result = ghResult({ stderr: 'gh: some completely unrecognized failure text' });
    assert.strictEqual(classifyGhResult(result), PREFLIGHT_REASON.OUTAGE);
  });

  test('exit 0 with empty stdout classifies as sso_or_null_payload and does not throw', () => {
    const result = ghResult({ exitCode: 0, stdout: '', reason: GH_REASON.OK });
    assert.strictEqual(classifyGhResult(result), PREFLIGHT_REASON.SSO_OR_NULL_PAYLOAD);
  });

  test('exit 0 with non-JSON stdout classifies as sso_or_null_payload and does not throw', () => {
    const result = ghResult({ exitCode: 0, stdout: 'not json at all', reason: GH_REASON.OK });
    assert.strictEqual(classifyGhResult(result), PREFLIGHT_REASON.SSO_OR_NULL_PAYLOAD);
  });

  test('exit 0 with stdout parsing to a null data field classifies as sso_or_null_payload', () => {
    const result = ghResult({ exitCode: 0, stdout: '{"data":null}', reason: GH_REASON.OK });
    assert.strictEqual(classifyGhResult(result), PREFLIGHT_REASON.SSO_OR_NULL_PAYLOAD);
  });

  test('precedence: stderr with both a rate-limit phrase and a required-scopes phrase classifies as wrong_scope', () => {
    const result = ghResult({
      stderr: 'gh: API rate limit exceeded. Your token has not been granted the required scopes.',
    });
    assert.strictEqual(classifyGhResult(result), PREFLIGHT_REASON.WRONG_SCOPE);
  });

  test('determinism: identical input yields an identical reason across repeated calls', () => {
    const result = ghResult({ stderr: 'gh: API rate limit exceeded for user' });
    const first = classifyGhResult(result);
    const second = classifyGhResult(result);
    assert.strictEqual(first, second);
    assert.strictEqual(first, PREFLIGHT_REASON.RATE_LIMITED);
  });

  test('both stdout and stderr empty with a non-zero exit still classifies as outage and never returns an empty reason', () => {
    const result = ghResult({ exitCode: 1, stdout: '', stderr: '' });
    const reason = classifyGhResult(result);
    assert.strictEqual(reason, PREFLIGHT_REASON.OUTAGE);
    assert.notStrictEqual(reason, '');
  });
});

/**
 * Task 2: selectPreflightMessage's message catalog and D-10 environment-
 * signal remedy selection. All environment inputs are literal objects —
 * never a mutation of the real process.env.
 */
describe('selectPreflightMessage', () => {
  test('wrong_scope with no env signal selects the developer remedy', () => {
    const message = selectPreflightMessage(PREFLIGHT_REASON.WRONG_SCOPE, {});
    assert.match(message, /gh auth refresh -s project/);
  });

  test('wrong_scope with CI set selects the CI remedy naming GH_TOKEN, not the developer remedy', () => {
    const message = selectPreflightMessage(PREFLIGHT_REASON.WRONG_SCOPE, { CI: '1' });
    assert.match(message, /GH_TOKEN/);
    assert.doesNotMatch(message, /gh auth refresh -s project/);
  });

  test('wrong_scope with CI set to the empty string selects the developer remedy (empty counts as absent)', () => {
    const message = selectPreflightMessage(PREFLIGHT_REASON.WRONG_SCOPE, { CI: '' });
    assert.match(message, /gh auth refresh -s project/);
  });

  test('wrong_scope with GITHUB_ACTIONS set selects the CI remedy', () => {
    const message = selectPreflightMessage(PREFLIGHT_REASON.WRONG_SCOPE, { GITHUB_ACTIONS: 'true' });
    assert.match(message, /GH_TOKEN/);
  });

  test('wrong_scope with GH_TOKEN set and no CI variable selects the CI remedy', () => {
    const message = selectPreflightMessage(PREFLIGHT_REASON.WRONG_SCOPE, { GH_TOKEN: 'x' });
    assert.match(message, /GH_TOKEN/);
  });

  test('wrong_scope with GITHUB_TOKEN set and no CI variable selects the CI remedy', () => {
    const message = selectPreflightMessage(PREFLIGHT_REASON.WRONG_SCOPE, { GITHUB_TOKEN: 'x' });
    assert.match(message, /GH_TOKEN/);
  });

  test('wrong_scope with GH_TOKEN present but empty selects the developer remedy', () => {
    const message = selectPreflightMessage(PREFLIGHT_REASON.WRONG_SCOPE, { GH_TOKEN: '' });
    assert.match(message, /gh auth refresh -s project/);
  });

  test('CI remedy never suggests adjusting a workflow permissions block', () => {
    const message = selectPreflightMessage(PREFLIGHT_REASON.WRONG_SCOPE, { CI: '1' });
    assert.doesNotMatch(message, /permissions:/);
  });

  test('no_token with CI set also selects the CI remedy naming GH_TOKEN', () => {
    const message = selectPreflightMessage(PREFLIGHT_REASON.NO_TOKEN, { CI: '1' });
    assert.match(message, /GH_TOKEN/);
  });

  test('missing_gh message names installing the GitHub CLI', () => {
    const message = selectPreflightMessage(PREFLIGHT_REASON.MISSING_GH, {});
    assert.match(message, /install/i);
  });

  test('no_token message names authenticating', () => {
    const message = selectPreflightMessage(PREFLIGHT_REASON.NO_TOKEN, {});
    assert.match(message, /auth/i);
  });

  test('rate_limited message names waiting and retrying', () => {
    const message = selectPreflightMessage(PREFLIGHT_REASON.RATE_LIMITED, {});
    assert.match(message, /retry|retrying|wait/i);
  });

  test('outage message names a transient GitHub failure', () => {
    const message = selectPreflightMessage(PREFLIGHT_REASON.OUTAGE, {});
    assert.match(message, /transient|temporary|GitHub/i);
  });

  test('sso_or_null_payload message names SSO authorization as the likely cause', () => {
    const message = selectPreflightMessage(PREFLIGHT_REASON.SSO_OR_NULL_PAYLOAD, {});
    assert.match(message, /SSO/);
  });

  test('every PREFLIGHT_REASON member (including ok) selects a non-empty message', () => {
    for (const reason of Object.values(PREFLIGHT_REASON)) {
      const message = selectPreflightMessage(reason, {});
      assert.strictEqual(typeof message, 'string');
      assert.ok(message.length > 0, `expected a non-empty message for reason=${reason}`);
    }
  });
});

describe('runPreflight message wiring', () => {
  test('never leaks raw gh stdout/stderr markers into the returned message', () => {
    const stdoutMarker = 'zzqx-stdout-marker-9f2a';
    const stderrMarker = 'zzqx-stderr-marker-7b31';
    const fakeGh = {
      probeProjectsV2Scope: () => ({
        exitCode: 1,
        stdout: `some payload containing ${stdoutMarker}`,
        stderr: `gh: failure mentioning ${stderrMarker}`,
        reason: GH_REASON.EXIT_NONZERO,
      }),
    };

    const result = runPreflight('/tmp', { _gh: fakeGh });
    assert.strictEqual(result.ok, false);
    assert.doesNotMatch(result.message, new RegExp(stdoutMarker));
    assert.doesNotMatch(result.message, new RegExp(stderrMarker));
  });

  test('returns ok:false with a populated reason and message for every failure class, and never throws', () => {
    const cases = [
      { reason: GH_REASON.ENOENT, exitCode: 127, stderr: '' },
      { reason: GH_REASON.TIMEOUT, exitCode: 124, stderr: '' },
      { reason: GH_REASON.EXIT_NONZERO, exitCode: 1, stderr: 'gh: required scopes missing' },
      { reason: GH_REASON.EXIT_NONZERO, exitCode: 1, stderr: 'gh: Bad credentials (HTTP 401)' },
      { reason: GH_REASON.EXIT_NONZERO, exitCode: 1, stderr: 'gh: API rate limit exceeded' },
      { reason: GH_REASON.EXIT_NONZERO, exitCode: 1, stderr: 'gh: 503 Service Unavailable' },
      { reason: GH_REASON.OK, exitCode: 0, stderr: '', stdout: '' },
    ];

    for (const c of cases) {
      const fakeGh = {
        probeProjectsV2Scope: () => ({
          exitCode: c.exitCode,
          stdout: c.stdout ?? '',
          stderr: c.stderr,
          reason: c.reason,
        }),
      };

      let result;
      assert.doesNotThrow(() => {
        result = runPreflight('/tmp', { _gh: fakeGh });
      });
      assert.strictEqual(result.ok, false);
      assert.ok(result.reason.length > 0);
      assert.ok(result.message.length > 0);
    }
  });
});
