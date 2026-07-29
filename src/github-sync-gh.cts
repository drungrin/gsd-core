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

interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  error: Error | null;
}

/**
 * Spawn `gh` with the given argument array and a bounded timeout (default
 * 15s — long enough for a single `gh api graphql` round trip, short enough
 * that a stalled call never hangs the loop per SAFE-01/T-1-03).
 *
 * Returns `execTool`'s structured result unchanged in shape — never throws.
 */
function execGh(args: string[], opts: { cwd?: string; timeout?: number } = {}): GhResult {
  return execTool('gh', args, { cwd: opts.cwd, timeout: opts.timeout ?? 15000 });
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
};
