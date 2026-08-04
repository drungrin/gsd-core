'use strict';
/**
 * Serial, checkpointed mutation interpreter for github-sync reconciliation
 * and bootstrap plans (plan 03-02, HIGH-A). Migrated onto the shared
 * operation contract in `github-sync-operation.cts`: this module no longer
 * declares its own `MutationOperation` shape and no longer decodes
 * completions by hand. It folds `AdoptionCheckpoint`s into the map before
 * dispatching anything, resolves late-bound argv against the live map,
 * decodes a per-transport response root, and fans one operation's response
 * out to N completions in a single atomic write.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import ghMod = require('./github-sync-gh.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import mapMod = require('./github-sync-map.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import clockMod = require('./clock.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import operationMod = require('./github-sync-operation.cjs');
import type { SyncCompletion, SyncMap } from './github-sync-map.cts';
import type {
  MutationPlan,
  AdoptionCheckpoint,
  OperationOutcome,
  CompletionLookupMap,
} from './github-sync-operation.cts';

const {
  OPERATION_TRANSPORT,
  OPERATION_ACTION,
  OPERATION_OUTCOME,
  isOperation,
  resolveArgv,
  decodeResponseRoot,
  decodeCompletions,
} = operationMod;
// D-08/WINDOWS #9: `recordCompletion` (github-sync-map.cts) replaces the
// WHOLE completion at a logical key. `mergeCompletion` is the mandatory seam
// every capture routes through first, so a capture that only knows about one
// field (e.g. `prepareIssueUpdates`'s content-hash-only capture) can never
// silently erase a sibling field (e.g. `issueState`) a PRIOR operation in
// this same run, or a prior run, already recorded at that key.
const { mergeCompletion } = mapMod;

interface GhResult {
  exitCode: number;
  reason: string;
  stdout: string;
  stderr: string;
  response?: { available: boolean; status: number | null; retry_after_seconds: number | null };
}
interface RateLimit { cost: number; remaining: number; resetAt: string; }
interface ApplyAdapters {
  cwd: string;
  map: SyncMap | null;
  execGh?: (args: string[], options: { cwd: string; includeHeaders: boolean }) => GhResult;
  recordCompletion?: (map: SyncMap | null, completion: SyncCompletion) => SyncMap;
  writeSyncMapAtomically?: (cwd: string, map: SyncMap) => void;
  clock?: { now(): number; nowIso(): string; sleep(ms: number): void };
  random?: () => number;
  notice?: (message: string) => void;
}
type ApplyResult =
  | { kind: 'completed'; map: SyncMap | null; outcomes: OperationOutcome[] }
  | { kind: 'failed'; logicalKey: string; remediation: string; outcomes: OperationOutcome[] }
  | { kind: 'uncertain'; logicalKey: string; remediation: string; outcomes: OperationOutcome[] };

const RETRY_LIMIT = 3;
const CONTENT_CREATE_INTERVAL_MS = 750;
const POINTS_RESERVE = 100;
const RETRY_REMEDIATION = 'Retry the sync after resolving the reported GitHub failure.';
const CREATE_UNCERTAIN_REMEDIATION = 'Re-read GitHub and reconcile before retrying this content create.';
const CHECKPOINT_UNCERTAIN_REMEDIATION = 'Repair the local sync map before running sync again.';
const ARGV_UNRESOLVED_REMEDIATION_PREFIX = 'A prerequisite object was not checkpointed this run: ';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decodes GitHub's REST already-exists validation-error shape directly from
 * the raw response body — never through `decodeResponseRoot`, which rejects
 * any REST body carrying a `message` and no success key as `null` by design
 * (that rejection is what makes a genuine error body distinguishable from a
 * success body elsewhere in this module; the already-exists recovery below
 * needs the body itself, not the post-rejection null). Recorded live
 * (`tests/fixtures/github-sync/header-framing.json`'s `live-422` case,
 * `tests/fixtures/github-sync/bootstrap-repo-objects.json`'s
 * `milestoneAlreadyExists422Body`): `{"message":"Validation Failed","errors":
 * [{"resource":"Label","code":"already_exists","field":"name"}], ...}`. Only
 * the `errors[].code === 'already_exists'` shape is checked — the resource
 * and field vary between a label and a milestone conflict, and are not part
 * of the identity this recovery keys on.
 */
function isAlreadyExistsBody(stdout: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  const errors = parsed.errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((entry) => isRecord(entry) && entry.code === 'already_exists');
}

function parseRateLimitFromRoot(root: Record<string, unknown> | null): RateLimit | null {
  const rateLimit = root?.rateLimit;
  if (rateLimit === null || typeof rateLimit !== 'object' || Array.isArray(rateLimit)) return null;
  const { cost, remaining, resetAt } = rateLimit as Record<string, unknown>;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0 ||
      typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0 ||
      typeof resetAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(resetAt) || Number.isNaN(Date.parse(resetAt))) return null;
  return { cost, remaining, resetAt };
}

/**
 * Thin wrapper on the pre-existing exported signature: decodes the GraphQL
 * envelope through the shared `decodeResponseRoot`, then reads `rateLimit`
 * off the resulting root. Kept so the existing export and its direct test
 * assertion keep working unchanged.
 */
function parseRateLimit(result: GhResult): RateLimit | null {
  return parseRateLimitFromRoot(decodeResponseRoot(OPERATION_TRANSPORT.GRAPHQL, result.stdout));
}

function isRateLimited(result: GhResult): boolean {
  return result.response?.available === true && (result.response.status === 429 || result.response.status === 403) &&
    typeof result.response.retry_after_seconds === 'number';
}
function isTransient(result: GhResult): boolean {
  return result.reason === 'gh_exit_nonzero' && /(?:connection|reset|temporar|network|econn)/i.test(result.stderr);
}
function retryDelayMs(result: GhResult, retry: number, random: () => number): number {
  const retryAfter = result.response?.retry_after_seconds;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1000;
  return (1000 * (2 ** (retry - 1))) + Math.floor(random() * 250);
}
function pointsDelayMs(rateLimit: RateLimit, now: number): number | null {
  if (rateLimit.remaining >= POINTS_RESERVE + Math.max(rateLimit.cost, 1)) return 0;
  const resetAt = Date.parse(rateLimit.resetAt);
  return Number.isNaN(resetAt) ? null : Math.max(0, resetAt - now);
}

/** Builds the late-bound argv resolution lookup from the current map's completions. */
function lookupFromMap(map: SyncMap | null): CompletionLookupMap | null {
  if (!map) return null;
  const lookup: CompletionLookupMap = {};
  for (const [key, completion] of Object.entries(map.completions)) {
    lookup[key] = {
      nodeId: completion.nodeId,
      ...(completion.issueNumber === undefined ? {} : { remoteNumber: completion.issueNumber }),
    };
  }
  return lookup;
}

function completionFromCheckpoint(checkpoint: AdoptionCheckpoint, completedAt: string): SyncCompletion {
  return {
    logicalKey: checkpoint.logicalKey,
    nodeId: checkpoint.nodeId,
    ...(checkpoint.remoteNumber === undefined ? {} : { issueNumber: checkpoint.remoteNumber }),
    completedAt,
    owner: checkpoint.completionContext.owner,
    repo: checkpoint.completionContext.repo,
    repositoryNumber: checkpoint.completionContext.repositoryNumber,
  };
}

/**
 * Folds a plan's checkpoints into `map`, before any operation dispatches
 * (checkpoint contract clause 2, HIGH-A). Returns the pending map, the
 * outcomes it produced, and whether anything actually changed — the caller
 * persists with exactly one `writeSyncMapAtomically` call, and only when
 * `wrote` is true. Throws exactly what `recordCompletion` throws (a
 * repository mismatch); the caller's try/catch converts that into an
 * uncertain result whose outcome journal carries none of this fold's
 * entries (clause 3b) — a mid-fold throw must never let the journal claim a
 * confirmation the file never received.
 */
function foldCheckpoints(
  checkpoints: AdoptionCheckpoint[],
  map: SyncMap | null,
  recordCompletion: (map: SyncMap | null, completion: SyncCompletion) => SyncMap,
  nowIso: () => string,
): { map: SyncMap | null; outcomes: OperationOutcome[]; wrote: boolean } {
  let pendingMap = map;
  const outcomes: OperationOutcome[] = [];
  let wrote = false;
  for (const checkpoint of checkpoints) {
    const existing = pendingMap?.completions[checkpoint.logicalKey];
    const sameNodeId = existing !== undefined && existing.nodeId === checkpoint.nodeId;
    const sameNumber = existing !== undefined && existing.issueNumber === checkpoint.remoteNumber;
    if (existing !== undefined && sameNodeId && sameNumber) {
      outcomes.push({ logicalKey: checkpoint.logicalKey, operationKey: null, action: OPERATION_ACTION.OBSERVE, result: OPERATION_OUTCOME.UNCHANGED });
      continue;
    }
    pendingMap = recordCompletion(pendingMap, completionFromCheckpoint(checkpoint, nowIso()));
    wrote = true;
    outcomes.push({ logicalKey: checkpoint.logicalKey, operationKey: null, action: OPERATION_ACTION.OBSERVE, result: OPERATION_OUTCOME.CONFIRMED });
  }
  return { map: pendingMap, outcomes, wrote };
}

function applyMutationPlan(plan: MutationPlan, adapters: ApplyAdapters): ApplyResult {
  const execGh = adapters.execGh ?? ghMod.execGh;
  const recordCompletion = adapters.recordCompletion ?? mapMod.recordCompletion;
  const writeSyncMapAtomically = adapters.writeSyncMapAtomically ?? mapMod.writeSyncMapAtomically;
  const clock = adapters.clock ?? clockMod.realClock;
  const random = adapters.random ?? Math.random;
  const notice = adapters.notice ?? (() => {});
  let currentMap = adapters.map;
  let lastContentCreateAt: number | null = null;
  let pendingPointsDelay = 0;
  const outcomes: OperationOutcome[] = [];

  // Checkpoint contract clause 2 / HIGH-A: fold observations before any dispatch,
  // so an adopted object's node id is durably in the map before the first execGh call.
  const checkpoints = plan.checkpoints ?? [];
  if (checkpoints.length > 0) {
    let folded: { map: SyncMap | null; outcomes: OperationOutcome[]; wrote: boolean };
    try {
      folded = foldCheckpoints(checkpoints, currentMap, recordCompletion, () => clock.nowIso());
    } catch {
      // Clause 3b: a mid-fold throw publishes no outcome for this batch.
      return { kind: 'uncertain', logicalKey: 'checkpoints', remediation: CHECKPOINT_UNCERTAIN_REMEDIATION, outcomes: [] };
    }
    if (folded.wrote) writeSyncMapAtomically(adapters.cwd, folded.map as SyncMap);
    // The fold's resulting map becomes currentMap on every path — including
    // nothing-to-write — so a checkpoints-only plan (the ordinary shape of a
    // fully-adopted run) never returns the head-of-run map (HIGH-1).
    currentMap = folded.map;
    outcomes.push(...folded.outcomes);
  }

  for (const operation of plan.operations) {
    if (!isOperation(operation)) return { kind: 'failed', logicalKey: operation.logicalKey, remediation: RETRY_REMEDIATION, outcomes };

    const resolved = resolveArgv(operation.args, lookupFromMap(currentMap));
    if (!resolved.ok) {
      return { kind: 'failed', logicalKey: operation.logicalKey, remediation: `${ARGV_UNRESOLVED_REMEDIATION_PREFIX}${resolved.missingLogicalKey}`, outcomes };
    }

    if (pendingPointsDelay > 0) {
      notice(`github-sync: pacing rate-limit points for ${pendingPointsDelay}ms.`);
      clock.sleep(pendingPointsDelay);
      pendingPointsDelay = 0;
    }
    if (operation.contentCreation && lastContentCreateAt !== null) {
      const remaining = CONTENT_CREATE_INTERVAL_MS - (clock.now() - lastContentCreateAt);
      if (remaining > 0) { notice(`github-sync: pacing content creation for ${remaining}ms.`); clock.sleep(remaining); }
    }

    let retries = 0;
    while (true) {
      const result = execGh(resolved.argv, { cwd: adapters.cwd, includeHeaders: true });
      if (result.exitCode === 0) {
        const root = decodeResponseRoot(operation.transport, result.stdout);
        let rateLimit: RateLimit | null = null;
        if (operation.hasPointsBudget) {
          rateLimit = parseRateLimitFromRoot(root);
          if (!rateLimit) return { kind: 'failed', logicalKey: operation.logicalKey, remediation: RETRY_REMEDIATION, outcomes };
        }
        const decoded = decodeCompletions(operation, root, clock.nowIso());
        if (!decoded) return { kind: 'failed', logicalKey: operation.logicalKey, remediation: RETRY_REMEDIATION, outcomes };

        let pendingMap = currentMap;
        const pendingOutcomes: OperationOutcome[] = [];
        try {
          for (const item of decoded) {
            // Plan 04-03 Task 3: planner-supplied fields are spread first, so
            // the applier's own authoritative fields (written after) can
            // never be shadowed by a planner constant — asserted directly by
            // test rather than relied upon from spread order alone.
            const capturedFields = {
              ...(item.plannerFields ?? {}),
              logicalKey: item.logicalKey,
              nodeId: item.nodeId,
              ...(item.remoteNumber === undefined ? {} : { issueNumber: item.remoteNumber }),
              completedAt: item.completedAt,
              owner: operation.completionContext.owner,
              repo: operation.completionContext.repo,
              repositoryNumber: operation.completionContext.repositoryNumber,
            };
            // D-08/WINDOWS #9: merge onto whatever is already recorded at
            // this logical key — in `pendingMap`, which already reflects
            // every prior capture dispatched earlier in this same run —
            // before handing the result to `recordCompletion`'s wholesale
            // replace. Precedence: previously-recorded members first, then
            // this capture's planner-supplied fields, then its own
            // applier-authoritative fields last (`capturedFields` already
            // resolved that inner precedence, above).
            const previousCompletion = pendingMap?.completions[item.logicalKey];
            pendingMap = recordCompletion(pendingMap, mergeCompletion(previousCompletion, capturedFields));
            pendingOutcomes.push({ logicalKey: item.logicalKey, operationKey: operation.logicalKey, action: operation.action, result: OPERATION_OUTCOME.CONFIRMED });
          }
          writeSyncMapAtomically(adapters.cwd, pendingMap as SyncMap);
        } catch {
          // Clause 3b: this operation's fan-out publishes nothing on a mid-fold throw.
          return { kind: 'uncertain', logicalKey: operation.logicalKey, remediation: CHECKPOINT_UNCERTAIN_REMEDIATION, outcomes };
        }
        currentMap = pendingMap;
        outcomes.push(...pendingOutcomes);

        if (operation.hasPointsBudget && rateLimit) {
          const delay = pointsDelayMs(rateLimit, clock.now());
          if (delay === null) return { kind: 'failed', logicalKey: operation.logicalKey, remediation: RETRY_REMEDIATION, outcomes };
          pendingPointsDelay = delay;
        }
        if (operation.contentCreation) lastContentCreateAt = clock.now();
        break;
      }
      // Task 3's typed already-exists recovery (D-11's sole documented
      // exception): scoped to the REST transport, a 422 status parsed from a
      // real response (plan 03-01 Task 2's status-line fix is what makes
      // `result.response` reachable here at all), and a body that actually
      // decodes to GitHub's already-exists shape — never to the status code
      // alone, so an unrelated 422 still fails the run below, and never to a
      // GraphQL operation, so a GraphQL failure can never be swallowed by it.
      // Records no completion (the object stays absent from the sync map;
      // the next run's live list read is what reconciles it — BOOT-04/05's
      // ordinary list-then-create discipline, not an exception to it), and
      // still advances the content-creation clock before continuing: the
      // request was dispatched and GitHub processed it, so the next
      // content-creating operation must still honour the pacing interval
      // (D-10, cycle-2 non-HIGH #6) rather than dispatching immediately
      // after a rejected create.
      if (operation.transport === OPERATION_TRANSPORT.REST && result.response?.status === 422 && isAlreadyExistsBody(result.stdout)) {
        outcomes.push({ logicalKey: operation.logicalKey, operationKey: operation.logicalKey, action: operation.action, result: OPERATION_OUTCOME.ALREADY_EXISTS });
        if (operation.contentCreation) lastContentCreateAt = clock.now();
        break;
      }
      if (operation.contentCreation && result.reason === 'gh_timed_out') return { kind: 'uncertain', logicalKey: operation.logicalKey, remediation: CREATE_UNCERTAIN_REMEDIATION, outcomes };
      if (!(isRateLimited(result) || isTransient(result)) || retries >= RETRY_LIMIT) return { kind: 'failed', logicalKey: operation.logicalKey, remediation: RETRY_REMEDIATION, outcomes };
      retries += 1;
      const delay = retryDelayMs(result, retries, random);
      notice(`github-sync: retrying ${operation.logicalKey} in ${delay}ms.`);
      clock.sleep(delay);
    }
  }
  return { kind: 'completed', map: currentMap, outcomes };
}

export = { applyMutationPlan, CONTENT_CREATE_INTERVAL_MS, POINTS_RESERVE, RETRY_LIMIT, parseRateLimit, decodeCompletions };
