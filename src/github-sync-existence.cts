'use strict';
/**
 * github-sync-existence.cts — pure, zero-I/O existence classifier (plan
 * 07-01, D-05/D-08/D-09; widened by plan 07-04 to every participating
 * bootstrap namespace, D-02/D-05/D-06/D-22-amended-REC-02). Mirrors the
 * header style and the `Object.freeze` enum idiom of
 * `src/github-sync-bootstrap-plan.cts`.
 *
 * Hosted in a dedicated module rather than `src/github-sync-reconcile.cts`
 * (which already imports `github-sync-bootstrap-plan.cjs`) because hosting
 * the shared classifier there would create an import cycle the moment
 * `bootstrap-plan.cts` itself needs to consume it — a dedicated module keeps
 * both future consumers and the router cycle-free. This module now imports
 * `github-sync-bootstrap-plan.cjs` itself (for the reserved logical-key
 * catalog), which is safe in this one direction only: `bootstrap-plan.cts`
 * must never import this module back.
 *
 * Plan 07-01 wired exactly one reserved logical key end to end: `project`.
 * Plan 07-04 widens classification to every namespace REC-02 (as amended by
 * D-22) names as participating: `project`, `field:*`, `option:status:*`,
 * `option:autonomous:*`, `label:*`, `milestone:*`. Two namespaces stay
 * exempt, each for a stated reason (D-14): `view:*` (a view carries no body,
 * comments, history, or sub-issue relations, so `planViews`' own
 * recreate-on-unresolved-ID path destroys nothing) and `project-link` (it
 * records a relationship `planProject` already repairs on its own read, not
 * an object with an absence to gate). The issue namespaces are deliberately
 * NOT classified here either — D-12 requires re-resolution by
 * `(owner, repo, number)` to run before any issue's absence verdict, which
 * plan 07-05 adds together with that re-resolution.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import bootstrapPlanMod = require('./github-sync-bootstrap-plan.cjs');

const { BOOTSTRAP_LOGICAL_KEY } = bootstrapPlanMod;

/** D-05: the three-way verdict a successful (or failed) remote read produces. */
const EXISTENCE_VERDICT = Object.freeze({
  PRESENT: 'present',
  CONFIRMED_ABSENT: 'confirmed-absent',
  UNKNOWN: 'unknown',
} as const);
type ExistenceVerdictValue = typeof EXISTENCE_VERDICT[keyof typeof EXISTENCE_VERDICT];

/**
 * D-09/D-10: the minimum wall-clock gap, in milliseconds, required between
 * two confirmed absences before a recreate may fire. Fixed at 60000 (60s) —
 * roughly 12x the observed maximum from
 * `.planning/phases/04-phase-issue-sync/04-LAG-MEASUREMENT.md`: n=6 samples,
 * min 2.351s, max 4.712s, mean 3.881s, zero censored. That document's own
 * *Interpretation* section states plainly what six samples in one session do
 * NOT rule out — the community-reported multi-hour visibility-lag tail. This
 * constant is the measured number, not a guess at the tail; D-12's
 * re-resolve-by-number check (a later plan) is the real backstop against
 * that unruled-out tail, not a larger timeout here.
 */
const RECREATE_GRACE_MS = 60000;

/** D-08: the two flat scalar members that ride `SyncCompletion` optionally. */
interface AbsenceMarker {
  absenceCount?: number;
  absenceFirstSeenAt?: string;
}

interface ExistenceVerdictEntry {
  logicalKey: string;
  verdict: ExistenceVerdictValue;
}

interface RemoteOptionLike {
  id?: string;
}

interface RemoteFieldLike {
  id?: string;
  name?: string;
  options?: RemoteOptionLike[] | null;
}

interface RemoteEntryLike {
  nodeId?: string;
}

interface BootstrapRemoteLike {
  available?: boolean;
  projectOutcome?: string;
  /** Every field on the project, `Status` and `Autonomous` included — matches `BootstrapRemoteState.fields`. */
  fields?: RemoteFieldLike[];
  /** The `Status` single-select field, options included — matches `BootstrapRemoteState.statusField`. */
  statusField?: RemoteFieldLike | null;
  labels?: RemoteEntryLike[];
  milestones?: RemoteEntryLike[];
}

interface ClassifyExistenceInput {
  /** The current sync map's completions, keyed by logical key. */
  completions?: Record<string, { nodeId?: string } | undefined> | null;
  /** `RemoteSnapshot`-shaped read (`github-sync-remote.cjs`) — reserved for
   *  a future plan's issue-bearing namespaces (D-12); not consulted here. */
  remote?: unknown;
  /** `BootstrapRemoteState`-shaped read (`github-sync-bootstrap-remote.cjs`)
   *  — the classification input for every participating bootstrap-namespace key. */
  bootstrapRemote?: BootstrapRemoteLike | null;
}

const PROJECT_KEY: string = BOOTSTRAP_LOGICAL_KEY.project();

// Each generator's empty-string call collapses to exactly its reserved
// prefix (`slug('')` is `''`), so this membership test derives from the same
// catalog `github-sync-bootstrap-plan.cts` owns rather than restating a
// prefix literal — BOOTSTRAP_LOGICAL_KEY's own header comment: "no caller
// concatenates a reserved key by hand."
const FIELD_PREFIX: string = BOOTSTRAP_LOGICAL_KEY.field('');
const STATUS_OPTION_PREFIX: string = BOOTSTRAP_LOGICAL_KEY.statusOption('');
const AUTONOMOUS_OPTION_PREFIX: string = BOOTSTRAP_LOGICAL_KEY.autonomousOption('');
const LABEL_PREFIX: string = BOOTSTRAP_LOGICAL_KEY.label('');
const MILESTONE_PREFIX: string = BOOTSTRAP_LOGICAL_KEY.milestone('');

// D-22: the `Autonomous` single-select GSD itself creates. Not exported by
// `github-sync-bootstrap-plan.cts` (it keeps its own identically-named
// private constant); mirrored here as a literal rather than widening that
// module's export surface for one string this module alone needs.
const AUTONOMOUS_FIELD_NAME = 'Autonomous';

type ParticipatingNamespace = 'project' | 'field' | 'status-option' | 'autonomous-option' | 'label' | 'milestone';

/**
 * D-22's amended-REC-02 participating-namespace test, derived from the
 * reserved-key generator catalog. Returns `null` for every non-participating
 * key — `view:*`, `project-link`, and every issue-bearing key alike — so
 * `classifyExistence` and `rebuildTriggered` share one membership decision
 * rather than two that could disagree.
 */
function participatingNamespaceKind(logicalKey: string): ParticipatingNamespace | null {
  if (logicalKey === PROJECT_KEY) return 'project';
  if (logicalKey.startsWith(FIELD_PREFIX)) return 'field';
  if (logicalKey.startsWith(STATUS_OPTION_PREFIX)) return 'status-option';
  if (logicalKey.startsWith(AUTONOMOUS_OPTION_PREFIX)) return 'autonomous-option';
  if (logicalKey.startsWith(LABEL_PREFIX)) return 'label';
  if (logicalKey.startsWith(MILESTONE_PREFIX)) return 'milestone';
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function autonomousField(bootstrapRemote: BootstrapRemoteLike): RemoteFieldLike | undefined {
  return (bootstrapRemote.fields ?? []).find((field) => field.name === AUTONOMOUS_FIELD_NAME);
}

/** Every remote node id belonging to one non-project participating namespace, from the enumeration the run already made. */
function remoteIdsForNamespace(namespace: Exclude<ParticipatingNamespace, 'project'>, bootstrapRemote: BootstrapRemoteLike): string[] {
  switch (namespace) {
    case 'field':
      return (bootstrapRemote.fields ?? []).map((field) => field.id).filter(isNonEmptyString);
    case 'status-option':
      return (bootstrapRemote.statusField?.options ?? []).map((option) => option.id).filter(isNonEmptyString);
    case 'autonomous-option':
      return (autonomousField(bootstrapRemote)?.options ?? []).map((option) => option.id).filter(isNonEmptyString);
    case 'label':
      return (bootstrapRemote.labels ?? []).map((entry) => entry.nodeId).filter(isNonEmptyString);
    case 'milestone':
      return (bootstrapRemote.milestones ?? []).map((entry) => entry.nodeId).filter(isNonEmptyString);
    default:
      return [];
  }
}

/**
 * T-07-01/T-07-10: branches on `bootstrapRemote.available` BEFORE inspecting
 * anything else, for every participating namespace alike — not only
 * `project`. `unavailable()` (both `github-sync-remote.cts` and
 * `github-sync-bootstrap-remote.cts`) returns empty arrays/null fields on
 * transport and decode failure alike, so an empty or absent result is never,
 * by itself, evidence of absence — every path where `available` is not
 * `true` yields `unknown`, never `confirmed-absent`.
 */
function classifyByNamespace(
  namespace: ParticipatingNamespace,
  nodeId: string | undefined,
  bootstrapRemote: BootstrapRemoteLike | null | undefined,
): ExistenceVerdictValue {
  if (!bootstrapRemote || bootstrapRemote.available !== true) return EXISTENCE_VERDICT.UNKNOWN;
  if (namespace === 'project') {
    return bootstrapRemote.projectOutcome === 'resolved' ? EXISTENCE_VERDICT.PRESENT : EXISTENCE_VERDICT.CONFIRMED_ABSENT;
  }
  if (!isNonEmptyString(nodeId)) return EXISTENCE_VERDICT.CONFIRMED_ABSENT;
  return remoteIdsForNamespace(namespace, bootstrapRemote).includes(nodeId) ? EXISTENCE_VERDICT.PRESENT : EXISTENCE_VERDICT.CONFIRMED_ABSENT;
}

/**
 * D-05/D-02/D-22 (this plan's widened scope): every mapped ID in a
 * participating bootstrap namespace — `project`, `field:*`,
 * `option:status:*`, `option:autonomous:*`, `label:*`, `milestone:*` —
 * receives a verdict. `view:*` and `project-link` (D-14) and every
 * issue-bearing key (D-12, plan 07-05) are excluded from the returned
 * collection entirely, not present in it with a null verdict.
 */
function classifyExistence(input: ClassifyExistenceInput): ExistenceVerdictEntry[] {
  const completions = input.completions ?? {};
  const entries: ExistenceVerdictEntry[] = [];

  for (const [logicalKey, completion] of Object.entries(completions)) {
    if (!completion) continue;
    const namespace = participatingNamespaceKind(logicalKey);
    if (namespace === null) continue;
    entries.push({ logicalKey, verdict: classifyByNamespace(namespace, completion.nodeId, input.bootstrapRemote) });
  }

  // Exactly `collectOrphans`' own sort (github-sync-reconcile.cts): logical
  // keys compared with localeCompare's numeric collation.
  return entries.sort((left, right) => left.logicalKey.localeCompare(right.logicalKey, undefined, { numeric: true }));
}

/** Pass the marker through unchanged — verbatim, byte-identical (D-06's "the mapping is left untouched"). */
function passThroughMarker(previous: AbsenceMarker | undefined): AbsenceMarker {
  const next: AbsenceMarker = {};
  if (previous?.absenceCount !== undefined) next.absenceCount = previous.absenceCount;
  if (previous?.absenceFirstSeenAt !== undefined) next.absenceFirstSeenAt = previous.absenceFirstSeenAt;
  return next;
}

/**
 * D-08/D-09 marker lifecycle:
 *  - `confirmed-absent` with no prior marker: count 1, stamp `nowIso`.
 *  - `confirmed-absent` with a prior marker: increment count, preserve the
 *    ORIGINAL stamp — never restamp on a later confirmation.
 *  - `present`: clear both members (returns `{}`).
 *  - `unknown`: leave both members exactly as they were.
 *
 * D-09 discretion: `nowIso` is an optional input, fail-closed. A
 * `confirmed-absent` verdict with no `nowIso` never advances the marker
 * (same pass-through as `unknown`) — every pre-existing caller that never
 * threads a clock keeps its current behaviour.
 */
function advanceAbsence(
  previous: AbsenceMarker | undefined,
  verdict: ExistenceVerdictValue,
  nowIso?: string,
): AbsenceMarker {
  if (verdict === EXISTENCE_VERDICT.PRESENT) return {};
  if (verdict !== EXISTENCE_VERDICT.CONFIRMED_ABSENT) return passThroughMarker(previous);
  if (typeof nowIso !== 'string' || nowIso.length === 0) return passThroughMarker(previous);
  if (previous?.absenceFirstSeenAt === undefined) return { absenceCount: 1, absenceFirstSeenAt: nowIso };
  return { absenceCount: (typeof previous.absenceCount === 'number' ? previous.absenceCount : 1) + 1, absenceFirstSeenAt: previous.absenceFirstSeenAt };
}

/**
 * D-09: true only when the marker records at least two confirmed absences
 * AND at least `RECREATE_GRACE_MS` has elapsed, by real wall clock, between
 * the recorded first-absence stamp and `nowIso`. Fails closed on every
 * malformed input: an unparseable or missing `absenceFirstSeenAt`, an
 * absent `nowIso`, or a recorded stamp later than `nowIso` (a negative gap
 * can never reach the grace threshold).
 */
function absenceGateSatisfied(completion: AbsenceMarker | undefined, nowIso?: string): boolean {
  if (!completion || typeof completion.absenceCount !== 'number' || completion.absenceCount < 2) return false;
  if (typeof completion.absenceFirstSeenAt !== 'string' || typeof nowIso !== 'string') return false;
  const firstSeenMs = Date.parse(completion.absenceFirstSeenAt);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(firstSeenMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - firstSeenMs >= RECREATE_GRACE_MS;
}

/**
 * D-01/D-02 (this plan's scope so far: the `project` key only — plan 07-04
 * Task 3 widens this to every participating namespace). Simulates the same
 * `advanceAbsence` step the caller is about to persist, so a router can ask
 * "does THIS run's verdict, once recorded, satisfy the recreate gate?"
 * without duplicating the lifecycle rule.
 */
function rebuildTriggered(
  verdicts: ExistenceVerdictEntry[],
  completions: Record<string, AbsenceMarker | undefined> | null | undefined,
  nowIso?: string,
): boolean {
  const projectVerdict = verdicts.find((entry) => entry.logicalKey === PROJECT_KEY);
  if (!projectVerdict || projectVerdict.verdict !== EXISTENCE_VERDICT.CONFIRMED_ABSENT) return false;
  const previous = (completions ?? {})[PROJECT_KEY];
  const advanced = advanceAbsence(previous, projectVerdict.verdict, nowIso);
  return absenceGateSatisfied(advanced, nowIso);
}

export = {
  EXISTENCE_VERDICT,
  RECREATE_GRACE_MS,
  classifyExistence,
  advanceAbsence,
  absenceGateSatisfied,
  rebuildTriggered,
};
