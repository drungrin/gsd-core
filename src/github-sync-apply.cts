'use strict';
/** Serial, checkpointed mutation interpreter for github-sync reconciliation plans. */

import ghMod = require('./github-sync-gh.cjs');
import mapMod = require('./github-sync-map.cjs');
import clockMod = require('./clock.cjs');
import type { SyncCompletion, SyncMap } from './github-sync-map.cts';

interface MutationOperation {
  kind: string;
  logicalKey: string;
  args?: string[];
  completion?: Omit<SyncCompletion, 'completedAt'>;
}

interface MutationPlan { operations: MutationOperation[]; }
interface GhResult {
  exitCode: number;
  reason: string;
  stdout: string;
  stderr: string;
  response?: { available: boolean; status: number | null; retry_after_seconds: number | null };
}

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
const CONTENT_CREATE_INTERVAL_MS = 750; // 80 content-generating requests/minute.
const RETRY_REMEDIATION = 'Retry the sync after resolving the reported GitHub failure.';
const CREATE_UNCERTAIN_REMEDIATION = 'Re-read GitHub and reconcile before retrying this content create.';
const CHECKPOINT_UNCERTAIN_REMEDIATION = 'Repair the local sync map before running sync again.';

function rateLimitIsPresent(result: GhResult): boolean {
  try {
    const parsed = JSON.parse(result.stdout) as { data?: { rateLimit?: { cost?: unknown; remaining?: unknown } } };
    const rateLimit = parsed.data?.rateLimit;
    return typeof rateLimit?.cost === 'number' && typeof rateLimit.remaining === 'number';
  } catch {
    return false;
  }
}

function isRateLimited(result: GhResult): boolean {
  return result.response?.available === true && (result.response.status === 429 || result.response.status === 403);
}

function isTransient(result: GhResult): boolean {
  return result.reason === 'gh_exit_nonzero' && /(?:connection|reset|temporar|network|econn)/i.test(result.stderr);
}

function retryDelayMs(result: GhResult, retry: number, random: () => number): number {
  const retryAfter = result.response?.retry_after_seconds;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1000;
  return (1000 * (2 ** (retry - 1))) + Math.floor(random() * 250);
}

function completionFor(operation: MutationOperation, nowIso: string): SyncCompletion | null {
  if (!operation.completion || typeof operation.completion !== 'object') return null;
  return { ...operation.completion, completedAt: nowIso };
}

/**
 * Interpret operations in planner order. The only advancing transition is a
 * confirmed mutation followed by a durable complete-map checkpoint.
 */
function applyMutationPlan(plan: MutationPlan, adapters: ApplyAdapters): ApplyResult {
  const execGh = adapters.execGh ?? ghMod.execGh;
  const recordCompletion = adapters.recordCompletion ?? mapMod.recordCompletion;
  const writeSyncMapAtomically = adapters.writeSyncMapAtomically ?? mapMod.writeSyncMapAtomically;
  const clock = adapters.clock ?? clockMod.realClock;
  const random = adapters.random ?? Math.random;
  const notice = adapters.notice ?? (() => {});
  let currentMap = adapters.map;
  let lastContentCreateAt: number | null = null;

  for (const operation of plan.operations) {
    if (!Array.isArray(operation.args) || operation.args.length === 0) {
      return { kind: 'failed', logicalKey: operation.logicalKey, remediation: RETRY_REMEDIATION };
    }
    if (operation.kind === 'create' && lastContentCreateAt !== null) {
      const remaining = CONTENT_CREATE_INTERVAL_MS - (clock.now() - lastContentCreateAt);
      if (remaining > 0) {
        notice(`github-sync: pacing content creation for ${remaining}ms.`);
        clock.sleep(remaining);
      }
    }

    let retries = 0;
    while (true) {
      const result = execGh(operation.args, { cwd: adapters.cwd, includeHeaders: true });
      if (result.exitCode === 0 && rateLimitIsPresent(result)) {
        const completion = completionFor(operation, clock.nowIso());
        if (!completion) return { kind: 'failed', logicalKey: operation.logicalKey, remediation: RETRY_REMEDIATION };
        try {
          const nextMap = recordCompletion(currentMap, completion);
          writeSyncMapAtomically(adapters.cwd, nextMap);
          currentMap = nextMap;
        } catch {
          return { kind: 'uncertain', logicalKey: operation.logicalKey, remediation: CHECKPOINT_UNCERTAIN_REMEDIATION };
        }
        if (operation.kind === 'create') lastContentCreateAt = clock.now();
        break;
      }

      if (operation.kind === 'create' && result.reason === 'gh_timed_out') {
        return { kind: 'uncertain', logicalKey: operation.logicalKey, remediation: CREATE_UNCERTAIN_REMEDIATION };
      }
      if (!(isRateLimited(result) || isTransient(result)) || retries >= RETRY_LIMIT) {
        return { kind: 'failed', logicalKey: operation.logicalKey, remediation: RETRY_REMEDIATION };
      }
      retries += 1;
      const delay = retryDelayMs(result, retries, random);
      notice(`github-sync: retrying ${operation.logicalKey} in ${delay}ms.`);
      clock.sleep(delay);
    }
  }
  return { kind: 'completed', map: currentMap };
}

export = { applyMutationPlan, CONTENT_CREATE_INTERVAL_MS, RETRY_LIMIT };
