'use strict';
/**
 * github-sync-auth.cts — the auth preflight (D-02): runs the D-09 scope
 * probe via the `github-sync-gh.cts` seam, classifies the result, and
 * returns a structured `PreflightResult`.
 *
 * D-11/SAFE-01: this module never throws. Every failure — missing `gh`
 * binary, no token, wrong scope, GitHub outage, rate limit — collapses to
 * a structured `{ ok: false, reason, message }` with a fixed, actionable
 * message. Task 1 implements only the two-way split the tracer's
 * `<verify>` proves (missing_gh vs. everything-else); the five-way
 * classification (no_token / wrong_scope / outage / rate_limited) lands in
 * plan 01-02 and expands the `preflight_failed` branch below without
 * touching this shape.
 *
 * Every message is composed from a fixed string this module owns — never
 * from interpolated raw `gh` stdout/stderr — so a GraphQL error payload can
 * never leak into a message shown to a developer or CI log.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import ghMod = require('./github-sync-gh.cjs');

interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  error: Error | null;
}

interface GhModule {
  probeProjectsV2Scope(cwd: string): GhResult;
}

interface PreflightResult {
  ok: boolean;
  reason: string;
  message: string;
}

const MESSAGES = {
  MISSING_GH:
    'github-sync preflight: the `gh` CLI was not found on PATH. Install it from ' +
    'https://cli.github.com, then re-run `gsd-tools github-sync preflight`.',
  PREFLIGHT_FAILED:
    'github-sync preflight failed — the GitHub Projects v2 probe did not succeed. ' +
    'Run `gh auth status` to check your GitHub CLI authentication and scopes, then ' +
    'retry `gsd-tools github-sync preflight`.',
} as const;

/**
 * Returns true when `stdout` is parseable JSON whose top-level shape carries
 * a non-null `data` object — the successful GraphQL response envelope.
 * Never throws on malformed/null input (the SSO-null defensive-design
 * ruling): an unparseable or `null` payload is reported as a failure
 * reason, never dereferenced.
 */
function isSuccessfulGraphqlResponse(stdout: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object') return false;
  const data = (parsed as { data?: unknown }).data;
  return data !== null && typeof data === 'object';
}

/**
 * Run the auth preflight: probe `projectsV2` (AUTH-02) and classify the
 * result. Never throws.
 */
function runPreflight(cwd: string, opts: { _gh?: GhModule } = {}): PreflightResult {
  const gh: GhModule = opts._gh ?? ghMod;
  const result = gh.probeProjectsV2Scope(cwd);

  if (result.exitCode === 127) {
    return { ok: false, reason: 'missing_gh', message: MESSAGES.MISSING_GH };
  }

  if (result.exitCode === 0 && isSuccessfulGraphqlResponse(result.stdout)) {
    return { ok: true, reason: 'ok', message: '' };
  }

  return { ok: false, reason: 'preflight_failed', message: MESSAGES.PREFLIGHT_FAILED };
}

export = {
  runPreflight,
};
