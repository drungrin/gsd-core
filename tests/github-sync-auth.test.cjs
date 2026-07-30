'use strict';

/**
 * github-sync-auth.test.cjs — classification, message-selection, and cache
 * coverage for the auth preflight (Phase 1, plan 01-02).
 *
 * Task 1: classifyGhResult's six-way (plus null-payload) matrix, precedence,
 * and determinism. Asserts on the returned reason constant, never on
 * message text (#2974 precedent).
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  classifyGhResult,
  selectPreflightMessage,
  runPreflight,
  PREFLIGHT_REASON,
  _resetPreflightCacheForTests,
} = require('../gsd-core/bin/lib/github-sync-auth.cjs');
const { GH_REASON } = require('../gsd-core/bin/lib/github-sync-gh.cjs');

beforeEach(() => {
  _resetPreflightCacheForTests();
});

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
  test('exit 0 with a complete Projects v2 response classifies as ok', () => {
    const result = ghResult({ exitCode: 0, stdout: '{"data":{"viewer":{"projectsV2":{"totalCount":0}}}}', reason: GH_REASON.OK });
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

describe('runPreflight Projects v2 response-envelope validation', () => {
  const validPayload = { data: { viewer: { projectsV2: { totalCount: 0 } } } };
  const invalidPayloads = [
    ['null projectsV2', { data: { viewer: { projectsV2: null } } }],
    ['missing viewer', { data: {} }],
    ['missing totalCount', { data: { viewer: { projectsV2: {} } } }],
    ['non-numeric totalCount', { data: { viewer: { projectsV2: { totalCount: '0' } } } }],
    ['GraphQL errors alongside data', { ...validPayload, errors: [{ message: 'not authorized' }] }],
  ];

  function runPayload(payload) {
    _resetPreflightCacheForTests();
    return runPreflight('/tmp', { _gh: { probeProjectsV2Scope: () => ({
      exitCode: 0, stdout: typeof payload === 'string' ? payload : JSON.stringify(payload), stderr: '', reason: GH_REASON.OK,
    }) } });
  }

  test('fully valid data and empty errors arrays remain ok', () => {
    for (const payload of [validPayload, { ...validPayload, errors: [] }]) {
      const result = runPayload(payload);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.reason, PREFLIGHT_REASON.OK);
    }
  });

  for (const [label, payload] of [...invalidPayloads, ['malformed JSON', '{not JSON}']]) {
    test(`${label} degrades to the actionable SSO/null-payload result`, () => {
      const result = runPayload(payload);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, PREFLIGHT_REASON.SSO_OR_NULL_PAYLOAD);
      assert.ok(result.message.length > 0);
    });
  }
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
      // D-12's per-process cache would otherwise return the first
      // iteration's cached result for every subsequent case.
      _resetPreflightCacheForTests();

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

/**
 * Task 3: the once-per-process probe cache and its explicit test-reset
 * seam (D-12). `beforeEach` above already resets the cache before every
 * test in this file, so each `describe` block here re-asserts the reset
 * explicitly where the cache-state assertion is the point of the test.
 */
describe('preflight probe cache', () => {
  function countingGh() {
    let calls = 0;
    return {
      calls: () => calls,
      probeProjectsV2Scope: () => {
        calls += 1;
        return { exitCode: 0, stdout: '{"data":{}}', stderr: '', reason: GH_REASON.OK };
      },
    };
  }

  test('two consecutive runPreflight calls spawn the probe exactly once', () => {
    const gh = countingGh();
    runPreflight('/tmp', { _gh: gh });
    runPreflight('/tmp', { _gh: gh });
    assert.strictEqual(gh.calls(), 1);
  });

  test('_resetPreflightCacheForTests() followed by runPreflight spawns the probe again', () => {
    const gh = countingGh();
    runPreflight('/tmp', { _gh: gh });
    runPreflight('/tmp', { _gh: gh });
    assert.strictEqual(gh.calls(), 1);

    _resetPreflightCacheForTests();
    runPreflight('/tmp', { _gh: gh });
    assert.strictEqual(gh.calls(), 2);
  });

  test('a cached failure result is returned unchanged rather than re-probed', () => {
    const gh = {
      calls: 0,
      probeProjectsV2Scope() {
        this.calls += 1;
        return { exitCode: 1, stdout: '', stderr: 'gh: API rate limit exceeded', reason: GH_REASON.EXIT_NONZERO };
      },
    };

    const first = runPreflight('/tmp', { _gh: gh });
    const second = runPreflight('/tmp', { _gh: gh });
    assert.strictEqual(gh.calls, 1);
    assert.deepStrictEqual(first, second);
    assert.strictEqual(first.ok, false);
    assert.strictEqual(first.reason, PREFLIGHT_REASON.RATE_LIMITED);
  });

  test('the module performs no filesystem write', () => {
    const fs = require('node:fs');
    const source = fs.readFileSync(
      require.resolve('../gsd-core/bin/lib/github-sync-auth.cjs'),
      'utf8',
    );
    assert.doesNotMatch(source, /writeFileSync/);
    assert.doesNotMatch(source, /platformWriteSync/);
    assert.doesNotMatch(source, /require\(["']node:fs["']\)/);
  });
});

/**
 * Task 1 (plan 01-07, REVIEW.md WR-01): pins the two published reason
 * catalogs -- the hand-written command doc and its generated skill
 * projection -- to the frozen PREFLIGHT_REASON enum in both directions.
 * Both files quoted a `preflight_failed` reason value that
 * `classifyGhResult` can never return; this block makes that impossible to
 * reintroduce in either direction (a phantom value, or a new enum member
 * landing undocumented).
 */
describe('published reason catalog pin (commands/gsd/sync-github.md + skills/gsd-sync-github/SKILL.md)', () => {
  const PUBLISHED_FILES = [
    {
      label: 'commands/gsd/sync-github.md',
      filePath: path.join(__dirname, '..', 'commands', 'gsd', 'sync-github.md'),
    },
    {
      label: 'skills/gsd-sync-github/SKILL.md',
      filePath: path.join(__dirname, '..', 'skills', 'gsd-sync-github', 'SKILL.md'),
    },
  ];

  /**
   * Extracts every JSON-shaped `"reason": "<value>"` capture from `text` and
   * asserts each is a member of `Object.values(PREFLIGHT_REASON)` -- read at
   * run time, never hardcoded here. Throws on the first phantom value found,
   * naming both the value and `label`. Also throws if fewer than two reason
   * values are captured, so a doc that stops quoting reason shapes entirely
   * fails the pin rather than passing vacuously.
   */
  function assertReasonsAreEnumMembers(text, label) {
    const validReasons = new Set(Object.values(PREFLIGHT_REASON));
    const pattern = /"reason"\s*:\s*"([a-z_]+)"/g;
    const captured = [];
    let match;
    while ((match = pattern.exec(text)) !== null) {
      captured.push(match[1]);
    }
    assert.ok(
      captured.length >= 2,
      `expected at least two JSON-shaped reason values in ${label}, found ${captured.length}`,
    );
    for (const value of captured) {
      assert.ok(
        validReasons.has(value),
        `${label} quotes reason value "${value}" which is not a member of PREFLIGHT_REASON`,
      );
    }
    return captured;
  }

  test('Direction 1 -- no phantom reasons: every quoted reason value in each published file is a real enum member', () => {
    for (const { label, filePath } of PUBLISHED_FILES) {
      const text = fs.readFileSync(filePath, 'utf8');
      assertReasonsAreEnumMembers(text, label);
    }
  });

  test('Direction 2 -- no undocumented members: every PREFLIGHT_REASON member appears somewhere in each published file', () => {
    for (const { label, filePath } of PUBLISHED_FILES) {
      const text = fs.readFileSync(filePath, 'utf8');
      for (const reason of Object.values(PREFLIGHT_REASON)) {
        assert.ok(text.includes(reason), `${label} never mentions PREFLIGHT_REASON member "${reason}"`);
      }
    }
  });

  test('fail-first control: the helper throws on an inline fixture carrying a phantom reason value', () => {
    const phantomFixture =
      '`{"ok": true, "reason": "ok", ...}` and `{"ok": false, "reason": "preflight_failed", ...}`';
    assert.throws(() => assertReasonsAreEnumMembers(phantomFixture, 'phantom-fixture'));
  });

  test('fail-first control: the helper does not throw on an inline fixture carrying only real enum members', () => {
    const realFixture =
      '`{"ok": true, "reason": "ok", ...}` and `{"ok": false, "reason": "missing_gh", ...}`';
    assert.doesNotThrow(() => assertReasonsAreEnumMembers(realFixture, 'real-fixture'));
  });

  test('non-vacuity control: the helper throws on an inline fixture with zero reason values', () => {
    const emptyFixture = 'this text quotes no JSON-shaped reason field at all';
    assert.throws(() => assertReasonsAreEnumMembers(emptyFixture, 'empty-fixture'));
  });
});

/**
 * Plan 01-09 (REVIEW.md CR-01): classification fixtures built from
 * byte-verbatim observed `gh` output for all three auth-failure forms, not
 * from a paraphrase of the classifier's own assumed phrasing. Re-observed
 * live against `gh version 2.96.0` by the executor of plan 01-09 (see
 * 01-09-SUMMARY.md for the full transcription).
 *
 * Written as plain single-quoted string concatenation, never a template
 * literal: Form B's doubled-brace `${{ github.token }}` GitHub Actions
 * expression would otherwise be swallowed by interpolation.
 */
const GH_NO_CREDENTIALS_STDERR =
  'To get started with GitHub CLI, please run:  gh auth login\n' +
  'Alternatively, populate the GH_TOKEN environment variable with a GitHub API ' +
  'authentication token.';

const GH_ACTIONS_NO_TOKEN_STDERR =
  'gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment ' +
  'variable. Example:\n' +
  '  env:\n' +
  '    GH_TOKEN: ${{ github.token }}';

const GH_INVALID_TOKEN_STDERR = 'gh: Bad credentials (HTTP 401)';

/**
 * `gh`'s own `exitAuthError` exit code (its `exitAuthError`), observed live
 * against `gh version 2.96.0`. Not imported: src/github-sync-auth.cts's
 * `GH_AUTH_EXIT_CODE` is a module-internal constant, not part of the
 * module's exported surface (see the interfaces block in 01-09-PLAN.md).
 */
const GH_AUTH_EXIT_CODE = 4;

describe('classifyGhResult — no_token exit-code promotion (CR-01, plan 01-09)', () => {
  test('fixtures are pure printable ASCII plus newlines', () => {
    const asciiPlusNewlines = /^[\x20-\x7E\n]*$/;
    assert.match(GH_NO_CREDENTIALS_STDERR, asciiPlusNewlines);
    assert.match(GH_ACTIONS_NO_TOKEN_STDERR, asciiPlusNewlines);
    assert.match(GH_INVALID_TOKEN_STDERR, asciiPlusNewlines);
  });

  test('Form B fixture preserves the doubled-brace GitHub Actions token expression verbatim', () => {
    assert.ok(
      GH_ACTIONS_NO_TOKEN_STDERR.includes('${{ github.token }}'),
      'Form B fixture must contain the literal doubled-brace expression, unswallowed by interpolation',
    );
  });

  test('Form A fixture (interactive, no credentials) classifies as no_token', () => {
    const result = ghResult({
      exitCode: GH_AUTH_EXIT_CODE,
      stderr: GH_NO_CREDENTIALS_STDERR,
      reason: GH_REASON.EXIT_NONZERO,
    });
    assert.strictEqual(classifyGhResult(result), PREFLIGHT_REASON.NO_TOKEN);
  });

  test('Form B fixture (GitHub Actions, no credentials) classifies as no_token', () => {
    const result = ghResult({
      exitCode: GH_AUTH_EXIT_CODE,
      stderr: GH_ACTIONS_NO_TOKEN_STDERR,
      reason: GH_REASON.EXIT_NONZERO,
    });
    assert.strictEqual(classifyGhResult(result), PREFLIGHT_REASON.NO_TOKEN);
  });

  test('the auth exit code with completely empty stderr and stdout classifies as no_token (exit code alone suffices)', () => {
    const result = ghResult({
      exitCode: GH_AUTH_EXIT_CODE,
      stdout: '',
      stderr: '',
      reason: GH_REASON.EXIT_NONZERO,
    });
    assert.strictEqual(classifyGhResult(result), PREFLIGHT_REASON.NO_TOKEN);
  });

  test('Form C fixture (invalid token, exit code 1) classifies as no_token through the phrase backstop alone', () => {
    const result = ghResult({ exitCode: 1, stderr: GH_INVALID_TOKEN_STDERR, reason: GH_REASON.EXIT_NONZERO });
    assert.strictEqual(classifyGhResult(result), PREFLIGHT_REASON.NO_TOKEN);
  });

  test('Form A phrase upper-cased still classifies as no_token (case-insensitive match, not luck of observed casing)', () => {
    const result = ghResult({
      exitCode: 1,
      stderr: GH_NO_CREDENTIALS_STDERR.toUpperCase(),
      reason: GH_REASON.EXIT_NONZERO,
    });
    assert.strictEqual(classifyGhResult(result), PREFLIGHT_REASON.NO_TOKEN);
  });

  test('precedence: the auth exit code together with a required-scopes phrase classifies as wrong_scope, not no_token', () => {
    const result = ghResult({
      exitCode: GH_AUTH_EXIT_CODE,
      stderr: 'gh: Your token has not been granted the required scopes to execute this query.',
      reason: GH_REASON.EXIT_NONZERO,
    });
    assert.strictEqual(
      classifyGhResult(result),
      PREFLIGHT_REASON.WRONG_SCOPE,
      'the AUTH-01 `gh auth refresh -s project` remedy must not be captured by the new exit-code branch',
    );
  });

  test('non-regression: exit 1 with unrecognized stderr still classifies as outage (WR-01(current) 403/SAML sub-case remains deferred)', () => {
    const result = ghResult({ exitCode: 1, stderr: 'gh: some completely unrecognized failure text', reason: GH_REASON.EXIT_NONZERO });
    assert.strictEqual(
      classifyGhResult(result),
      PREFLIGHT_REASON.OUTAGE,
      'WR-01(current): the deferred SAML/403 sub-case must land on the defensive default, unchanged by this branch',
    );
  });

  test('PREFLIGHT_REASON still has exactly seven members — no new reason was minted', () => {
    assert.strictEqual(Object.keys(PREFLIGHT_REASON).length, 7);
  });

  test('AUTH-01: runPreflight with an injected _gh returning the Form A fixture yields a message naming gh auth login', () => {
    _resetPreflightCacheForTests();
    const fakeGh = {
      probeProjectsV2Scope: () => ({
        exitCode: GH_AUTH_EXIT_CODE,
        stdout: '',
        stderr: GH_NO_CREDENTIALS_STDERR,
        reason: GH_REASON.EXIT_NONZERO,
      }),
    };
    const result = runPreflight('/tmp', { _gh: fakeGh });
    assert.strictEqual(result.reason, PREFLIGHT_REASON.NO_TOKEN);
    assert.match(result.message, /gh auth login/);
  });

  test('AUTH-03: the Form B fixture classifies as no_token, and under a CI environment signal the message names GH_TOKEN', () => {
    const formBResult = ghResult({
      exitCode: GH_AUTH_EXIT_CODE,
      stderr: GH_ACTIONS_NO_TOKEN_STDERR,
      reason: GH_REASON.EXIT_NONZERO,
    });
    const reason = classifyGhResult(formBResult);
    assert.strictEqual(reason, PREFLIGHT_REASON.NO_TOKEN);
    const message = selectPreflightMessage(reason, { CI: '1' });
    assert.match(message, /GH_TOKEN/);
  });
});
