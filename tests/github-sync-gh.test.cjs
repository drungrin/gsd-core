'use strict';

/**
 * github-sync-gh.test.cjs — execGh seam coverage (Phase 1, plan 01-01, Task 2).
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
      mock.method(childProcess, 'spawnSync', () => ({
        status: 0,
        stdout: fixture.stdout,
        stderr: '',
        error: undefined,
        signal: null,
      }));

      const result = execGh(['api', '--include', '/rate_limit'], { includeHeaders: true });
      assert.deepStrictEqual(result.response, {
        available: fixture.status !== null,
        status: fixture.status,
        retry_after_seconds: fixture.retry_after_seconds,
      });
    });
  }

  test('include-header parsing remains opt-in and does not alter normal body stdout', () => {
    const fixture = headerFraming.cases['header-present'];
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
    const fixture = headerFraming.cases['retry-after'];
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
