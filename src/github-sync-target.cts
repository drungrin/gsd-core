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

type SyncTargetReadResult =
  | { available: true; reason: typeof SYNC_TARGET_REASON.OK; target: SyncTarget }
  | { available: false; reason: typeof SYNC_TARGET_REASON.UNAVAILABLE };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function unavailable(): SyncTargetReadResult {
  return { available: false, reason: SYNC_TARGET_REASON.UNAVAILABLE };
}

/**
 * Read only the declared github_sync.target shape. Invalid or unavailable
 * configuration is deliberately not guessed: callers must take their safe
 * unavailable/blocked terminal path before any remote or map operation.
 */
function readSyncTarget(cwd: string): SyncTargetReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(cwd, '.planning', 'config.json'), 'utf8'));
  } catch {
    return unavailable();
  }
  if (!isRecord(parsed) || !isRecord(parsed.github_sync) || !isRecord(parsed.github_sync.target)) return unavailable();
  const target = parsed.github_sync.target;
  if (!['owner', 'repo', 'repository_number', 'project_number'].every((key) => Object.hasOwn(target, key)) ||
    Object.keys(target).length !== 4 || !isNonEmptyString(target.owner) || !isNonEmptyString(target.repo) ||
    !isPositiveSafeInteger(target.repository_number) || !isPositiveSafeInteger(target.project_number)) return unavailable();
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

export = { readSyncTarget, SYNC_TARGET_REASON };
