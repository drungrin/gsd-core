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
 * Plan 07-04 widened classification to every bootstrap namespace REC-02 (as
 * amended by D-22) names as participating: `project`, `field:*`,
 * `option:status:*`, `option:autonomous:*`, `label:*`, `milestone:*`. Two
 * namespaces stay exempt, each for a stated reason (D-14): `view:*` (a view
 * carries no body, comments, history, or sub-issue relations, so
 * `planViews`' own recreate-on-unresolved-ID path destroys nothing) and
 * `project-link` (it records a relationship `planProject` already repairs on
 * its own read, not an object with an absence to gate).
 *
 * Plan 07-05 (D-11/D-12) completes REC-02's namespace list with the
 * issue-bearing keys: the phase issue's own identity (`issue:phase:<id>`),
 * the plan issue's own identity (`issue:plan:<id>`), and the legacy
 * pre-Phase-4 phase project-item key (`phase:<id>`) that also carries a real
 * issue number. Unlike the bootstrap namespaces (classified by direct node-ID
 * membership against an enumeration), an issue's verdict is reached only
 * after re-resolving by `(owner, repo, number)` — D-12's ordering
 * requirement — because a node ID appearing to be missing from the board's
 * item list is not evidence the underlying issue is gone: the issue may
 * simply not be bound to the project, or may have been transferred/restored
 * under a new node ID. `classifyIssueBearing` below is that re-resolution,
 * generalizing `github-sync-reconcile.cts`'s existing
 * `bindingOnBoard`/`resolvedIssueNodeId` two-tier check into a verdict rather
 * than a boolean.
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

/** A project item as `RemoteSnapshot.items` (`github-sync-remote.cjs`) carries it: the item's own node id, and — when bound to an issue — that issue's node id and number nested under `content`. */
interface RemoteItemLike {
  id?: string;
  content?: { id?: string; number?: number } | null;
}

/** The subset of `RemoteSnapshot` (`github-sync-remote.cjs`) D-12's issue re-resolution consults. */
interface RemoteSnapshotLike {
  available?: boolean;
  items?: RemoteItemLike[];
  /** Keyed by issue number (as a string), populated only for issue-bearing keys the router already hinted (`collectIssueNodeIdHints`, plan 04-06's allow-list) — D-11's own discipline, upstream of this module. */
  issueNodeIds?: Record<string, string>;
}

interface ClassifyExistenceInput {
  /** The current sync map's completions, keyed by logical key. */
  completions?: Record<string, { nodeId?: string; issueNumber?: number } | undefined> | null;
  /** `RemoteSnapshot`-shaped read (`github-sync-remote.cjs`) — the classification input for every issue-bearing key (D-11/D-12). */
  remote?: RemoteSnapshotLike | null;
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

/**
 * D-11 (plan 07-05): the three issue-bearing logical-key generators —
 * exactly the key forms `src/github-sync-command-router.cts`'s
 * `isIssueBearingLogicalKey` allow-lists (built in plan 04-06, with its own
 * RED-first regression test): the phase issue's own identity, the plan
 * issue's own identity, and the legacy pre-Phase-4 phase project-item key
 * that also carries a real issue number. Mirrors that module's own
 * `startsWith('issue:') || startsWith('phase:')` predicate, expressed here as
 * three separate prefixes (rather than two) so this module's own contract
 * test (plan 07-05 Task 3) can enumerate each key FORM independently instead
 * of collapsing `issue:phase:*` and `issue:plan:*` into one generic `issue:`
 * membership check. Exported so that test drives its assertion from this
 * catalog's own membership rather than a second, hand-written list that
 * could silently drift from it — the same discipline `BOOTSTRAP_LOGICAL_KEY`
 * already establishes for the bootstrap namespaces above.
 *
 * `github-sync-command-router.cts` cannot import this module for its own
 * copy: it already imports `github-sync-existence.cjs`, and this module must
 * never import that one back (this module's own header explains why). The
 * two predicates are therefore deliberately parallel, not shared — exactly
 * the same one-directional constraint `BOOTSTRAP_LOGICAL_KEY` already lives
 * under here.
 */
const ISSUE_LOGICAL_KEY = Object.freeze({
  phaseIssue: (id: string): string => `issue:phase:${id}`,
  planIssue: (id: string): string => `issue:plan:${id}`,
  legacyPhase: (id: string): string => `phase:${id}`,
});

const ISSUE_BEARING_KEY_PREFIXES: readonly string[] = Object.freeze([
  ISSUE_LOGICAL_KEY.phaseIssue(''),
  ISSUE_LOGICAL_KEY.planIssue(''),
  ISSUE_LOGICAL_KEY.legacyPhase(''),
]);

/** D-11: `true` for a phase-issue key, a plan-issue key, or the legacy phase project-item key — the only key forms whose `issueNumber` may ever reach a by-number lookup. */
function isIssueBearingLogicalKey(logicalKey: string): boolean {
  return ISSUE_BEARING_KEY_PREFIXES.some((prefix) => logicalKey.startsWith(prefix));
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
 * D-12's fast path: does `nodeId` appear anywhere in the run's own project
 * item enumeration (`remote.items`, already read for every `sync`/`status`
 * invocation)? Checks BOTH node-id semantics a cached completion's `nodeId`
 * may carry — an item's own id (the legacy `phase:<id>` project-item
 * completion) or its bound issue's content id (`issue:phase:<id>` /
 * `issue:plan:<id>`) — generalizing `bindingOnBoard`'s item-id check
 * (`github-sync-reconcile.cts`) to the second semantic that module's own
 * function never needed. A hit here means no by-number lookup is required at
 * all — the property the router's contract test (Task 3) pins.
 */
function issueNodeIdAppearsInItems(nodeId: string | undefined, items: RemoteItemLike[] | undefined): boolean {
  if (!isNonEmptyString(nodeId)) return false;
  for (const item of items ?? []) {
    if (isNonEmptyString(item.id) && item.id === nodeId) return true;
    const content = item.content;
    if (content !== null && typeof content === 'object' && isNonEmptyString(content.id) && content.id === nodeId) return true;
  }
  return false;
}

/**
 * D-12's re-resolution path: `remote.issueNodeIds` is populated only for
 * issue-bearing numbers the router already hinted
 * (`collectIssueNodeIdHints`'s allow-list, upstream of this module) — a
 * direct `(owner, repo, number)` read, independent of project-board
 * membership. Returns the freshly resolved node id, or `null` when the
 * number was never hinted or the issue does not resolve against a
 * successful read.
 */
function numberResolvedNodeId(issueNodeIds: RemoteSnapshotLike['issueNodeIds'], issueNumber: number | undefined): string | null {
  if (typeof issueNumber !== 'number' || issueNodeIds === null || typeof issueNodeIds !== 'object') return null;
  const value = issueNodeIds[String(issueNumber)];
  return isNonEmptyString(value) ? value : null;
}

/**
 * D-05/D-11/D-12: the issue-bearing verdict. Branches on `remote.available`
 * BEFORE touching either lookup (T-07-01's discipline, generalized to the
 * issue namespaces) — an unavailable read yields `unknown` regardless of
 * which of the two checks below would have failed. Order is the requirement,
 * not an optimisation (D-12): the node-ID fast path runs first, and only a
 * miss there reaches the by-number re-resolution — `confirmed-absent` is
 * reachable only when BOTH fail against a read that succeeded.
 */
function classifyIssueBearing(
  completion: { nodeId?: string; issueNumber?: number },
  remote: RemoteSnapshotLike | null | undefined,
): ExistenceVerdictValue {
  if (!remote || remote.available !== true) return EXISTENCE_VERDICT.UNKNOWN;
  if (issueNodeIdAppearsInItems(completion.nodeId, remote.items)) return EXISTENCE_VERDICT.PRESENT;
  return numberResolvedNodeId(remote.issueNodeIds, completion.issueNumber) !== null
    ? EXISTENCE_VERDICT.PRESENT
    : EXISTENCE_VERDICT.CONFIRMED_ABSENT;
}

/**
 * D-05/D-02/D-22/D-11/D-12: every mapped ID in a participating bootstrap
 * namespace — `project`, `field:*`, `option:status:*`,
 * `option:autonomous:*`, `label:*`, `milestone:*` — receives a verdict
 * against `bootstrapRemote`'s direct enumerations, and every mapped
 * issue-bearing key — `issue:phase:*`, `issue:plan:*`, the legacy
 * `phase:*` project-item form — receives a verdict against `remote` through
 * D-12's re-resolve-before-verdict path. `view:*` and `project-link` (D-14)
 * are excluded from the returned collection entirely, not present in it
 * with a null verdict — the two axes are mutually exclusive by construction
 * (`participatingNamespaceKind` and `isIssueBearingLogicalKey` share no
 * prefix), so every mapped completion is classified by at most one path.
 */
function classifyExistence(input: ClassifyExistenceInput): ExistenceVerdictEntry[] {
  const completions = input.completions ?? {};
  const entries: ExistenceVerdictEntry[] = [];

  for (const [logicalKey, completion] of Object.entries(completions)) {
    if (!completion) continue;
    const namespace = participatingNamespaceKind(logicalKey);
    if (namespace !== null) {
      entries.push({ logicalKey, verdict: classifyByNamespace(namespace, completion.nodeId, input.bootstrapRemote) });
      continue;
    }
    if (isIssueBearingLogicalKey(logicalKey)) {
      entries.push({ logicalKey, verdict: classifyIssueBearing(completion, input.remote) });
    }
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
 * D-01/D-02, widened by plan 07-04 Task 3 from the `project` key alone to
 * every participating namespace: `project`, `field:*`, `option:status:*`,
 * `option:autonomous:*`, `label:*`, `milestone:*`. Simulates the same
 * `advanceAbsence` step the caller is about to persist, so a router can ask
 * "does THIS run's verdict, once recorded, satisfy the recreate gate?"
 * without duplicating the lifecycle rule — for ANY single participating
 * object, not only `project` (`init`'s converge pass repairs the whole
 * bootstrap surface at once, so one trigger covers every damage shape).
 *
 * `view:*` and `project-link` are excluded by the same
 * `participatingNamespaceKind` test `classifyExistence` uses — a
 * defense-in-depth check independent of whatever `classifyExistence` itself
 * happens to produce, so a future caller that hand-builds a `verdicts` array
 * cannot smuggle either exempt namespace into a trigger decision.
 *
 * Plan 07-06 Task 2 (D-03): returns every logical key that independently
 * satisfies the trigger condition, not merely a boolean — `status`'s
 * rebuild-scope preview names these keys as "what triggered this."
 * `rebuildTriggered` below is now defined in terms of this array's
 * non-emptiness, so the two can never disagree (P2 D-12's shared-predicate
 * rule).
 */
function rebuildTriggerKeys(
  verdicts: ExistenceVerdictEntry[],
  completions: Record<string, AbsenceMarker | undefined> | null | undefined,
  nowIso?: string,
): string[] {
  const safeCompletions = completions ?? {};
  return verdicts
    .filter((entry) => participatingNamespaceKind(entry.logicalKey) !== null)
    .filter((entry) => entry.verdict === EXISTENCE_VERDICT.CONFIRMED_ABSENT)
    .filter((entry) => absenceGateSatisfied(advanceAbsence(safeCompletions[entry.logicalKey], entry.verdict, nowIso), nowIso))
    .map((entry) => entry.logicalKey);
}

function rebuildTriggered(
  verdicts: ExistenceVerdictEntry[],
  completions: Record<string, AbsenceMarker | undefined> | null | undefined,
  nowIso?: string,
): boolean {
  return rebuildTriggerKeys(verdicts, completions, nowIso).length > 0;
}

export = {
  EXISTENCE_VERDICT,
  RECREATE_GRACE_MS,
  ISSUE_LOGICAL_KEY,
  isIssueBearingLogicalKey,
  classifyExistence,
  advanceAbsence,
  absenceGateSatisfied,
  rebuildTriggered,
  rebuildTriggerKeys,
};
