'use strict';
/**
 * github-sync-existence.cts — pure, zero-I/O existence classifier (plan
 * 07-01, D-05/D-08/D-09). Mirrors the header style and the `Object.freeze`
 * enum idiom of `src/github-sync-bootstrap-plan.cts`.
 *
 * Hosted in a dedicated module rather than `src/github-sync-reconcile.cts`
 * (which already imports `github-sync-bootstrap-plan.cjs`) because hosting
 * the shared classifier there would create an import cycle the moment
 * `bootstrap-plan.cts` itself needs to consume it — a dedicated module keeps
 * both future consumers and the router cycle-free.
 *
 * This plan wires exactly one reserved logical key end to end: `project`.
 * D-02's wider trigger list (`field:*`, `option:status:*`,
 * `option:autonomous:*`, `label:*`, `milestone:*`) is horizontal expansion
 * for a later plan over this same proven shape.
 */

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

interface BootstrapRemoteLike {
  available?: boolean;
  projectOutcome?: string;
}

interface ClassifyExistenceInput {
  /** The current sync map's completions, keyed by logical key. */
  completions?: Record<string, { nodeId?: string } | undefined> | null;
  /** `RemoteSnapshot`-shaped read (`github-sync-remote.cjs`) — reserved for
   *  future namespaces (issue-bearing keys); not consulted for `project`. */
  remote?: unknown;
  /** `BootstrapRemoteState`-shaped read (`github-sync-bootstrap-remote.cjs`)
   *  — the sole classification input for the `project` key this plan wires. */
  bootstrapRemote?: BootstrapRemoteLike | null;
}

/**
 * D-05: the verdict is derived from the enumeration `init`'s own bootstrap
 * reader already makes — zero extra API calls, and it inherits
 * `readBootstrapRemoteState`'s existing fail-closed cursor-exhaustion and
 * malformed-payload handling.
 *
 * T-07-01: branches on `bootstrapRemote.available` BEFORE inspecting
 * anything else. `unavailable()` (both `github-sync-remote.cts` and
 * `github-sync-bootstrap-remote.cts`) returns empty arrays/null fields on
 * transport and decode failure alike, so an empty or absent result is never,
 * by itself, evidence of absence — every path where `available` is not
 * `true` yields `unknown`, never `confirmed-absent`.
 */
function classifyExistence(input: ClassifyExistenceInput): ExistenceVerdictEntry[] {
  const completions = input.completions ?? {};
  const entries: ExistenceVerdictEntry[] = [];

  if (completions.project) {
    entries.push({ logicalKey: 'project', verdict: classifyProject(input.bootstrapRemote) });
  }

  // Exactly `collectOrphans`' own sort (github-sync-reconcile.cts): logical
  // keys compared with localeCompare's numeric collation.
  return entries.sort((left, right) => left.logicalKey.localeCompare(right.logicalKey, undefined, { numeric: true }));
}

function classifyProject(bootstrapRemote: BootstrapRemoteLike | null | undefined): ExistenceVerdictValue {
  if (!bootstrapRemote || bootstrapRemote.available !== true) return EXISTENCE_VERDICT.UNKNOWN;
  return bootstrapRemote.projectOutcome === 'resolved' ? EXISTENCE_VERDICT.PRESENT : EXISTENCE_VERDICT.CONFIRMED_ABSENT;
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
 * D-01/D-02 (this plan's scope: the `project` key only). Simulates the same
 * `advanceAbsence` step the caller is about to persist, so a router can ask
 * "does THIS run's verdict, once recorded, satisfy the recreate gate?"
 * without duplicating the lifecycle rule.
 */
function rebuildTriggered(
  verdicts: ExistenceVerdictEntry[],
  completions: Record<string, AbsenceMarker | undefined> | null | undefined,
  nowIso?: string,
): boolean {
  const projectVerdict = verdicts.find((entry) => entry.logicalKey === 'project');
  if (!projectVerdict || projectVerdict.verdict !== EXISTENCE_VERDICT.CONFIRMED_ABSENT) return false;
  const previous = (completions ?? {}).project;
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
