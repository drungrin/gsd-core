'use strict';
/**
 * github-sync-marker-search.cts — D-20's repo-scoped, fail-closed marker
 * reader and pure anti-forgery binding pass (plan 07-07). Closes P4 D-05's
 * explicit deferral: when `.planning/.github-sync.json` is lost but the
 * phase/plan issues it once tracked survive (a Project deletion never
 * deletes the issues — they are repository-scoped), `sync` re-binds them
 * from the identity markers already written into their bodies
 * (`github-sync-issue-body.cts`'s `phaseMarker`/`planMarker`) instead of
 * creating 58 duplicates.
 *
 * Two independent concerns live here, deliberately kept in one module
 * because they share no third consumer and the binding pass is meaningless
 * without the reader's typed, fail-closed contract:
 *
 * - `readIssuesWithMarkers` — modeled on
 *   `github-sync-bootstrap-remote.cts`'s `readRestList` byte-for-byte: raw
 *   string argv, an EXPLICIT `-X GET` (the live-discovered `gh` GET->POST
 *   switch that fires the instant any `-f`/`-F` value is supplied with no
 *   explicit method — reproduced against the label-create endpoint as a
 *   422, documented at `readRestList`'s own doc comment), `--paginate
 *   --slurp` page exhaustion, and a fixed unavailable result on any
 *   transport or decode failure. An empty list from a FAILED read must
 *   never be indistinguishable from a repository that genuinely has zero
 *   issues (T-07-23): the `available` flag is checked before any array is
 *   ever trusted, exactly as `github-sync-remote.cts`'s `unavailable()`
 *   convention requires.
 * - `bindMarkers` — a pure, zero-I/O anti-forgery binding pass (T-07-21). An
 *   issue body is text any repository writer can author, so the marker
 *   literal alone is never sufficient evidence. Three conditions must ALL
 *   hold before a binding is produced: the body carries the EXACT marker
 *   literal the marker constructors build (a near-miss — different
 *   spacing, quoting, or comment form — never matches a literal substring
 *   search, so no separate near-miss detector is needed), that occurrence
 *   lies inside the fenced structure GSD itself writes, and exactly one
 *   issue claims the identifier. Anything else refuses and reports rather
 *   than guessing — the same discipline plan 05-03's dependency-slot
 *   refusal established for a mismatched substitution.
 *
 * ANTI-FORGERY POSITION (Claude's Discretion, 07-CONTEXT.md): both
 * `renderNewIssueBody`/`renderNewPlanIssueBody` place the identity marker
 * BEFORE `FENCE_BEGIN`, not between `FENCE_BEGIN`/`FENCE_END` — the fenced
 * region is what `spliceRegion` REWRITES on every sync; the marker line is
 * written once, at creation, and is never touched again. "Inside the
 * GSD-owned fenced structure" is therefore defined operationally as: the
 * body carries exactly one begin fence and one end fence, correctly
 * ordered (the same validity `spliceRegion`'s SPLICED/DAMAGED split
 * requires), and the marker's occurrence index is strictly before the end
 * fence's index — covering both the marker's real, canonical position
 * (immediately before the begin fence) and anywhere inside the interior.
 * Text appended after the end fence — the one part of a GSD-authored body a
 * developer can freely edit without `spliceRegion` ever touching it, and
 * the natural place a copy-pasted or forged marker would land — is
 * "outside" and binds nothing. A body with zero or more-than-one fence of
 * either kind carries no provably GSD-owned structure at all and is
 * silently ignored, matching `spliceRegion`'s own SELF_HEAL/DAMAGED
 * severities rather than a hand-rolled markdown parser.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import ghMod = require('./github-sync-gh.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import bootstrapRemoteMod = require('./github-sync-bootstrap-remote.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import issueBodyMod = require('./github-sync-issue-body.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import reconcileMod = require('./github-sync-reconcile.cjs');

const { FENCE_BEGIN, FENCE_END, phaseMarker, planMarker } = issueBodyMod;
const { issueKeyFor, planIssueKeyFor } = reconcileMod;

interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  reason: string;
}

type ExecGh = (args: string[], opts: { cwd?: string; includeHeaders?: boolean }) => GhResult;

/** One repository issue, decoded from the REST list read. `body` is `''` for an issue GitHub returns with a null body — never treated as a decode failure. */
interface MarkerSearchEntry {
  number: number;
  nodeId: string;
  body: string;
}

interface MarkerReadResult {
  available: boolean;
  entries: MarkerSearchEntry[];
}

/** An unmapped desired identifier the binding pass should look for. `logicalKey` is always built through `issueKeyFor`/`planIssueKeyFor` — never concatenated (T-07-24). */
interface MarkerTarget {
  kind: 'phase' | 'plan';
  id: string;
  logicalKey: string;
}

interface MarkerBinding {
  logicalKey: string;
  nodeId: string;
  issueNumber: number;
}

/** A refusal to bind — either two issues claiming one identifier, or one issue claiming two. Never a guess. */
interface MarkerRefusal {
  logicalKey?: string;
  issueNumbers: number[];
  reason: 'ambiguous_marker_claim' | 'multiple_identifiers_claimed';
}

interface MarkerBindingResult {
  bindings: MarkerBinding[];
  refusals: MarkerRefusal[];
}

/** The subset of `DesiredState` this module needs — never the full shape, so a test fixture stays minimal. */
interface DesiredStateLike {
  phases: ReadonlyArray<{ id: string }>;
  plans: ReadonlyArray<{ id: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Decodes one REST issue list element into a `MarkerSearchEntry`. `null` on
 * any shape mismatch — the caller (`readIssuesWithMarkers`) treats a single
 * malformed element as a whole-read failure, mirroring `readRestList`'s own
 * discipline: a partial decode is never silently dropped in favor of the
 * entries that DID decode, because that would make a truncated read
 * indistinguishable from a complete one.
 */
function decodeMarkerEntry(raw: unknown): MarkerSearchEntry | null {
  if (!isRecord(raw)) return null;
  const nodeId = raw.node_id;
  const number = raw.number;
  const body = raw.body;
  if (!isNonEmptyString(nodeId)) return null;
  if (!isPositiveSafeInteger(number)) return null;
  if (body !== null && typeof body !== 'string') return null;
  return { number, nodeId, body: typeof body === 'string' ? body : '' };
}

/**
 * D-20's repo-scoped, fail-closed reader (Task 1). Modeled on
 * `github-sync-bootstrap-remote.cts`'s `readRestList` byte-for-byte: an
 * explicit `-X GET` (mandatory, not stylistic — see the module header), the
 * paginate-and-slurp mode so exhaustion is `gh`'s own job rather than a
 * cursor loop this module would have to own, and a fixed unavailable
 * result on a non-zero exit, unparseable JSON, a non-array body, or any
 * single malformed element. `state=all` enumerates every issue regardless
 * of open/closed state, so a phase whose issue was closed before the map
 * was lost is still findable. Never throws, for any input.
 */
function readIssuesWithMarkers(options: { cwd: string; owner: string; repo: string; execGh?: ExecGh }): MarkerReadResult {
  const execGh = options.execGh ?? ghMod.execGh;
  const restApiPath = bootstrapRemoteMod.restPath(options.owner, options.repo, '/issues');
  if (restApiPath === null) return { available: false, entries: [] };

  const result = execGh(
    ['api', restApiPath, '-X', 'GET', '-f', 'per_page=100', '-f', 'state=all', '--paginate', '--slurp'],
    { cwd: options.cwd, includeHeaders: false },
  );
  if (result.exitCode !== 0) return { available: false, entries: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { available: false, entries: [] };
  }
  if (!Array.isArray(parsed)) return { available: false, entries: [] };

  const flattened: unknown[] = parsed.length > 0 && parsed.every((element) => Array.isArray(element)) ? parsed.flat() : parsed;

  const entries: MarkerSearchEntry[] = [];
  for (const raw of flattened) {
    const decoded = decodeMarkerEntry(raw);
    if (!decoded) return { available: false, entries: [] };
    entries.push(decoded);
  }
  return { available: true, entries };
}

/** Non-overlapping literal-token count — the same split-length-minus-one technique `spliceRegion` uses, deliberately not a markdown parser. */
function countOccurrences(body: string, token: string): number {
  return body.split(token).length - 1;
}

/**
 * The module header's ANTI-FORGERY POSITION, as code: `true` only when the
 * body carries exactly one begin fence and one end fence, correctly
 * ordered, AND `marker`'s first occurrence lies strictly before the end
 * fence. A damaged or absent fence pair, or a marker occurring only at or
 * after the end fence, is `false` — never a thrown error, never a guess.
 */
function markerInsideOwnedStructure(body: string, marker: string): boolean {
  if (countOccurrences(body, FENCE_BEGIN) !== 1 || countOccurrences(body, FENCE_END) !== 1) return false;
  const beginIndex = body.indexOf(FENCE_BEGIN);
  const endIndex = body.indexOf(FENCE_END);
  if (endIndex < beginIndex) return false;
  const markerIndex = body.indexOf(marker);
  return markerIndex !== -1 && markerIndex < endIndex;
}

/**
 * Builds the search target list from every desired phase/plan whose
 * `issue:phase:*`/`issue:plan:*` logical key carries no completion in
 * `completions` — the exact set `sync`'s D-20 pre-pass hands to
 * `bindMarkers`. Every logical key is built through `issueKeyFor`/
 * `planIssueKeyFor` (T-07-24) — this function never concatenates one.
 */
function unboundIssueTargets(desired: DesiredStateLike, completions: Record<string, unknown>): MarkerTarget[] {
  const targets: MarkerTarget[] = [];
  for (const phase of desired.phases ?? []) {
    const logicalKey = issueKeyFor(phase.id);
    if (!completions[logicalKey]) targets.push({ kind: 'phase', id: phase.id, logicalKey });
  }
  for (const plan of desired.plans ?? []) {
    const logicalKey = planIssueKeyFor(plan.id);
    if (!completions[logicalKey]) targets.push({ kind: 'plan', id: plan.id, logicalKey });
  }
  return targets;
}

/**
 * Task 2's pure binding pass. Takes the decoded issue entries and the
 * target list `unboundIssueTargets` computed, and returns the completions
 * to record plus the refusals to report. Performs no I/O.
 *
 * An unavailable read (or an empty target list) short-circuits to zero
 * bindings and zero refusals — never a partial guess from whatever entries
 * happened to decode before a failure that never occurred here, since
 * `readIssuesWithMarkers` itself is already all-or-nothing.
 *
 * Anti-forgery: a marker match is collected only when
 * `markerInsideOwnedStructure` holds. Two independent ambiguity classes are
 * then refused rather than resolved by guessing (mirroring plan 05-03's
 * dependency-slot refusal):
 *   - the SAME identifier matched by MORE THAN ONE issue — one refusal
 *     entry naming the identifier and every claiming issue number;
 *   - the SAME issue matching MORE THAN ONE identifier — one refusal entry
 *     per such issue, and that issue is excluded from every target it
 *     matched (so a legitimate single claimant elsewhere for the same
 *     identifier can still bind).
 *
 * Output is ordered by logical key (D-20's own text), so the report and
 * the resulting map writes are reviewable and stable across runs.
 */
function bindMarkers(read: MarkerReadResult, targets: readonly MarkerTarget[]): MarkerBindingResult {
  if (!read.available || targets.length === 0) return { bindings: [], refusals: [] };

  const nodeIdByIssue = new Map<number, string>();
  const issuesByTarget = new Map<string, number[]>();
  const targetsByIssue = new Map<number, string[]>();

  for (const entry of read.entries) {
    nodeIdByIssue.set(entry.number, entry.nodeId);
    for (const target of targets) {
      const marker = target.kind === 'phase' ? phaseMarker(target.id) : planMarker(target.id);
      if (!markerInsideOwnedStructure(entry.body, marker)) continue;
      const claimingIssues = issuesByTarget.get(target.logicalKey) ?? [];
      claimingIssues.push(entry.number);
      issuesByTarget.set(target.logicalKey, claimingIssues);
      const claimedIdentifiers = targetsByIssue.get(entry.number) ?? [];
      claimedIdentifiers.push(target.logicalKey);
      targetsByIssue.set(entry.number, claimedIdentifiers);
    }
  }

  const refusals: MarkerRefusal[] = [];
  const multiClaimIssues = new Set<number>();
  for (const [issueNumber, logicalKeys] of targetsByIssue) {
    if (logicalKeys.length <= 1) continue;
    multiClaimIssues.add(issueNumber);
    refusals.push({ issueNumbers: [issueNumber], reason: 'multiple_identifiers_claimed' });
  }

  const bindings: MarkerBinding[] = [];
  for (const [logicalKey, issueNumbers] of issuesByTarget) {
    const validIssueNumbers = issueNumbers.filter((issueNumber) => !multiClaimIssues.has(issueNumber));
    if (validIssueNumbers.length === 0) continue;
    if (validIssueNumbers.length > 1) {
      refusals.push({
        logicalKey,
        issueNumbers: [...validIssueNumbers].sort((left, right) => left - right),
        reason: 'ambiguous_marker_claim',
      });
      continue;
    }
    const issueNumber = validIssueNumbers[0];
    const nodeId = nodeIdByIssue.get(issueNumber);
    if (nodeId === undefined) continue;
    bindings.push({ logicalKey, nodeId, issueNumber });
  }

  bindings.sort((left, right) => left.logicalKey.localeCompare(right.logicalKey, undefined, { numeric: true }));
  refusals.sort((left, right) => (left.logicalKey ?? '').localeCompare(right.logicalKey ?? '', undefined, { numeric: true }));
  return { bindings, refusals };
}

export = {
  readIssuesWithMarkers,
  unboundIssueTargets,
  bindMarkers,
};
