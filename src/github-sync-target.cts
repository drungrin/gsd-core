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
// leaf members name the specific field that failed its own validation.
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
 * The `field` discriminator is assigned in a fixed evaluation order: an
 * unreadable or unparseable config file reports `config`; a non-object root,
 * a missing/non-object `github_sync`, a missing/non-object `target`, or a
 * target whose key set isn't exactly the four required keys all report the
 * generic `target` fallback; otherwise the first field failing its own
 * validity check reports that field's name, checked in the order owner,
 * repo, repository_number, project_number. The `isRecord`/`isNonEmptyString`/
 * `isPositiveSafeInteger` predicates below remain the single source of
 * validity, so the discriminator can never disagree with the accept/reject
 * decision itself — which is unchanged by this catalog.
 */
function readSyncTarget(cwd: string): SyncTargetReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(cwd, '.planning', 'config.json'), 'utf8'));
  } catch {
    return unavailable(SYNC_TARGET_FIELD.CONFIG);
  }
  if (!isRecord(parsed) || !isRecord(parsed.github_sync) || !isRecord(parsed.github_sync.target)) return unavailable(SYNC_TARGET_FIELD.TARGET);
  const target = parsed.github_sync.target;
  if (!['owner', 'repo', 'repository_number', 'project_number'].every((key) => Object.hasOwn(target, key)) ||
    Object.keys(target).length !== 4) return unavailable(SYNC_TARGET_FIELD.TARGET);
  if (!isNonEmptyString(target.owner)) return unavailable(SYNC_TARGET_FIELD.OWNER);
  if (!isNonEmptyString(target.repo)) return unavailable(SYNC_TARGET_FIELD.REPO);
  if (!isPositiveSafeInteger(target.repository_number)) return unavailable(SYNC_TARGET_FIELD.REPOSITORY_NUMBER);
  if (!isPositiveSafeInteger(target.project_number)) return unavailable(SYNC_TARGET_FIELD.PROJECT_NUMBER);
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
