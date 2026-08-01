'use strict';

/**
 * github-sync-gh.test.cjs — execGh seam coverage (Phase 1, plan 01-01, Task 2;
 * status-line widening, Phase 3, plan 03-01, Task 2).
 *
 * Mirrors tests/graphify.test.cjs's execGraphify describe block: mock.method on
 * childProcess.spawnSync with mock.restoreAll() cleanup, asserting on the typed
 * `reason` field (GH_REASON) rather than grepping stderr text (#2974 precedent).
 */

const { describe, test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const { execGh, probeProjectsV2Scope, GH_REASON } = require('../gsd-core/bin/lib/github-sync-gh.cjs');

const headerFraming = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/github-sync/header-framing.json'), 'utf8'),
);

/**
 * Mirrors src/github-sync-apply.cts:100-102's isRateLimited exactly. Task 2's
 * <files> scope excludes github-sync-apply.cts, and isRateLimited is not
 * exported, so this local copy exercises the same predicate against a real
 * execGh response object without editing or importing from that module.
 */
function isRateLimited(result) {
  return result.response?.available === true &&
    (result.response.status === 429 || result.response.status === 403) &&
    typeof result.response.retry_after_seconds === 'number';
}

function runIncluded(stdout) {
  mock.method(childProcess, 'spawnSync', () => ({
    status: 0,
    stdout,
    stderr: '',
    error: undefined,
    signal: null,
  }));
  return execGh(['api', '--include', '/rate_limit'], { includeHeaders: true });
}

describe('execGh', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  test('returns reason ok and the real exit code on success', () => {
    mock.method(childProcess, 'spawnSync', () => ({
      status: 0,
      stdout: '{"data":{}}',
      stderr: '',
      error: undefined,
      signal: null,
    }));

    const result = execGh(['api', 'graphql']);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.reason, GH_REASON.OK);
    assert.strictEqual(result.stdout, '{"data":{}}');
  });

  test('ENOENT: exitCode 127, reason gh_not_found', () => {
    mock.method(childProcess, 'spawnSync', () => ({
      status: null,
      stdout: '',
      stderr: '',
      error: { code: 'ENOENT' },
      signal: null,
    }));

    const result = execGh(['api', 'graphql']);
    assert.strictEqual(result.exitCode, 127);
    assert.strictEqual(result.reason, GH_REASON.ENOENT);
  });

  test('SIGTERM: exitCode 124, reason gh_timed_out, timeout_ms equals requested timeout', () => {
    mock.method(childProcess, 'spawnSync', () => ({
      status: null,
      stdout: 'partial',
      stderr: '',
      error: undefined,
      signal: 'SIGTERM',
    }));

    const result = execGh(['api', 'graphql'], { timeout: 5000 });
    assert.strictEqual(result.exitCode, 124);
    assert.strictEqual(result.reason, GH_REASON.TIMEOUT);
    assert.strictEqual(result.timeout_ms, 5000);
  });

  test('non-zero exit, no error, no signal: reason gh_exit_nonzero, stdout/stderr preserved verbatim', () => {
    mock.method(childProcess, 'spawnSync', () => ({
      status: 1,
      stdout: 'raw stdout text',
      stderr: 'raw stderr text',
      error: undefined,
      signal: null,
    }));

    const result = execGh(['api', 'graphql']);
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.reason, GH_REASON.EXIT_NONZERO);
    assert.strictEqual(result.stdout, 'raw stdout text');
    assert.strictEqual(result.stderr, 'raw stderr text');
  });

  test('never throws for ENOENT, timeout, non-zero exit, or success', () => {
    const fixtures = [
      { status: 0, stdout: '', stderr: '', error: undefined, signal: null },
      { status: null, stdout: '', stderr: '', error: { code: 'ENOENT' }, signal: null },
      { status: null, stdout: '', stderr: '', error: undefined, signal: 'SIGTERM' },
      { status: 1, stdout: '', stderr: '', error: undefined, signal: null },
    ];
    for (const fixture of fixtures) {
      mock.method(childProcess, 'spawnSync', () => fixture);
      assert.doesNotThrow(() => execGh(['api', 'graphql']));
    }
  });

  test('captured spawnSync invocation: program is gh, args is an array, timeout is finite, no shell interpretation', () => {
    let capturedProgram;
    let capturedArgs;
    let capturedOpts;
    mock.method(childProcess, 'spawnSync', (program, args, opts) => {
      capturedProgram = program;
      capturedArgs = args;
      capturedOpts = opts;
      return { status: 0, stdout: '', stderr: '', error: undefined, signal: null };
    });

    execGh(['api', 'graphql', '-f', 'query=query { viewer { login } }']);

    assert.strictEqual(capturedProgram, 'gh');
    assert.ok(Array.isArray(capturedArgs), 'second parameter passed to spawnSync must be an array');
    assert.ok(
      typeof capturedOpts.timeout === 'number' && Number.isFinite(capturedOpts.timeout),
      `opts.timeout must be a finite number, got: ${capturedOpts.timeout}`,
    );
    assert.ok(
      capturedOpts.shell === undefined || capturedOpts.shell === false,
      `opts must not enable shell interpretation, got shell: ${capturedOpts.shell}`,
    );
    for (const arg of capturedArgs) {
      assert.ok(typeof arg === 'string', 'every argv element must be a string, not a shell-composed fragment');
    }
  });
});

describe('execGh include-header framing', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  for (const [name, fixture] of Object.entries(headerFraming.cases)) {
    test(`${name} fixture exposes only unambiguous status and numeric Retry-After metadata`, () => {
      const result = runIncluded(fixture.stdout);
      assert.deepStrictEqual(result.response, {
        available: fixture.status !== null,
        status: fixture.status,
        retry_after_seconds: fixture.retry_after_seconds,
      });
    });
  }

  test('the live HTTP/2.0 200 form (gh 2.96.0) parses available:true with the real status, and the expected value is read from the re-recorded fixture, not typed into the test', () => {
    const fixture = headerFraming.cases['live-200'];
    const result = runIncluded(fixture.stdout);
    assert.strictEqual(result.response.available, true);
    assert.strictEqual(result.response.status, fixture.status);
    // The parsed body must be everything after the blank-line separator: the
    // JSON payload, with no header bytes leaked into it.
    const separatorIndex = fixture.stdout.search(/\r?\n\r?\n/);
    const separatorMatch = /\r?\n\r?\n/.exec(fixture.stdout);
    const expectedBody = fixture.stdout.slice(separatorIndex + separatorMatch[0].length);
    assert.strictEqual(result.stdout, expectedBody);
  });

  test('the live HTTP/2.0 422 form (gh 2.96.0, duplicate-label conflict) parses available:true with status 422 — the input plan 03-05 conflict recovery needs', () => {
    const fixture = headerFraming.cases['live-422'];
    const result = runIncluded(fixture.stdout);
    assert.strictEqual(result.response.available, true);
    assert.strictEqual(result.response.status, 422);
  });

  test('the HTTP/1.1 form still parses exactly as it does today', () => {
    const fixture = headerFraming.cases['http11-200'];
    const result = runIncluded(fixture.stdout);
    assert.deepStrictEqual(result.response, { available: true, status: 200, retry_after_seconds: null });
  });

  test('a 429 in the real HTTP/2.0 form with a numeric Retry-After parses the retry value, and isRateLimited returns true for that result', () => {
    const fixture = headerFraming.cases['retry-after-429'];
    const result = runIncluded(fixture.stdout);
    assert.strictEqual(result.response.available, true);
    assert.strictEqual(result.response.status, 429);
    assert.strictEqual(result.response.retry_after_seconds, 17);
    assert.strictEqual(isRateLimited(result), true);
  });

  test('two stacked response blocks still yield available:false and return stdout completely untouched', () => {
    const fixture = headerFraming.cases['stacked-blocks'];
    const result = runIncluded(fixture.stdout);
    assert.strictEqual(result.response.available, false);
    assert.strictEqual(result.stdout, fixture.stdout);
  });

  test('the header allowlist is unchanged: five additional distinctive-valued headers never leak into the returned metadata', () => {
    const fixture = headerFraming.cases['extra-headers-distinctive'];
    const result = runIncluded(fixture.stdout);

    assert.deepStrictEqual(Object.keys(result.response).sort(), ['available', 'retry_after_seconds', 'status'].sort());

    const headerBlock = fixture.stdout.slice(0, fixture.stdout.search(/\r?\n\r?\n/));
    const headerLines = headerBlock.split(/\r?\n/).slice(1); // drop the status line itself
    assert.strictEqual(headerLines.length, 5, 'fixture must carry exactly five additional headers');
    const serialized = JSON.stringify(result.response);
    for (const line of headerLines) {
      const colonIndex = line.indexOf(':');
      const name = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      assert.ok(!serialized.includes(value), `header value for "${name}" (${value}) must not appear in the returned metadata`);
    }
  });

  test('include-header parsing remains opt-in and does not alter normal body stdout', () => {
    const fixture = headerFraming.cases['live-200'];
    mock.method(childProcess, 'spawnSync', () => ({
      status: 0,
      stdout: fixture.stdout,
      stderr: '',
      error: undefined,
      signal: null,
    }));

    const result = execGh(['api', '/rate_limit']);
    assert.strictEqual(result.response, undefined);
    assert.strictEqual(result.stdout, fixture.stdout);
  });

  test('includeHeaders requests one header block and returns body-only JSON to GraphQL consumers', () => {
    let capturedArgs;
    const fixture = headerFraming.cases['retry-after-429'];
    mock.method(childProcess, 'spawnSync', (_program, args) => {
      capturedArgs = args;
      return { status: 1, stdout: fixture.stdout, stderr: '', error: undefined, signal: null };
    });

    const result = execGh(['api', 'graphql', '--include'], { includeHeaders: true });
    assert.equal(capturedArgs.filter((arg) => arg === '--include').length, 1);
    assert.equal(result.stdout, '{"data":{}}');
    assert.deepEqual(result.response, { available: true, status: 429, retry_after_seconds: 17 });
  });
});

describe('probeProjectsV2Scope', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  test('args mention projectsV2 as a single -f query= element (AUTH-02: project-scoped, not just token existence)', () => {
    let capturedArgs;
    mock.method(childProcess, 'spawnSync', (_program, args) => {
      capturedArgs = args;
      return { status: 0, stdout: '{"data":{}}', stderr: '', error: undefined, signal: null };
    });

    probeProjectsV2Scope('/tmp');

    assert.ok(Array.isArray(capturedArgs));
    assert.ok(capturedArgs.includes('api'));
    assert.ok(capturedArgs.includes('graphql'));
    assert.ok(capturedArgs.includes('-f'));
    const queryArg = capturedArgs.find((a) => typeof a === 'string' && a.startsWith('query='));
    assert.ok(queryArg, `expected one arg starting "query=", got: ${JSON.stringify(capturedArgs)}`);
    assert.ok(queryArg.includes('projectsV2'), `query text must mention projectsV2, got: ${queryArg}`);
  });
});
