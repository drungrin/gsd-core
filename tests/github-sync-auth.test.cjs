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
