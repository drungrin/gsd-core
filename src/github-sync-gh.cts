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
function execGh(args: string[], opts: { cwd?: string; timeout?: number } = {}): GhResult {
  const timeout = opts.timeout ?? 15000;
  const result = execTool('gh', args, { cwd: opts.cwd, timeout });

  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    return { exitCode: 127, stdout: result.stdout, stderr: result.stderr, reason: GH_REASON.ENOENT };
  }

  if (result.signal === 'SIGTERM') {
    return {
      exitCode: 124,
      stdout: result.stdout,
      stderr: result.stderr,
      reason: GH_REASON.TIMEOUT,
      timeout_ms: timeout,
    };
  }

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    reason: result.exitCode === 0 ? GH_REASON.OK : GH_REASON.EXIT_NONZERO,
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
