'use strict';
/**
 * github-sync-issue-update.cts — the one stage in this capability that reads
 * before it decides (plan 04-04 Task 2).
 *
 * It lives outside both neighbours it sits between: the pure diff stage
 * (`github-sync-reconcile.cts`) is bound to zero I/O by SYNC-05, so it can
 * decide *that* an issue's content needs updating but can never read the
 * issue's live body to build the replacement — locating a developer-moved
 * fence pair requires exactly that read. The applier
 * (`github-sync-apply.cts`) models one-shot dispatch-and-capture, not
 * read-then-decide-then-write — its operations are already fully formed
 * before it ever spawns `gh`. Neither shape can hold "read one issue, decide
 * whether its body is safely rewritable, then build the write" without
 * giving something up (04-RESEARCH.md Architecture Pattern 2 / Open
 * Question 2), so this is a third, thin stage the router runs between
 * `planReconciliation` and `applyMutationPlan`, scoped to one issue at a
 * time — the same shape bootstrap's two-pass `init` already uses for "read
 * again before deciding", just narrower.
 *
 * This module is the direct sibling any future body-editing feature will
 * reuse rather than re-derive — Phase 5's task-rendering region, in
 * particular, will need the identical read-splice-write shape for a
 * different fenced region on a different object.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import ghMod = require('./github-sync-gh.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import operationMod = require('./github-sync-operation.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import issueBodyMod = require('./github-sync-issue-body.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import reconcileMod = require('./github-sync-reconcile.cjs');
import type { MutationOperation, ArgvRef, CompletionContext } from './github-sync-operation.cts';

const { OPERATION_TRANSPORT, OPERATION_ACTION, ARGV_REF_PART, decodeResponseRoot } = operationMod;
const { spliceRegion, SPLICE_RESULT } = issueBodyMod;
const { PATH_SAFE_TARGET, phaseIssueRestPath, bodyArgvEntry } = reconcileMod;

interface GhResult { exitCode: number; stdout: string; stderr: string; }

/**
 * Mirrors `github-sync-reconcile.cts`'s `PendingIssueUpdate` shape
 * structurally (that module uses `export =`, so its interfaces cannot also
 * be named-exported — the same constraint `DesiredMilestone` documents
 * there). Every field this stage reads is listed here.
 */
interface PendingIssueUpdate {
  logicalKey: string;
  issueKey: string;
  issueNumber?: number;
  issueNodeId: string;
  title: string;
  region: string;
  milestoneNumber: number;
  milestoneKey: string;
  contentHash: string;
  completionContext: CompletionContext;
  /** Plan 05-06: ordered dependency plan ids for the region's sentinel slots. Omitted (or empty) for a phase, which has no dependencies at all. */
  dependsOn?: string[];
}

/**
 * The three typed failure members (D-03/D-11's report-don't-destroy
 * posture). `REGION_DAMAGED` and `ISSUE_UNREADABLE` are spelled the same as
 * `OPERATION_REASON.REGION_DAMAGED` in `github-sync-reconcile.cts`;
 * `DEPENDENCY_SLOT_MISMATCH` (plan 05-06) is spelled the same as that
 * module's `OPERATION_REASON.DEPENDENCY_SLOT_MISMATCH` for the identical
 * reason — a splice whose result carries a slot count that disagrees with
 * the dependency count is a typed refusal, never a dispatched body.
 */
const ISSUE_UPDATE_REASON = Object.freeze({
  REGION_DAMAGED: 'region_damaged',
  ISSUE_UNREADABLE: 'issue_unreadable',
  DEPENDENCY_SLOT_MISMATCH: 'dependency_slot_mismatch',
} as const);
type IssueUpdateReasonValue = typeof ISSUE_UPDATE_REASON[keyof typeof ISSUE_UPDATE_REASON];

interface IssueUpdateReport {
  logicalKey: string;
  issueNumber?: number;
  reason: IssueUpdateReasonValue;
  detail: string;
}

interface PrepareIssueUpdatesAdapters {
  cwd: string;
  /** Test seam (the `_`-prefixed convention this codebase already uses, applied without the underscore here since this is the module's own primary adapter, matching `applyMutationPlan`'s `execGh`). Defaults to the real spawn seam. */
  execGh?: (args: string[], opts: { cwd?: string; includeHeaders?: boolean }) => GhResult;
}

interface PrepareIssueUpdatesResult {
  operations: MutationOperation[];
  reports: IssueUpdateReport[];
}

/**
 * Never throws. Per pending update, in dispatch order: re-check the
 * owner/repo charset guard (re-asserted here rather than inherited on trust
 * — T-04-02), read the issue with an explicit GET (the same LIVE FINDING
 * `readRestList` encodes: `gh api` silently switches to POST the instant any
 * `-f`/`-F` value is supplied with no explicit `--method`/`-X`), splice the
 * freshly rendered region into the fetched body by severity, and — for
 * anything but a damaged result — build a PATCH operation carrying no
 * labels entry (GitHub's issue-update endpoint replaces the whole label set
 * rather than merging it; resending the GSD label on every content update
 * would silently delete a label a developer added by hand). A damaged
 * splice or an unreadable read is a typed report, never a thrown error and
 * never a partial operation — one bad issue never suppresses the rest of
 * the run.
 */
function prepareIssueUpdates(pending: PendingIssueUpdate[], adapters: PrepareIssueUpdatesAdapters): PrepareIssueUpdatesResult {
  const execGh = adapters.execGh ?? ghMod.execGh;
  const operations: MutationOperation[] = [];
  const reports: IssueUpdateReport[] = [];

  for (const item of pending) {
    const { owner, repo } = item.completionContext;
    if (!PATH_SAFE_TARGET.test(owner) || !PATH_SAFE_TARGET.test(repo) || item.issueNumber === undefined) {
      reports.push({
        logicalKey: item.logicalKey,
        issueNumber: item.issueNumber,
        reason: ISSUE_UPDATE_REASON.ISSUE_UNREADABLE,
        detail: 'the owner, repo, or issue number could not be safely resolved for a read',
      });
      continue;
    }

    const restApiPath = phaseIssueRestPath(owner, repo, `/issues/${item.issueNumber}`);
    if (!restApiPath) {
      // Unreachable in practice given the guard above — kept as a typed
      // fallback rather than a non-null assertion (T-04-02: re-assert at the
      // point of the call, never trust an upstream gate alone).
      reports.push({
        logicalKey: item.logicalKey,
        issueNumber: item.issueNumber,
        reason: ISSUE_UPDATE_REASON.ISSUE_UNREADABLE,
        detail: 'the owner/repo target failed the path-safety charset check',
      });
      continue;
    }

    const readResult = execGh(['api', restApiPath, '-X', 'GET'], { cwd: adapters.cwd, includeHeaders: false });
    if (readResult.exitCode !== 0) {
      reports.push({
        logicalKey: item.logicalKey,
        issueNumber: item.issueNumber,
        reason: ISSUE_UPDATE_REASON.ISSUE_UNREADABLE,
        detail: `gh exited ${readResult.exitCode} reading the issue`,
      });
      continue;
    }

    const root = decodeResponseRoot(OPERATION_TRANSPORT.REST, readResult.stdout);
    const rawBody = root?.body;
    const currentBody = rawBody === null ? '' : rawBody;
    if (root === null || typeof currentBody !== 'string') {
      reports.push({
        logicalKey: item.logicalKey,
        issueNumber: item.issueNumber,
        reason: ISSUE_UPDATE_REASON.ISSUE_UNREADABLE,
        detail: 'the issue body could not be decoded from the response',
      });
      continue;
    }

    const spliced = spliceRegion(currentBody, item.region);
    if (spliced.kind === SPLICE_RESULT.DAMAGED) {
      reports.push({
        logicalKey: item.logicalKey,
        issueNumber: item.issueNumber,
        reason: ISSUE_UPDATE_REASON.REGION_DAMAGED,
        detail: spliced.detail,
      });
      continue;
    }

    // Plan 05-06 Task 2: the spliced body may carry dependency-reference
    // sentinel slots (05-03) — route it through the same composer the
    // create path uses, so a splice whose result carries a slot count that
    // disagrees with `item.dependsOn` is reported, never dispatched.
    const bodyResult = bodyArgvEntry(spliced.body, item.dependsOn ?? []);
    if (bodyResult.kind === 'mismatch') {
      reports.push({
        logicalKey: item.logicalKey,
        issueNumber: item.issueNumber,
        reason: ISSUE_UPDATE_REASON.DEPENDENCY_SLOT_MISMATCH,
        detail: bodyResult.detail,
      });
      continue;
    }

    const milestoneRef: ArgvRef = { from: item.milestoneKey, part: ARGV_REF_PART.NUMBER, prefix: 'milestone=' };
    operations.push({
      kind: 'update-issue',
      logicalKey: item.issueKey,
      args: [
        'api', restApiPath, '-X', 'PATCH',
        // SECURITY: title/body ride the raw -f flag — never the typed -F
        // flag, which performs @-file and {owner}/{repo} substitution.
        '-f', `title=${item.title}`,
        '-f', bodyResult.entry,
        '-F', milestoneRef,
        // Deliberately no `labels[]=` entry of any kind (RESEARCH Pitfall 2).
      ],
      completionContext: item.completionContext,
      transport: OPERATION_TRANSPORT.REST,
      action: OPERATION_ACTION.UPDATE,
      hasPointsBudget: false,
      // A body edit creates no new content — never paced against the
      // content-creation clock.
      contentCreation: false,
      captures: [{
        kind: 'node',
        logicalKey: item.issueKey,
        nodeIdPath: 'node_id',
        numberPath: 'number',
        plannerFields: { contentHash: item.contentHash },
      }],
    });
  }

  return { operations, reports };
}

export = { prepareIssueUpdates, ISSUE_UPDATE_REASON };
