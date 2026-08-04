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
import desiredMod = require('./github-sync-desired.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import remoteMod = require('./github-sync-remote.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import mapMod = require('./github-sync-map.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import reconcileMod = require('./github-sync-reconcile.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import statusMod = require('./github-sync-status.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import applyMod = require('./github-sync-apply.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import issueUpdateMod = require('./github-sync-issue-update.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import targetMod = require('./github-sync-target.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import bootstrapRemoteMod = require('./github-sync-bootstrap-remote.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import bootstrapPlanMod = require('./github-sync-bootstrap-plan.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import bootstrapConfigMod = require('./github-sync-bootstrap-config.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import bootstrapReportMod = require('./github-sync-bootstrap-report.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import existenceMod = require('./github-sync-existence.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import clockMod = require('./clock.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import operationMod = require('./github-sync-operation.cjs');
import type { OperationOutcome } from './github-sync-operation.cts';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');

const { isCapabilityActive } = capabilityStateMod;
const { output } = io;
const { routeHubCommandFamily } = cjsCommandRouterAdapter;
const { PREFLIGHT_REASON } = authMod;
const { mutatedKeys } = operationMod;

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

interface DesiredModule { readDesiredState(cwd: string): unknown; }
interface RemoteModule { readRemoteSnapshot(options: { cwd: string; owner: string; repo: string; repositoryNumber: number; projectNumber: number; issueNodeIdHints?: number[] }): unknown; }
/**
 * Plan 07-01: widened beyond the read-only surface `status`/`sync` already
 * used — `recordCompletion`/`writeSyncMapAtomically`/`mergeCompletion` are
 * the durable-write half of D-08's absence marker, called only from `sync`
 * (never `status` — T-07-04, pinned by plan 07-01 Task 2's dry-run test).
 */
interface MapModule {
  readSyncMapStrict(cwd: string, repository: { owner: string; repo: string; number: number }): unknown;
  recordCompletion(current: unknown, completion: unknown): unknown;
  writeSyncMapAtomically(cwd: string, map: unknown): void;
  mergeCompletion(previous: unknown, next: unknown, options?: { clear?: string[] }): unknown;
}
interface ReconcileModule { planReconciliation(desired: unknown, remote: unknown, map: unknown): unknown; }
interface StatusModule { buildStatusV1(remote: unknown, plan: unknown): unknown; renderStatusV1(status: unknown, raw: boolean): string; }
interface ApplyModule { applyMutationPlan(plan: unknown, options: { cwd: string; map: unknown }): unknown; }
/** Plan 04-04 Task 3: the read-splice-write preparation stage `sync` (never `status`) runs between planning and applying. */
interface IssueUpdateModule {
  prepareIssueUpdates(pending: unknown[], adapters: { cwd: string }): { operations: unknown[]; reports: unknown[] };
}
interface TargetReadResult { available: boolean; reason?: string; field?: string; target?: { owner: string; repo: string; repositoryNumber: number; projectNumber: number }; }
interface TargetModule { readSyncTarget(cwd: string): TargetReadResult; }

interface BootstrapRemoteModule {
  readBootstrapRemoteState(options: { cwd: string; owner: string; repo: string; projectNumber: number | null; execGh?: unknown }): unknown;
}
interface BootstrapPlanStageResult {
  operations: unknown[];
  checkpoints: unknown[];
  noops: Array<{ reason: string }>;
  blocked: Array<{ reason: string; detail?: string }>;
  uncertain: Array<{ reason: string }>;
  /** 06-07 gap closure: per-item blocked entries (e.g. VIEW_FIELD_UNRESOLVED) that do NOT suppress this pass's apply — carried alongside `blocked` for the report to name. */
  partial?: Array<{ reason: string; detail?: string }>;
}
interface BootstrapPlanModule {
  planBootstrap(input: unknown, options: { pass: string }): BootstrapPlanStageResult;
  BOOTSTRAP_PASS: { STRUCTURE: string; OPTIONS: string };
  /**
   * 06-07 gap closure: fail-closed run-fatal classifier — absent on a
   * legacy/injected seam, in which case `runFatalBlockedEntries` treats
   * every blocked entry as run-fatal (today's pre-fix behavior, never
   * silently more permissive). Declared as a function-typed property, not
   * method shorthand — this member is read into a local binding by
   * `runFatalBlockedEntries` below, and it never touches `this`, so the
   * property form keeps `@typescript-eslint/unbound-method` from flagging
   * that detachment as unsafe.
   */
  isRunFatalBlockedReason?: (reason: string) => boolean;
}

interface ResolvedTargetLike { owner: string; repo: string; repositoryNumber: number; projectNumber: number | null; }
interface ResolveTargetResultLike { target: ResolvedTargetLike | null; reason: string; strictMapRead: unknown; }
interface ConfigWriteResultLike { ok: boolean; reason: string; }
interface BootstrapConfigModule {
  resolveTarget(cwd: string, options?: { execGh?: unknown }): ResolveTargetResultLike;
  readProjectTitle(cwd: string): string | null;
  /** Plan 06-04: the already-validated `github_sync.view.layout` GraphQL enum member — read once per `init` run, threaded to both `planBootstrap` passes. */
  readViewLayout(cwd: string): string;
  writeProjectNumber(cwd: string, target: { owner: string; repo: string; repositoryNumber: number }, projectNumber: number): ConfigWriteResultLike;
  RESOLVE_TARGET_REASON: { CONFIGURED: string; RESOLVED: string; UNRESOLVABLE: string };
}

interface BootstrapReportModule {
  buildInitReportV1(input: unknown): unknown;
  renderInitReportV1(report: unknown, raw: boolean): string;
}

/** Plan 07-01 (D-05/D-08/D-09): the pure existence classifier `sync` delegates to. */
interface ExistenceVerdictEntry { logicalKey: string; verdict: string; }
interface AbsenceMarkerLike { absenceCount?: number; absenceFirstSeenAt?: string; }
interface ExistenceModule {
  classifyExistence(input: { completions: Record<string, unknown>; remote: unknown; bootstrapRemote: unknown }): ExistenceVerdictEntry[];
  advanceAbsence(previous: AbsenceMarkerLike | undefined, verdict: string, nowIso?: string): AbsenceMarkerLike;
  rebuildTriggered(verdicts: ExistenceVerdictEntry[], completions: Record<string, unknown>, nowIso?: string): boolean;
  EXISTENCE_VERDICT: { PRESENT: string; CONFIRMED_ABSENT: string; UNKNOWN: string };
}

/** Plan 07-01 (D-09): the clock seam D-01's rebuild delegation and the absence gate thread `nowIso` through — never read via `Date.now()` inside a pure module. */
interface ClockLike {
  now(): number;
  nowIso(): string;
  sleep(ms: number): void;
}

// G-02-2: emitStatus() is a deliberate, local inversion of the family
// convention. Every other router in src/ passes `undefined` as io.output()'s
// third argument and lets its own `raw` flag pick JSON-vs-pretty-JSON.
// github-sync's status handler instead pre-renders its own string on BOTH
// routes — human by default per D-13, the unchanged compact v1 JSON under
// `--raw` per D-15 — via status.renderStatusV1(dto, raw), which is the single
// place left to decide human versus JSON. Because io.output() only consumes
// its third argument when its OWN second argument is true, this helper passes
// a literal `true` there: that argument now means "emit the string I already
// rendered," not "the user asked for raw." Do not change io.output() itself —
// every other caller depends on its current raw-gated semantics. The
// large-payload tmpfile spill in io.output() does not apply to this path: a
// status report is a pre-rendered string carrying logical keys and typed
// reasons only, never a multi-KB machine payload.
function emitStatus(dto: unknown, raw: boolean, statusModule: StatusModule): void {
  output(dto, true, statusModule.renderStatusV1(dto, raw));
}

/**
 * `init`'s own instance of the same G-02-2 output inversion `emitStatus`
 * establishes: the DTO is built here from whichever passes actually ran,
 * then rendered through `renderInitReportV1(dto, raw)` — the single place
 * that decides human versus JSON — and passed to `io.output()`'s
 * pre-rendered-string path. No second flag alias: the raw flag already in
 * use across this router family is the machine-readable surface for `init`
 * too.
 */
function emitInitReport(input: unknown, raw: boolean, reportModule: BootstrapReportModule): void {
  const dto = reportModule.buildInitReportV1(input);
  output(dto, true, reportModule.renderInitReportV1(dto, raw));
}

// github-sync-map.cts's header (D-05/D-07) documents `SyncCompletion.issueNumber`
// as a generic remote-number slot reused for a project number, a field's
// declared type ordinal, a status option ordinal, or a milestone number —
// none of those bootstrap completions represent a GitHub issue.
// `readRemoteSnapshot`'s issueNodeIdHints feeds straight into a per-number
// `issue(number: ...)` GraphQL lookup (github-sync-remote.cts's
// readIssueNodeIds), so passing a bootstrap completion's number there
// produces a GitHub NOT_FOUND that cascades into a full remote_unavailable/
// uncertain failure on every status/sync call once a target is bootstrapped
// (live-discovered against UAT board #9, see
// .planning/phases/04-phase-issue-sync/deferred-items.md § "Plan 04-06").
//
// Only two logicalKey shapes represent a real issue number:
//   - `issue:phase:<id>` (Phase 4 plan 04-01) — the phase issue's own
//     reserved identity.
//   - `phase:<id>` (Phase 2 plan 02-08, pre-Phase-4) — the legacy
//     project-item completion; github-sync-reconcile.cts's
//     `resolvedIssueNodeId` still resolves these against issueNodeIdHints
//     for a not-yet-migrated map (its per-phase decision order, case 3).
// Every bootstrap completion (`project`, `project-link`, `field:<slug>`,
// `option:status:<slug>`, `label:<slug>`, `milestone:<version>`) falls
// outside both prefixes, so this is an explicit allow-list of
// issue-representing keys rather than a denylist of bootstrap prefixes — a
// future bootstrap key added to that catalog is excluded by construction,
// not because someone remembered to add it to a denylist.
function isIssueBearingLogicalKey(logicalKey: string): boolean {
  return logicalKey.startsWith('issue:') || logicalKey.startsWith('phase:');
}

function collectIssueNodeIdHints(strictMap: unknown): number[] {
  if (strictMap === null || typeof strictMap !== 'object' || (strictMap as { kind?: unknown }).kind !== 'valid') return [];
  const completions = (strictMap as { map?: { completions?: Record<string, { logicalKey?: unknown; issueNumber?: unknown }> } }).map?.completions;
  if (!completions || typeof completions !== 'object') return [];
  // The object key is the authoritative logical key (github-sync-map.cts's
  // isSyncMap validates `completion.logicalKey === <object key>` as an
  // invariant for every completion in a `kind: 'valid'` map, and the rest of
  // this module reads completions by object key), so Object.entries reads
  // it from there rather than trusting the completion's own copy.
  const hints = Object.entries(completions)
    .filter(([logicalKey]) => isIssueBearingLogicalKey(logicalKey))
    .map(([, completion]) => completion?.issueNumber)
    .filter((issueNumber): issueNumber is number => typeof issueNumber === 'number' && Number.isSafeInteger(issueNumber) && issueNumber > 0);
  return [...new Set(hints)].sort((left, right) => left - right);
}

/**
 * 06-07 gap closure (CR-01): returns the subset of `entries` the plan
 * module classifies run-fatal via `planModule.isRunFatalBlockedReason`, the
 * subset that must still suppress the pass's apply. When the injected
 * `planModule` carries no such member — an `_bootstrapPlan` test seam or a
 * legacy caller written before this predicate existed — every entry is
 * returned unchanged (deliberately fail-closed): the pre-fix conservative
 * behavior (any blocked entry aborts the apply) is what a caller without
 * the predicate keeps, never a new, silently more permissive default.
 */
function runFatalBlockedEntries(
  entries: Array<{ reason: string; detail?: string }>,
  planModule: BootstrapPlanModule,
): Array<{ reason: string; detail?: string }> {
  const isRunFatal = planModule.isRunFatalBlockedReason;
  if (typeof isRunFatal !== 'function') return entries;
  return entries.filter((entry) => isRunFatal(entry.reason));
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
  _desired?: DesiredModule;
  _remote?: RemoteModule;
  _map?: MapModule;
  _reconcile?: ReconcileModule;
  _status?: StatusModule;
  _apply?: ApplyModule;
  /** Test seam: inject a mock preparation-stage module. Defaults to the real module. */
  _issueUpdate?: IssueUpdateModule;
  _target?: TargetModule;
  /** Test seam: inject a mock bootstrap remote reader. Defaults to the real module. */
  _bootstrapRemote?: BootstrapRemoteModule;
  /** Test seam: inject a mock bootstrap plan composer. Defaults to the real module. */
  _bootstrapPlan?: BootstrapPlanModule;
  /** Test seam: inject a mock bootstrap config reader/writer. Defaults to the real module. */
  _bootstrapConfig?: BootstrapConfigModule;
  /** Test seam: inject a mock bootstrap report builder/renderer. Defaults to the real module. */
  _bootstrapReport?: BootstrapReportModule;
  /** Test seam: inject a mock existence classifier. Defaults to the real module. */
  _existence?: ExistenceModule;
  /** Test seam: inject a fake clock (see `clock.cts`'s `makeFakeClock`). Defaults to `realClock`. */
  _clock?: ClockLike;
}

// ─── Implementation ───────────────────────────────────────────────────────────

function routeGithubSyncCommandRouter({
  args,
  cwd,
  raw,
  error,
  _isCapabilityActive,
  _auth,
  _desired,
  _remote,
  _map,
  _reconcile,
  _status,
  _apply,
  _issueUpdate,
  _target,
  _bootstrapRemote,
  _bootstrapPlan,
  _bootstrapConfig,
  _bootstrapReport,
  _existence,
  _clock,
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
  const desired: DesiredModule = _desired ?? desiredMod;
  const remote: RemoteModule = _remote ?? remoteMod;
  // Cast the production module's stronger (typed) signatures down to this
  // router's deliberately loose `unknown`-based interface — the same
  // structural relationship every other `_xxx ?? xxxMod` default in this
  // file relies on, made explicit here because `mergeCompletion`'s options
  // parameter is contravariant on a `keyof SyncCompletion` literal union the
  // router has no reason to import.
  const map: MapModule = _map ?? (mapMod as unknown as MapModule);
  const reconcile: ReconcileModule = _reconcile ?? reconcileMod;
  const status: StatusModule = _status ?? statusMod;
  const apply: ApplyModule = _apply ?? applyMod;
  const issueUpdate: IssueUpdateModule = _issueUpdate ?? issueUpdateMod;
  const target: TargetModule = _target ?? targetMod;
  const bootstrapRemote: BootstrapRemoteModule = _bootstrapRemote ?? bootstrapRemoteMod;
  const bootstrapPlan: BootstrapPlanModule = _bootstrapPlan ?? bootstrapPlanMod;
  const bootstrapConfig: BootstrapConfigModule = _bootstrapConfig ?? bootstrapConfigMod;
  const bootstrapReport: BootstrapReportModule = _bootstrapReport ?? bootstrapReportMod;
  const existence: ExistenceModule = _existence ?? (existenceMod as unknown as ExistenceModule);
  const clock: ClockLike = _clock ?? clockMod.realClock;

  /**
   * D-01: `init`'s own two-pass structure/options sequence, extracted so
   * `sync`'s D-01 rebuild delegation calls the SAME seam rather than a
   * second implementation that must track `init` forever. `init` retains
   * sole ownership of target resolution, `writeProjectNumber`, its own
   * apply-gate report shape, and the config write below — this helper only
   * plans and applies both passes and returns enough for either caller to
   * build its own report or continue into reconciliation.
   */
  interface ApplyResultLike {
    kind: string;
    map?: { completions?: Record<string, { issueNumber?: number }> } | null;
    outcomes?: OperationOutcome[];
    logicalKey?: string;
    remediation?: string;
  }
  interface BootstrapTwoPassOptions {
    cwd: string;
    desiredState: unknown;
    remoteSnapshot: unknown;
    strictMap: { kind: string; map?: unknown; reason?: string };
    baseTarget: { owner: string; repo: string; repositoryNumber: number };
    projectNumber: number | null;
    projectTitle: string | null;
    viewLayout: string;
  }
  interface BootstrapTwoPassResult {
    reportTarget: { owner: string; repo: string; projectNumber: number | null };
    structurePlan: BootstrapPlanStageResult;
    structureApply?: ApplyResultLike;
    optionsPlan?: BootstrapPlanStageResult;
    optionsApply?: ApplyResultLike;
    effectiveReportTarget?: { owner: string; repo: string; projectNumber: number | null };
    effectiveProjectNumber?: number | null;
    finalMap: unknown;
    blockedEarly: boolean;
  }

  function runBootstrapTwoPass(options: BootstrapTwoPassOptions): BootstrapTwoPassResult {
    const { cwd: runCwd, desiredState, remoteSnapshot, strictMap, baseTarget, projectNumber, projectTitle, viewLayout } = options;
    const reportTarget = { owner: baseTarget.owner, repo: baseTarget.repo, projectNumber };

    const structurePlan = bootstrapPlan.planBootstrap(
      { desired: desiredState, remote: remoteSnapshot, strictMap, target: { ...baseTarget, projectNumber }, projectTitle, viewLayout },
      { pass: bootstrapPlan.BOOTSTRAP_PASS.STRUCTURE },
    );
    if (structurePlan.blocked.length > 0 || structurePlan.uncertain.length > 0) {
      return {
        reportTarget, structurePlan,
        finalMap: strictMap.kind === 'valid' ? strictMap.map ?? null : null,
        blockedEarly: true,
      };
    }

    const structureApply = apply.applyMutationPlan(structurePlan, {
      cwd: runCwd,
      map: strictMap.kind === 'valid' ? strictMap.map : null,
    }) as ApplyResultLike;
    if (structureApply.kind !== 'completed') {
      return {
        reportTarget, structurePlan, structureApply,
        finalMap: structureApply.map ?? (strictMap.kind === 'valid' ? strictMap.map ?? null : null),
        blockedEarly: true,
      };
    }

    const mutated = mutatedKeys(structureApply.outcomes ?? []);
    const projectMutated = mutated.includes('project');
    const fieldMutated = mutated.some((key: string) => key.startsWith('field:'));
    const effectiveProjectNumber = projectMutated
      ? structureApply.map?.completions?.project?.issueNumber ?? projectNumber
      : projectNumber;
    const effectiveReportTarget = { owner: baseTarget.owner, repo: baseTarget.repo, projectNumber: effectiveProjectNumber };

    const optionsRemote = (projectMutated || fieldMutated)
      ? bootstrapRemote.readBootstrapRemoteState({ cwd: runCwd, owner: baseTarget.owner, repo: baseTarget.repo, projectNumber: effectiveProjectNumber })
      : remoteSnapshot;

    const optionsStrictMap = structureApply.map ? { kind: 'valid', map: structureApply.map } : { kind: 'absent' };
    const optionsPlan = bootstrapPlan.planBootstrap(
      { desired: desiredState, remote: optionsRemote, strictMap: optionsStrictMap, target: { ...baseTarget, projectNumber: effectiveProjectNumber }, projectTitle, viewLayout },
      { pass: bootstrapPlan.BOOTSTRAP_PASS.OPTIONS },
    );
    if (runFatalBlockedEntries(optionsPlan.blocked, bootstrapPlan).length > 0 || optionsPlan.uncertain.length > 0) {
      return {
        reportTarget, structurePlan, structureApply, optionsPlan, effectiveReportTarget,
        effectiveProjectNumber,
        finalMap: structureApply.map ?? null,
        blockedEarly: true,
      };
    }

    const optionsApply = apply.applyMutationPlan(optionsPlan, { cwd: runCwd, map: structureApply.map ?? null }) as ApplyResultLike;

    return {
      reportTarget, structurePlan, structureApply, optionsPlan, optionsApply, effectiveReportTarget,
      effectiveProjectNumber,
      finalMap: optionsApply.map ?? structureApply.map ?? null,
      blockedEarly: false,
    };
  }

  routeHubCommandFamily({
    family: 'github-sync',
    args,
    subcommands: ['preflight', 'status', 'sync', 'init'],
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
      status: () => {
        let dto: unknown;
        try {
          const desiredState = desired.readDesiredState(cwd);
          const resolvedTarget = target.readSyncTarget(cwd);
          if (!resolvedTarget.available || !resolvedTarget.target) {
            // G-02-4: propagate the target's own diagnosis (reason + field)
            // instead of collapsing it into the hardcoded remote-outage
            // reason — a local config fault is not a GitHub outage.
            dto = status.buildStatusV1({ available: false, reason: resolvedTarget.reason ?? 'target_unavailable', field: resolvedTarget.field }, null);
            emitStatus(dto, raw, status);
            return;
          }
          const strictMap = map.readSyncMapStrict(cwd, { owner: resolvedTarget.target.owner, repo: resolvedTarget.target.repo, number: resolvedTarget.target.repositoryNumber });
          const remoteSnapshot = remote.readRemoteSnapshot({ cwd, owner: resolvedTarget.target.owner, repo: resolvedTarget.target.repo, repositoryNumber: resolvedTarget.target.repositoryNumber, projectNumber: resolvedTarget.target.projectNumber, issueNodeIdHints: collectIssueNodeIdHints(strictMap) });
          dto = status.buildStatusV1(remoteSnapshot, reconcile.planReconciliation(desiredState, remoteSnapshot, strictMap));
        } catch {
          dto = status.buildStatusV1({ available: false, reason: 'remote_unavailable' }, null);
        }
        emitStatus(dto, raw, status);
      },
      sync: () => {
        let result: unknown;
        try {
          const preflight = auth.runPreflight(cwd);
          if (!preflight.ok) {
            result = { kind: 'blocked', reason: 'preflight_unavailable' };
          } else {
            const desiredState = desired.readDesiredState(cwd) as { available?: unknown };
            if (desiredState?.available !== true) {
              result = { kind: 'blocked', reason: 'local_unavailable' };
            } else {
              const resolvedTarget = target.readSyncTarget(cwd);
              if (!resolvedTarget.available || !resolvedTarget.target) {
                result = { kind: 'blocked', reason: 'target_unavailable' };
                output(result, raw);
                return;
              }
              const strictMap = map.readSyncMapStrict(cwd, { owner: resolvedTarget.target.owner, repo: resolvedTarget.target.repo, number: resolvedTarget.target.repositoryNumber }) as {
                kind?: unknown; map?: unknown;
              };
              const remoteSnapshot = remote.readRemoteSnapshot({ cwd, owner: resolvedTarget.target.owner, repo: resolvedTarget.target.repo, repositoryNumber: resolvedTarget.target.repositoryNumber, projectNumber: resolvedTarget.target.projectNumber, issueNodeIdHints: collectIssueNodeIdHints(strictMap) }) as { available?: unknown };
              if (remoteSnapshot?.available !== true) {
                result = { kind: 'uncertain', reason: 'remote_unavailable' };
              } else {
                if (strictMap?.kind === 'blocking') {
                  result = { kind: 'blocked', reason: 'sync_map_blocking' };
                } else {
                  // D-01/D-05/D-08/D-09 (plan 07-01): existence classification
                  // and the rebuild delegation run HERE — after the strictMap
                  // and remoteSnapshot reads, before `planReconciliation` — and
                  // ONLY from `sync`, never `status` (T-07-04). A classified
                  // `project` completion has its absence marker advanced and
                  // persisted through `mergeCompletion` (never a bare
                  // `recordCompletion` built from a partial object — D-08's
                  // wholesale-replace warning) whether or not the gate fires;
                  // the gate firing additionally delegates to the SAME
                  // `runBootstrapTwoPass` helper `init` uses, then falls
                  // through into `planReconciliation` against the freshly
                  // re-read post-rebuild snapshot — all inside this one `sync`
                  // invocation.
                  let planningStrictMap: { kind?: unknown; map?: unknown } = strictMap;
                  let planningRemoteSnapshot: unknown = remoteSnapshot;
                  if (strictMap?.kind === 'valid') {
                    const completions = ((strictMap.map as { completions?: Record<string, unknown> } | undefined)?.completions ?? {}) as Record<string, { nodeId?: string; issueNumber?: number; owner?: string; repo?: string; repositoryNumber?: number; completedAt?: string; absenceCount?: number; absenceFirstSeenAt?: string } | undefined>;
                    const projectCompletion = completions.project;
                    if (projectCompletion) {
                      const bootstrapRemoteState = bootstrapRemote.readBootstrapRemoteState({
                        cwd,
                        owner: resolvedTarget.target.owner,
                        repo: resolvedTarget.target.repo,
                        projectNumber: resolvedTarget.target.projectNumber,
                      });
                      const verdicts = existence.classifyExistence({ completions, remote: remoteSnapshot, bootstrapRemote: bootstrapRemoteState });
                      const projectVerdict = verdicts.find((entry) => entry.logicalKey === 'project');
                      if (projectVerdict) {
                        const nowIso = clock.nowIso();
                        const advancedMarker = existence.advanceAbsence(
                          { absenceCount: projectCompletion.absenceCount, absenceFirstSeenAt: projectCompletion.absenceFirstSeenAt },
                          projectVerdict.verdict,
                          nowIso,
                        );
                        const clearKeys: string[] = [];
                        if (advancedMarker.absenceCount === undefined) clearKeys.push('absenceCount');
                        if (advancedMarker.absenceFirstSeenAt === undefined) clearKeys.push('absenceFirstSeenAt');
                        const mergedCompletion = map.mergeCompletion(
                          projectCompletion,
                          {
                            logicalKey: 'project',
                            nodeId: projectCompletion.nodeId,
                            completedAt: projectCompletion.completedAt,
                            owner: projectCompletion.owner,
                            repo: projectCompletion.repo,
                            repositoryNumber: projectCompletion.repositoryNumber,
                            ...advancedMarker,
                          },
                          { clear: clearKeys },
                        );
                        const nextSyncMap = map.recordCompletion(strictMap.map, mergedCompletion);
                        map.writeSyncMapAtomically(cwd, nextSyncMap);
                        planningStrictMap = { kind: 'valid', map: nextSyncMap };

                        if (existence.rebuildTriggered(verdicts, completions, nowIso)) {
                          const projectTitle = bootstrapConfig.readProjectTitle(cwd);
                          const viewLayout = bootstrapConfig.readViewLayout(cwd);
                          const rebuildResult = runBootstrapTwoPass({
                            cwd,
                            desiredState,
                            remoteSnapshot: bootstrapRemoteState,
                            strictMap: planningStrictMap as { kind: string; map?: unknown },
                            baseTarget: { owner: resolvedTarget.target.owner, repo: resolvedTarget.target.repo, repositoryNumber: resolvedTarget.target.repositoryNumber },
                            projectNumber: resolvedTarget.target.projectNumber,
                            projectTitle,
                            viewLayout,
                          });
                          const rebuiltMap = rebuildResult.finalMap ?? nextSyncMap;
                          planningStrictMap = rebuiltMap ? { kind: 'valid', map: rebuiltMap } : planningStrictMap;
                          const effectiveProjectNumber = rebuildResult.effectiveProjectNumber ?? resolvedTarget.target.projectNumber;
                          planningRemoteSnapshot = remote.readRemoteSnapshot({
                            cwd,
                            owner: resolvedTarget.target.owner,
                            repo: resolvedTarget.target.repo,
                            repositoryNumber: resolvedTarget.target.repositoryNumber,
                            projectNumber: effectiveProjectNumber,
                            issueNodeIdHints: collectIssueNodeIdHints(planningStrictMap),
                          });
                        }
                      }
                    }
                  }

                  // Plan 05-07 (D-12/discretion item): no streaming progress
                  // mechanism is added for a long first run. The create list
                  // and counts already dispatched below tell a developer how
                  // much work this run will do before it starts, and a second
                  // output surface beside renderStatusV1's would cost more
                  // than the one sentence 05-08 spends documenting that a
                  // first run on an established repository takes minutes,
                  // and that killing it is free — every mutation is
                  // checkpointed, so a resumed run picks up where it left off.
                  const plan = reconcile.planReconciliation(desiredState, planningRemoteSnapshot, planningStrictMap) as {
                    operations: unknown[]; pendingIssueUpdates?: unknown[]; subIssueCeilingWarnings?: unknown[];
                  };
                  // Plan 04-04 Task 3: the read-splice-write preparation
                  // stage runs here, between planning and applying — never
                  // from `status`, which stays a dry run (SYNC-07/P2 D-13).
                  // A stage that returns only reports and no operations is
                  // not an error: the run proceeds with whatever operations
                  // remain, and exits 0 either way (Phase 1 D-11). Prepared
                  // operations are appended after the plan's own,
                  // deterministically, so dispatch order is stable.
                  const prepared = issueUpdate.prepareIssueUpdates(plan.pendingIssueUpdates ?? [], { cwd });
                  const combinedPlan = { ...plan, operations: [...(plan.operations ?? []), ...prepared.operations] };
                  const applyResult = apply.applyMutationPlan(combinedPlan, {
                    cwd,
                    map: planningStrictMap?.kind === 'valid' ? planningStrictMap.map ?? null : null,
                  }) as Record<string, unknown>;
                  // Plan 05-07: the plan's own reported sub-issue-ceiling
                  // warnings ride the result beside issueUpdateReports, so a
                  // developer running `sync` sees them without also running
                  // `status` — never a new authority, sync still exits 0
                  // with warnings present (the exit-0-never-gates posture).
                  result = { ...applyResult, issueUpdateReports: prepared.reports, subIssueCeilingWarnings: plan.subIssueCeilingWarnings ?? [] };
                }
              }
            }
          }
        } catch {
          result = { kind: 'uncertain', reason: 'sync_unavailable' };
        }
        output(result, raw);
      },
      // D-05/D-15: `init` is registered and works end to end for BOOT-01's
      // create/adopt/repair/not-found branches (plan 03-03) — it is not a
      // stub.
      //
      // Unlike `sync`, `init` does NOT collapse the preflight result behind
      // a generic reason (line ~251 above) — a missing `project` scope must
      // be nameable in the report, not hidden behind "preflight_unavailable".
      init: () => {
        // Every exit point below builds the report DTO from whatever passes
        // actually ran and renders it through bootstrapReport.renderInitReportV1
        // using this router's existing raw flag — no second flag alias (D-05).
        // The one exception is the outer catch: if reporting itself would be
        // the thing that threw, the ad-hoc uncertain/init_unavailable object
        // is returned unchanged rather than risking a report-building throw
        // cascading past the D-11 exit-0 contract.
        let unresolvedTarget: { owner: string | null; repo: string | null; projectNumber: number | null } = { owner: null, repo: null, projectNumber: null };
        try {
          const preflight = auth.runPreflight(cwd);
          if (!preflight.ok) {
            emitInitReport({ target: unresolvedTarget, preflightFailure: { reason: preflight.reason, message: preflight.message } }, raw, bootstrapReport);
            return;
          }

          const desiredState = desired.readDesiredState(cwd);

          // D-01/D-02/HIGH-1: resolveTarget is the identity-then-map single
          // read this run consumes — an explicitly configured target always
          // wins and spawns nothing; otherwise it fills the identity from a
          // partial config and/or `gh repo view`, and only then (with a
          // complete identity) reads the sync map once for project-number
          // crash recovery. Every subsequent consumer here — the options
          // pass's planner input, its adapters.map, and the effective-target
          // computation — consumes the map returned by the most recent
          // apply, never this head-of-run copy again.
          const resolvedResult = bootstrapConfig.resolveTarget(cwd);
          if (!resolvedResult.target) {
            emitInitReport({ target: unresolvedTarget, externalBlocked: { reason: 'target_unavailable', remediation: 'The github-sync target (owner/repo/repository number) could not be resolved from .planning/config.json or `gh repo view` — configure github_sync.target, then re-run.' } }, raw, bootstrapReport);
            return;
          }
          const resolvedTarget = resolvedResult.target;
          unresolvedTarget = { owner: resolvedTarget.owner, repo: resolvedTarget.repo, projectNumber: resolvedTarget.projectNumber };

          const strictMap = (resolvedResult.strictMapRead ?? { kind: 'absent' }) as { kind: string; reason?: string; map?: unknown };
          const remoteSnapshot = bootstrapRemote.readBootstrapRemoteState({
            cwd,
            owner: resolvedTarget.owner,
            repo: resolvedTarget.repo,
            projectNumber: resolvedTarget.projectNumber,
          });

          const baseTarget = {
            owner: resolvedTarget.owner,
            repo: resolvedTarget.repo,
            repositoryNumber: resolvedTarget.repositoryNumber,
          };
          const projectTitle = bootstrapConfig.readProjectTitle(cwd);
          // Plan 06-04: read once per run, beside projectTitle — the same
          // one-read-two-consumers pattern, so the structure and options
          // passes can never disagree about the configured layout.
          const viewLayout = bootstrapConfig.readViewLayout(cwd);

          // D-01 (plan 07-01): the two-pass structure/options sequence below
          // is now the shared `runBootstrapTwoPass` helper — the SAME seam
          // `sync`'s D-01 rebuild delegation calls, so `init`'s own behaviour
          // here is unchanged by the extraction (pinned by the pre-existing
          // router test suite).
          const twoPass = runBootstrapTwoPass({
            cwd,
            desiredState,
            remoteSnapshot,
            strictMap,
            baseTarget,
            projectNumber: resolvedTarget.projectNumber,
            projectTitle,
            viewLayout,
          });
          const reportTarget = twoPass.effectiveReportTarget ?? twoPass.reportTarget;

          if (twoPass.blockedEarly) {
            emitInitReport({
              target: reportTarget,
              structurePlan: twoPass.structurePlan,
              structureApply: twoPass.structureApply,
              optionsPlan: twoPass.optionsPlan,
            }, raw, bootstrapReport);
            return;
          }

          const effectiveProjectNumber = twoPass.effectiveProjectNumber ?? resolvedTarget.projectNumber;

          // D-02: the config write fires whenever the run started
          // unconfigured (a partial-config, gh-fallback, or crash-recovery
          // resolution — never a fully-configured run, whose number is
          // already correct) AND the effective target carries a positive
          // project number — covering the create path AND the
          // crash-recovery path, not only a confirmed create. A non-ok write
          // result degrades to a notice on the report, never the exit code,
          // and never re-throws into the outer catch (which would
          // misreport an otherwise-successful run as `init_unavailable`).
          let configWriteNotice: string | null = null;
          if (
            resolvedResult.reason !== bootstrapConfig.RESOLVE_TARGET_REASON.CONFIGURED &&
            typeof effectiveProjectNumber === 'number' && Number.isSafeInteger(effectiveProjectNumber) && effectiveProjectNumber > 0
          ) {
            try {
              const writeResult = bootstrapConfig.writeProjectNumber(cwd, baseTarget, effectiveProjectNumber);
              if (!writeResult.ok) configWriteNotice = writeResult.reason;
            } catch {
              configWriteNotice = 'config_write_threw';
            }
          }

          emitInitReport({
            target: reportTarget,
            structurePlan: twoPass.structurePlan,
            structureApply: twoPass.structureApply,
            optionsPlan: twoPass.optionsPlan,
            optionsApply: twoPass.optionsApply,
            configWriteNotice,
          }, raw, bootstrapReport);
        } catch {
          output({ kind: 'uncertain', reason: 'init_unavailable' }, raw);
        }
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
