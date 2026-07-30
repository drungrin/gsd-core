'use strict';
/**
 * github-sync-command-router.cts — CLI subcommand dispatcher for
 * `gsd-tools github-sync`.
 *
 * Modeled on `src/graphify-command-router.cts` (router-calls-Hub shape),
 * with one deliberate deviation (D-06): the `github_sync.enabled` gate is
 * the literal first statement of the function body, before
 * `routeHubCommandFamily` is even called and before `args[1]` is inspected
 * at all. This is stricter than graphify's per-handler gate — it satisfies
 * CAP-02's "including `init`" requirement structurally: an unrecognized
 * subcommand string (including the literal `'init'`, unregistered until a
 * later phase) still hits the disabled no-op path instead of falling
 * through to the Hub's "unknown subcommand" error.
 *
 * Test seam: pass `_isCapabilityActive` / `_auth` in the options object to
 * inject recording mocks instead of the real modules. The `_`-prefix
 * follows the repo's established seam convention (see `_graphify` in
 * `graphify-command-router.cts`). Production callers omit both.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import capabilityStateMod = require('./capability-state.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import authMod = require('./github-sync-auth.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');

const { isCapabilityActive } = capabilityStateMod;
const { output } = io;
const { routeHubCommandFamily } = cjsCommandRouterAdapter;
const { PREFLIGHT_REASON } = authMod;

// ─── WR-03: D-11 local containment literals ────────────────────────────────
//
// Fixed, reviewed catalog literals — never a template interpolation, never
// `String(...)` of anything caught. Both catch blocks below are binding-less
// (`catch {`, no parameter), so the thrown value is never in scope and cannot
// be interpolated into either message; the no-leak property holds by
// construction rather than by review (T-1-14).
//
// Distinguishable from the ordinary disabled message on purpose: the ordinary
// message names `github_sync.enabled` and tells the developer to flip a
// config key. This one must not send a developer chasing a config key that is
// already correct when the real fault is that capability-state resolution
// itself threw (T-1-16).
const CAPABILITY_STATE_UNAVAILABLE_MESSAGE =
  'github-sync: could not determine whether the capability is enabled — ' +
  'treating github-sync as inactive for safety. Re-run once the underlying ' +
  'fault is resolved.';

// Reuses the existing `outage` reason (github-sync-auth.cts documents it as
// the safe defensive default for every unrecognized non-zero failure) rather
// than minting a new PREFLIGHT_REASON member — an unexpected throw is exactly
// that case, and minting a member would expand the published reason catalog
// for no benefit.
const PREFLIGHT_UNAVAILABLE_MESSAGE =
  'github-sync preflight: the preflight check could not complete due to an ' +
  'unexpected internal error. Retry `gsd-tools github-sync preflight` shortly.';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PreflightResult {
  ok: boolean;
  reason: string;
  message: string;
}

interface AuthModule {
  runPreflight(cwd: string): PreflightResult;
}

interface RouteGithubSyncCommandRouterOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
  /** Test seam: inject a mock isCapabilityActive. Defaults to the real function. */
  _isCapabilityActive?: typeof isCapabilityActive;
  /** Test seam: inject a mock auth module. Defaults to the real module. */
  _auth?: AuthModule;
}

// ─── Implementation ───────────────────────────────────────────────────────────

function routeGithubSyncCommandRouter({
  args,
  cwd,
  raw,
  error,
  _isCapabilityActive,
  _auth,
}: RouteGithubSyncCommandRouterOptions): void {
  const activeCheck = _isCapabilityActive ?? isCapabilityActive;

  // D-06: gate BEFORE any subcommand lookup — args[1] is never inspected
  // above this line, and routeHubCommandFamily is never called when disabled.
  //
  // WR-03: activeCheck(...) is not known to throw today, but nothing upstream
  // (capability-loader.cjs's loadRegistry) is under this module's control. A
  // throw here is contained locally rather than left to propagate to
  // command-routing-hub.cjs's dispatch(), which would convert it into a
  // HandlerFailure and set a non-zero exit code (D-11/SAFE-01 violation).
  let isActive: boolean;
  let capabilityStateUnavailable = false;
  try {
    isActive = activeCheck('github-sync', cwd);
  } catch {
    isActive = false;
    capabilityStateUnavailable = true;
  }

  if (!isActive) {
    // D-04 amendment: ordinary disabled commands are a completely silent
    // family-entry no-op. The exceptional resolution failure remains an
    // actionable SAFE-01 containment path, distinct from disabled state.
    if (capabilityStateUnavailable) process.stderr.write(CAPABILITY_STATE_UNAVAILABLE_MESSAGE + '\n');
    return; // Nothing is thrown on this path: process.exitCode stays 0 (D-04/D-11).
  }

  const auth: AuthModule = _auth ?? authMod;

  routeHubCommandFamily({
    family: 'github-sync',
    args,
    subcommands: ['preflight'],
    handlers: {
      preflight: () => {
        // WR-03: auth.runPreflight(cwd) is documented not to throw
        // (github-sync-auth.cts's own header), but containing it locally
        // means the D-11 exit-0 contract no longer rests on that module
        // continuing not to throw. The result is constructed locally on a
        // throw so the untouched lines below (stderr write + output()) carry
        // the same exit-0/JSON-shape contract that an ordinary preflight
        // failure carries.
        let result: PreflightResult;
        try {
          result = auth.runPreflight(cwd);
        } catch {
          result = {
            ok: false,
            reason: PREFLIGHT_REASON.OUTAGE,
            message: PREFLIGHT_UNAVAILABLE_MESSAGE,
          };
        }
        if (!result.ok) {
          process.stderr.write(result.message + '\n');
        }
        output(result, raw);
      },
    },
    unknownMessage: (subcommand: string, available: string[]) =>
      `Unknown github-sync subcommand. Available: ${available.join(', ')}`,
    error,
    cwd,
    raw,
  });
}

export = {
  routeGithubSyncCommandRouter,
};
