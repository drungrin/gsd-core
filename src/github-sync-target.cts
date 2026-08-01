'use strict';
/** Resolve the closed repository and project identity for github-sync reads. */

import fs from 'node:fs';
import path from 'node:path';

interface SyncTarget {
  owner: string;
  repo: string;
  repositoryNumber: number;
  projectNumber: number;
}

const SYNC_TARGET_REASON = Object.freeze({
  OK: 'ok',
  UNAVAILABLE: 'target_unavailable',
} as const);

// G-02-4: a closed field discriminator on the unavailable result. `target` is
// the generic fallback for anything readSyncTarget rejects before it can even
// identify a single leaf field (missing/wrong-shaped root, github_sync, or
// target, or a target whose key set isn't exactly the four required keys).
// `config` covers an unreadable/unparseable .planning/config.json. The four
// leaf members name the specific field that failed its own validation. This
// task wires `repository_number` precisely; the remaining leaf fields fan out
// in the next task, routed through `target` until then.
const SYNC_TARGET_FIELD = Object.freeze({
  CONFIG: 'config',
  TARGET: 'target',
  OWNER: 'owner',
  REPO: 'repo',
  REPOSITORY_NUMBER: 'repository_number',
  PROJECT_NUMBER: 'project_number',
} as const);

type SyncTargetField = typeof SYNC_TARGET_FIELD[keyof typeof SYNC_TARGET_FIELD];

type SyncTargetReadResult =
  | { available: true; reason: typeof SYNC_TARGET_REASON.OK; target: SyncTarget }
  | { available: false; reason: typeof SYNC_TARGET_REASON.UNAVAILABLE; field: SyncTargetField };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function unavailable(field: SyncTargetField): SyncTargetReadResult {
  return { available: false, reason: SYNC_TARGET_REASON.UNAVAILABLE, field };
}

/**
 * Read only the declared github_sync.target shape. Invalid or unavailable
 * configuration is deliberately not guessed: callers must take their safe
 * unavailable/blocked terminal path before any remote or map operation.
 *
 * The `field` discriminator this task wires precisely: an unreadable or
 * unparseable config file reports `repository_number` when that is the sole
 * invalid value; every other rejection reports the generic `target` fallback
 * until the next task fans the remaining leaf fields out. Accept/reject
 * decisions themselves are unchanged.
 */
function readSyncTarget(cwd: string): SyncTargetReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(cwd, '.planning', 'config.json'), 'utf8'));
  } catch {
    return unavailable(SYNC_TARGET_FIELD.TARGET);
  }
  if (!isRecord(parsed) || !isRecord(parsed.github_sync) || !isRecord(parsed.github_sync.target)) return unavailable(SYNC_TARGET_FIELD.TARGET);
  const target = parsed.github_sync.target;
  if (!['owner', 'repo', 'repository_number', 'project_number'].every((key) => Object.hasOwn(target, key)) ||
    Object.keys(target).length !== 4 || !isNonEmptyString(target.owner) || !isNonEmptyString(target.repo)) return unavailable(SYNC_TARGET_FIELD.TARGET);
  if (!isPositiveSafeInteger(target.repository_number)) return unavailable(SYNC_TARGET_FIELD.REPOSITORY_NUMBER);
  if (!isPositiveSafeInteger(target.project_number)) return unavailable(SYNC_TARGET_FIELD.TARGET);
  return {
    available: true,
    reason: SYNC_TARGET_REASON.OK,
    target: {
      owner: target.owner,
      repo: target.repo,
      repositoryNumber: target.repository_number,
      projectNumber: target.project_number,
    },
  };
}

export = { readSyncTarget, SYNC_TARGET_REASON, SYNC_TARGET_FIELD };
