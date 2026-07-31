'use strict';
/** Serial, checkpointed mutation interpreter for github-sync reconciliation plans. */

import ghMod = require('./github-sync-gh.cjs');
import mapMod = require('./github-sync-map.cjs');
import clockMod = require('./clock.cjs');
import type { SyncCompletion, SyncMap } from './github-sync-map.cts';

interface MutationOperation {
  kind: string;
  logicalKey: string;
  args: string[];
  completionContext: { owner: string; repo: string; repositoryNumber: number };
  responsePayloadKey: string;
  contentCreation: boolean;
}
interface MutationPlan { operations: MutationOperation[]; }
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
  | { kind: 'completed'; map: SyncMap | null }
  | { kind: 'failed'; logicalKey: string; remediation: string }
  | { kind: 'uncertain'; logicalKey: string; remediation: string };

const RETRY_LIMIT = 3;
const CONTENT_CREATE_INTERVAL_MS = 750;
const POINTS_RESERVE = 100;
const RETRY_REMEDIATION = 'Retry the sync after resolving the reported GitHub failure.';
const CREATE_UNCERTAIN_REMEDIATION = 'Re-read GitHub and reconcile before retrying this content create.';
const CHECKPOINT_UNCERTAIN_REMEDIATION = 'Repair the local sync map before running sync again.';

function parseData(result: GhResult): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const envelope = parsed as { data?: unknown; errors?: unknown };
    if (Array.isArray(envelope.errors) && envelope.errors.length > 0) return null;
    return envelope.data !== null && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
      ? envelope.data as Record<string, unknown> : null;
  } catch { return null; }
}

function parseRateLimit(result: GhResult): RateLimit | null {
  const rateLimit = parseData(result)?.rateLimit;
  if (rateLimit === null || typeof rateLimit !== 'object' || Array.isArray(rateLimit)) return null;
  const { cost, remaining, resetAt } = rateLimit as Record<string, unknown>;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0 ||
      typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0 ||
      typeof resetAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(resetAt) || Number.isNaN(Date.parse(resetAt))) return null;
  return { cost, remaining, resetAt };
}

function isOperation(operation: MutationOperation): boolean {
  const context = operation.completionContext;
  return Array.isArray(operation.args) && operation.args.length > 0 && operation.args.every((arg) => typeof arg === 'string') &&
    typeof operation.logicalKey === 'string' && operation.logicalKey.length > 0 &&
    typeof operation.responsePayloadKey === 'string' && operation.responsePayloadKey.length > 0 &&
    typeof operation.contentCreation === 'boolean' && context !== null && typeof context === 'object' &&
    typeof context.owner === 'string' && context.owner.length > 0 && typeof context.repo === 'string' && context.repo.length > 0 &&
    Number.isSafeInteger(context.repositoryNumber) && context.repositoryNumber > 0;
}

function decodeConfirmedCompletion(operation: MutationOperation, result: GhResult, completedAt: string): SyncCompletion | null {
  if (!isOperation(operation)) return null;
  const payload = parseData(result)?.[operation.responsePayloadKey];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const item = (payload as Record<string, unknown>).projectV2Item;
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
  const { id, content } = item as Record<string, unknown>;
  if (typeof id !== 'string' || id.length === 0) return null;
  let issueNumber: number | undefined;
  if (content !== null && content !== undefined) {
    if (typeof content !== 'object' || Array.isArray(content)) return null;
    const number = (content as Record<string, unknown>).number;
    if (number !== undefined) {
      if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return null;
      issueNumber = number;
    }
  }
  return { logicalKey: operation.logicalKey, nodeId: id, ...(issueNumber === undefined ? {} : { issueNumber }), completedAt,
    owner: operation.completionContext.owner, repo: operation.completionContext.repo, repositoryNumber: operation.completionContext.repositoryNumber };
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

  for (const operation of plan.operations) {
    if (!isOperation(operation)) return { kind: 'failed', logicalKey: operation.logicalKey, remediation: RETRY_REMEDIATION };
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
      const result = execGh(operation.args, { cwd: adapters.cwd, includeHeaders: true });
      if (result.exitCode === 0) {
        const rateLimit = parseRateLimit(result);
        const completion = decodeConfirmedCompletion(operation, result, clock.nowIso());
        if (!rateLimit || !completion) return { kind: 'failed', logicalKey: operation.logicalKey, remediation: RETRY_REMEDIATION };
        const delay = pointsDelayMs(rateLimit, clock.now());
        if (delay === null) return { kind: 'failed', logicalKey: operation.logicalKey, remediation: RETRY_REMEDIATION };
        try {
          const nextMap = recordCompletion(currentMap, completion);
          writeSyncMapAtomically(adapters.cwd, nextMap);
          currentMap = nextMap;
        } catch { return { kind: 'uncertain', logicalKey: operation.logicalKey, remediation: CHECKPOINT_UNCERTAIN_REMEDIATION }; }
        pendingPointsDelay = delay;
        if (operation.contentCreation) lastContentCreateAt = clock.now();
        break;
      }
      if (operation.contentCreation && result.reason === 'gh_timed_out') return { kind: 'uncertain', logicalKey: operation.logicalKey, remediation: CREATE_UNCERTAIN_REMEDIATION };
      if (!(isRateLimited(result) || isTransient(result)) || retries >= RETRY_LIMIT) return { kind: 'failed', logicalKey: operation.logicalKey, remediation: RETRY_REMEDIATION };
      retries += 1;
      const delay = retryDelayMs(result, retries, random);
      notice(`github-sync: retrying ${operation.logicalKey} in ${delay}ms.`);
      clock.sleep(delay);
    }
  }
  return { kind: 'completed', map: currentMap };
}

export = { applyMutationPlan, CONTENT_CREATE_INTERVAL_MS, POINTS_RESERVE, RETRY_LIMIT, parseRateLimit, decodeConfirmedCompletion };
