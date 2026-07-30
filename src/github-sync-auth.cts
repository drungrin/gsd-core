'use strict';
/**
 * github-sync-auth.cts — the auth preflight (D-02): runs the D-09 scope
 * probe via the `github-sync-gh.cts` seam, classifies the result, and
 * returns a structured `PreflightResult`.
 *
 * D-11/SAFE-01: this module never throws. Every failure — missing `gh`
 * binary, no token, wrong scope, GitHub outage, rate limit — collapses to
 * a structured `{ ok: false, reason, message }` with a fixed, actionable
 * message.
 *
 * Every message is composed only from catalog literals — never from
 * interpolated raw `gh` stdout/stderr — so a GraphQL error payload can
 * never leak into a message shown to a developer or CI log (T-1-06).
 *
 * D-10: the `wrong_scope` and `no_token` messages are selected between a
 * developer remedy (`gh auth refresh -s project`) and a CI remedy (the
 * classic PAT exported as `GH_TOKEN`) by a presence-only read of `CI`,
 * `GITHUB_ACTIONS`, `GH_TOKEN` and `GITHUB_TOKEN` — never the value itself
 * (T-1-07). Per 01-RESEARCH.md Pitfall 3, the CI remedy never suggests
 * adjusting a workflow permissions block: the default Actions token cannot
 * reach Projects v2 under any permissions combination.
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

/**
 * Fixed, reviewed catalog literals. Never built by interpolating any value
 * that originated in a `gh` response — see the module header (T-1-06).
 */
const DEVELOPER_WRONG_SCOPE_MESSAGE =
  'github-sync preflight: your GitHub token is missing the `project` scope. Run ' +
  '`gh auth refresh -s project`, then re-run `gsd-tools github-sync preflight`.';

const CI_SCOPE_REMEDY_MESSAGE =
  'github-sync preflight: this token cannot reach GitHub Projects v2. Export a classic ' +
  'personal access token with the `project` scope as `GH_TOKEN` in this CI environment — ' +
  'the default GITHUB_TOKEN cannot reach Projects v2 no matter how the workflow is set ' +
  'up. Then re-run `gsd-tools github-sync preflight`.';

const DEVELOPER_NO_TOKEN_MESSAGE =
  'github-sync preflight: no valid GitHub credentials were found. Authenticate with ' +
  '`gh auth login`, then re-run `gsd-tools github-sync preflight`.';

/**
 * `gh`'s own `exitAuthError` exit code, raised before any HTTP request is
 * issued whenever no credentials are configured at all — which is why the
 * no-credentials path never produces an HTTP status phrase for
 * `classifyGhResult`'s stderr checks to match. Observed live against
 * `gh version 2.96.0` during plan 01-09 (REVIEW.md CR-01).
 */
const GH_AUTH_EXIT_CODE = 4;

const MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  [PREFLIGHT_REASON.OK]:
    'github-sync preflight: connected to GitHub Projects v2 successfully.',
  [PREFLIGHT_REASON.MISSING_GH]:
    'github-sync preflight: the `gh` CLI was not found on PATH. Install it from ' +
    'https://cli.github.com, then re-run `gsd-tools github-sync preflight`.',
  [PREFLIGHT_REASON.RATE_LIMITED]:
    'github-sync preflight: GitHub is rate-limiting this token right now. Wait a few ' +
    'minutes, then retry `gsd-tools github-sync preflight`.',
  [PREFLIGHT_REASON.OUTAGE]:
    'github-sync preflight: GitHub appears to be experiencing a transient failure. ' +
    'Retry `gsd-tools github-sync preflight` shortly; check ' +
    'https://www.githubstatus.com if the problem persists.',
  [PREFLIGHT_REASON.SSO_OR_NULL_PAYLOAD]:
    'github-sync preflight: GitHub returned no usable data — this usually means your ' +
    'token needs SSO authorization for this organization. Authorize the token for SSO ' +
    'at https://github.com/settings/tokens, then retry.',
});

/**
 * Returns true when `stdout` is parseable JSON whose top-level shape carries
 * an unambiguous successful Projects v2 response envelope.
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
  const envelope = parsed as { data?: unknown; errors?: unknown };
  if (envelope.errors !== undefined && (!Array.isArray(envelope.errors) || envelope.errors.length > 0)) return false;
  const data = envelope.data;
  if (data === null || typeof data !== 'object') return false;
  const viewer = (data as { viewer?: unknown }).viewer;
  if (viewer === null || typeof viewer !== 'object') return false;
  const projectsV2 = (viewer as { projectsV2?: unknown }).projectsV2;
  if (projectsV2 === null || typeof projectsV2 !== 'object') return false;
  const totalCount = (projectsV2 as { totalCount?: unknown }).totalCount;
  return typeof totalCount === 'number' && Number.isFinite(totalCount);
}

/**
 * Classify a structured `GhResult` into one of `PREFLIGHT_REASON`'s seven
 * members. Pure: no I/O, no environment reads, no side effects.
 *
 * Precedence is fixed and documented (Pitfall 2, 01-RESEARCH.md): missing
 * binary, then timeout, then wrong scope, then no token, then rate limited,
 * then outage. Evaluated in that exact order so a response matching more
 * than one signal (e.g. both the auth exit code and a required-scopes
 * phrase) always resolves the same way, and repeated calls on identical
 * input always return an identical reason. In particular, a result carrying
 * both `GH_AUTH_EXIT_CODE` and a required-scopes phrase still resolves
 * `wrong_scope` — the AUTH-01 `gh auth refresh -s project` remedy is not
 * captured by the `no_token` branch below it.
 *
 * GitHub's scope-error text is community-observed, not a documented
 * contract — stderr signals are matched as case-insensitive substrings
 * only, never as an anchored or exact-equality comparison, so an
 * unrecognized failure falls through to the `outage` defensive default
 * rather than being mistaken for `ok`.
 *
 * Plan 01-09 (REVIEW.md CR-01): the `no_token` branch has two independently
 * sufficient signals, because the two failure states it covers carry
 * *different* exit codes. `GH_AUTH_EXIT_CODE` is the primary signal for the
 * no-credentials case — `gh` never issues an HTTP request in that state, so
 * no stderr phrase is guaranteed, and the exit code alone is trusted. The
 * stderr phrases remain a backstop for the invalid-token case, which exits
 * 1 (not the auth exit code) and therefore reaches `no_token` only through
 * the phrase match. This does not touch the deferred WR-01(current)
 * SAML/403 gap: those shapes exit 1 and carry neither recognized phrase, so
 * they continue to fall through to the `outage` default exactly as before.
 */
function classifyGhResult(result: GhResult): string {
  if (result.reason === ghMod.GH_REASON.ENOENT) return PREFLIGHT_REASON.MISSING_GH;
  if (result.reason === ghMod.GH_REASON.TIMEOUT) return PREFLIGHT_REASON.OUTAGE;

  if (result.exitCode === 0) {
    return isSuccessfulGraphqlResponse(result.stdout)
      ? PREFLIGHT_REASON.OK
      : PREFLIGHT_REASON.SSO_OR_NULL_PAYLOAD;
  }

  const stderr = (result.stderr || '').toLowerCase();

  if (stderr.includes('required scopes') || stderr.includes('not been granted')) {
    return PREFLIGHT_REASON.WRONG_SCOPE;
  }

  if (
    result.exitCode === GH_AUTH_EXIT_CODE ||
    stderr.includes('bad credentials') ||
    stderr.includes('401') ||
    stderr.includes('gh auth login') ||
    stderr.includes('authentication token')
  ) {
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
 * D-10: presence-only environment signal deciding which remedy to show.
 * True when any of `CI`, `GITHUB_ACTIONS`, `GH_TOKEN` or `GITHUB_TOKEN` is
 * present in `env` with a non-empty value — an empty-valued variable counts
 * as absent. Reads presence and emptiness only: never the value, never a
 * length beyond the empty check, never a hash, never a log (T-1-07).
 */
function hasCiOrTokenEnvSignal(env: NodeJS.ProcessEnv): boolean {
  return ['CI', 'GITHUB_ACTIONS', 'GH_TOKEN', 'GITHUB_TOKEN'].some((key) => {
    const value = env[key];
    return typeof value === 'string' && value.length > 0;
  });
}

/**
 * Select the fixed, reviewed message for `reason` given the environment.
 * Pure: the environment is injected as a parameter so tests never mutate
 * `process.env`. Composed only from catalog literals — never from a `gh`
 * response value. Total: returns a non-empty string for every
 * `PREFLIGHT_REASON` member, including `ok`.
 */
function selectPreflightMessage(reason: string, env: NodeJS.ProcessEnv): string {
  const ciSignal = hasCiOrTokenEnvSignal(env);

  if (reason === PREFLIGHT_REASON.WRONG_SCOPE) {
    return ciSignal ? CI_SCOPE_REMEDY_MESSAGE : DEVELOPER_WRONG_SCOPE_MESSAGE;
  }

  if (reason === PREFLIGHT_REASON.NO_TOKEN) {
    return ciSignal ? CI_SCOPE_REMEDY_MESSAGE : DEVELOPER_NO_TOKEN_MESSAGE;
  }

  return MESSAGES[reason] ?? MESSAGES[PREFLIGHT_REASON.OUTAGE];
}

/**
 * D-12: the once-per-process probe cache. This is the single documented
 * exception to the project's no-module-level-mutable-state rule (per
 * active-workstream-store.cts's cachedControllingTtyToken /
 * didProbeControllingTtyToken shape): a sync run pays one extra `gh` API
 * call regardless of how many mutations follow, nothing is ever persisted
 * to disk, and a fresh process invocation always re-probes so a token
 * fixed between runs is picked up immediately. The two-variable shape
 * (rather than a single nullable slot) means a cached falsy/failure
 * result is still recognized as cached, not re-probed as if unset.
 */
let _cachedPreflightResult: PreflightResult | undefined;
let _didProbePreflight = false;

/** Test-only seam: clear the memoized once-per-process preflight cache (D-12). */
function _resetPreflightCacheForTests(): void {
  _cachedPreflightResult = undefined;
  _didProbePreflight = false;
}

/**
 * Run the auth preflight: probe `projectsV2` (AUTH-02), classify the
 * result, and select an actionable message. Never throws; `ok` is false
 * with a populated `reason` and `message` for every non-`ok` reason, which
 * is what makes the router's universal exit-0 contract (D-11) hold end to
 * end.
 *
 * The probe runs at most once per process (D-12): a cached result,
 * including a cached failure, is returned unchanged on every subsequent
 * call until `_resetPreflightCacheForTests()` clears it.
 */
function runPreflight(cwd: string, opts: { _gh?: GhModule } = {}): PreflightResult {
  if (_didProbePreflight && _cachedPreflightResult !== undefined) {
    return _cachedPreflightResult;
  }

  const gh: GhModule = opts._gh ?? ghMod;
  const result = gh.probeProjectsV2Scope(cwd);
  const reason = classifyGhResult(result);
  const message = selectPreflightMessage(reason, process.env);
  const preflightResult: PreflightResult = { ok: reason === PREFLIGHT_REASON.OK, reason, message };

  _didProbePreflight = true;
  _cachedPreflightResult = preflightResult;

  return preflightResult;
}

export = {
  runPreflight,
  classifyGhResult,
  selectPreflightMessage,
  PREFLIGHT_REASON,
  _resetPreflightCacheForTests,
};
