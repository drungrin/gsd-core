'use strict';
/**
 * github-sync-gh.cts — the single seam that spawns `gh` for the github-sync
 * capability (D-02). Every `gh` invocation in this capability, present and
 * future, goes through `execGh`; no other module spawns a process directly.
 *
 * `execGh` wraps `execTool()` from `shell-command-projection.cts` — the same
 * bounded-timeout, array-argv, never-throw seam `graphify.cts`'s
 * `execGraphify` already uses for a different binary. Arguments are always
 * passed as an array (never string-concatenated, never shell-interpreted),
 * so there is no shell-metacharacter injection surface (T-1-02).
 */

import { execTool } from './shell-command-projection.cjs';

/**
 * Frozen enum of typed reason codes for execGh outcomes, modeled on
 * GRAPHIFY_REASON in src/graphify.cts (#2974). Tests assert on
 * result.reason instead of grepping stderr text.
 */
const GH_REASON = Object.freeze({
  OK: 'ok',
  ENOENT: 'gh_not_found',
  TIMEOUT: 'gh_timed_out',
  EXIT_NONZERO: 'gh_exit_nonzero',
} as const);

type GhReason = typeof GH_REASON[keyof typeof GH_REASON];

interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  reason: GhReason;
  timeout_ms?: number;
  response?: GhResponseMetadata;
}

interface GhResponseMetadata {
  available: boolean;
  status: number | null;
  retry_after_seconds: number | null;
}

/**
 * Observed live: `gh api --include /rate_limit` on gh 2.96.0 (2026-08-01)
 * emits "HTTP/2.0 200 OK" — the protocol token carries an explicit ".0"
 * minor-version suffix that the previous pattern, which required a literal
 * space immediately after the major-version digit, never matched. This
 * pattern accepts that optional minor-version suffix so both framing shapes
 * are recognized identically; it does not relax the required space or widen
 * the 1xx-5xx code range. One shared constant drives both the two-block
 * guard and the status capture below, so both recognize the same set of
 * lines.
 */
const HTTP_STATUS_LINE = /^HTTP\/[0-9](?:\.[0-9])? ([1-5][0-9]{2})\b/;

/**
 * Accept exactly one leading HTTP response header block. The CLI's --include
 * output is transport data, not operator output: callers get only allowlisted
 * metadata and retain raw output solely inside the transport seam.
 */
function splitIncludedResponse(stdout: string): { response: GhResponseMetadata; body: string } {
  const unavailable: GhResponseMetadata = { available: false, status: null, retry_after_seconds: null };
  const separator = stdout.match(/\r?\n\r?\n/);
  if (!separator || separator.index === undefined) return { response: unavailable, body: stdout };

  const headerBlock = stdout.slice(0, separator.index);
  const bodyStart = separator.index + separator[0].length;
  if (HTTP_STATUS_LINE.test(stdout.slice(bodyStart))) return { response: unavailable, body: stdout };
  const lines = headerBlock.split(/\r?\n/);
  const statusMatch = HTTP_STATUS_LINE.exec(lines[0] ?? '');
  if (!statusMatch) return { response: unavailable, body: stdout };

  const retryAfterValues = lines
    .slice(1)
    .filter((line) => /^retry-after:/i.test(line))
    .map((line) => line.slice(line.indexOf(':') + 1).trim());
  if (retryAfterValues.length > 1) return { response: unavailable, body: stdout };

  const retryAfter = retryAfterValues[0];
  if (retryAfter !== undefined && !/^[0-9]+$/.test(retryAfter)) return { response: unavailable, body: stdout };

  return {
    response: {
      available: true,
      status: Number(statusMatch[1]),
      retry_after_seconds: retryAfter === undefined ? null : Number(retryAfter),
    },
    body: stdout.slice(bodyStart),
  };
}

function parseIncludedResponse(stdout: string): GhResponseMetadata {
  return splitIncludedResponse(stdout).response;
}

/**
 * Spawn `gh` with the given argument array and a bounded timeout (default
 * 15s — long enough for a single `gh api graphql` round trip, short enough
 * that a stalled call never hangs the loop per SAFE-01/T-1-03).
 *
 * Maps `execTool`'s structured result onto a typed GhResult and never
 * throws: ENOENT (missing binary) maps to the ENOENT reason, a SIGTERM
 * signal (execTool's timeout kill) maps exit code 124 to the TIMEOUT
 * reason and records the requested timeout in `timeout_ms`, a zero exit
 * maps to OK, and anything else maps to EXIT_NONZERO with stdout/stderr
 * preserved verbatim.
 */
function execGh(args: string[], opts: { cwd?: string; timeout?: number; includeHeaders?: boolean } = {}): GhResult {
  const timeout = opts.timeout ?? 15000;
  const invocationArgs = opts.includeHeaders && !args.includes('--include') ? [...args, '--include'] : args;
  const result = execTool('gh', invocationArgs, { cwd: opts.cwd, timeout });
  const included = opts.includeHeaders ? splitIncludedResponse(result.stdout) : undefined;

  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    return {
      exitCode: 127,
      stdout: included?.body ?? result.stdout,
      stderr: result.stderr,
      reason: GH_REASON.ENOENT,
      ...(included ? { response: included.response } : {}),
    };
  }

  if (result.signal === 'SIGTERM') {
    return {
      exitCode: 124,
      stdout: included?.body ?? result.stdout,
      stderr: result.stderr,
      reason: GH_REASON.TIMEOUT,
      timeout_ms: timeout,
      ...(included ? { response: included.response } : {}),
    };
  }

  return {
    exitCode: result.exitCode,
    stdout: included?.body ?? result.stdout,
    stderr: result.stderr,
    reason: result.exitCode === 0 ? GH_REASON.OK : GH_REASON.EXIT_NONZERO,
    ...(included ? { response: included.response } : {}),
  };
}

/**
 * D-09/AUTH-02: probe a project-scoped GraphQL field, not merely token
 * existence. Only a `project`-scoped token can answer `viewer { projectsV2 }`
 * — a token that exists but lacks the scope is caught here, before any
 * mutation is ever attempted.
 */
function probeProjectsV2Scope(cwd: string): GhResult {
  return execGh(
    ['api', 'graphql', '-f', 'query=query { viewer { projectsV2(first: 1) { totalCount } } }'],
    { cwd },
  );
}

export = {
  execGh,
  probeProjectsV2Scope,
  GH_REASON,
};
