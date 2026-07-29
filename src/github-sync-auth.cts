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
  reason: string;
  timeout_ms?: number;
}

interface GhModule {
  probeProjectsV2Scope(cwd: string): GhResult;
}

interface PreflightResult {
  ok: boolean;
  reason: string;
  message: string;
}

/**
 * Frozen enum of typed preflight classification reasons, modeled on
 * GRAPHIFY_REASON in src/graphify.cts (#2974). Tests assert on the returned
 * reason constant, never on message text.
 */
const PREFLIGHT_REASON = Object.freeze({
  OK: 'ok',
  MISSING_GH: 'missing_gh',
  NO_TOKEN: 'no_token',
  WRONG_SCOPE: 'wrong_scope',
  OUTAGE: 'outage',
  RATE_LIMITED: 'rate_limited',
  SSO_OR_NULL_PAYLOAD: 'sso_or_null_payload',
} as const);

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
 * Classify a structured `GhResult` into one of `PREFLIGHT_REASON`'s seven
 * members. Pure: no I/O, no environment reads, no side effects.
 *
 * Precedence is fixed and documented (Pitfall 2, 01-RESEARCH.md): missing
 * binary, then timeout, then wrong scope, then no token, then rate limited,
 * then outage. Evaluated in that exact order so a response matching more
 * than one signal (e.g. both a rate-limit phrase and a required-scopes
 * phrase) always resolves the same way, and repeated calls on identical
 * input always return an identical reason.
 *
 * GitHub's scope-error text is community-observed, not a documented
 * contract — stderr signals are matched as case-insensitive substrings
 * only, never as an anchored or exact-equality comparison, so an
 * unrecognized failure falls through to the `outage` defensive default
 * rather than being mistaken for `ok`.
 */
function classifyGhResult(result: GhResult): string {
  if (result.reason === 'gh_not_found') return PREFLIGHT_REASON.MISSING_GH;
  if (result.reason === 'gh_timed_out') return PREFLIGHT_REASON.OUTAGE;

  if (result.exitCode === 0) {
    return isSuccessfulGraphqlResponse(result.stdout)
      ? PREFLIGHT_REASON.OK
      : PREFLIGHT_REASON.SSO_OR_NULL_PAYLOAD;
  }

  const stderr = (result.stderr || '').toLowerCase();

  if (stderr.includes('required scopes') || stderr.includes('not been granted')) {
    return PREFLIGHT_REASON.WRONG_SCOPE;
  }

  if (stderr.includes('bad credentials') || stderr.includes('401')) {
    return PREFLIGHT_REASON.NO_TOKEN;
  }

  if (stderr.includes('rate limit')) {
    return PREFLIGHT_REASON.RATE_LIMITED;
  }

  // HTTP 5xx / bad gateway / service unavailability, and every other
  // unrecognized non-zero failure, land here — the safe defensive default.
  return PREFLIGHT_REASON.OUTAGE;
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
  classifyGhResult,
  PREFLIGHT_REASON,
};
