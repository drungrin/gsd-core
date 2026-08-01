/**
 * Durable, repository-bound checkpoint map for the one-way GitHub sync.
 *
 * The file is deliberately a closed schema: it contains only stable operation
 * identifiers and checkpoint metadata, never credentials or GraphQL payloads.
 *
 * D-05/D-07 (plan 03-01/03-02): `SyncCompletion.logicalKey` also carries the
 * reserved bootstrap namespace approved in plan 03-01 Task 1 (`project`,
 * `project-link`, `field:<slug>`, `option:status:<slug>`, `label:<slug>`,
 * `milestone:<version>`), alongside Phase 2's `phase:<id>` convention.
 * `SyncCompletion.issueNumber` is the generic remote-number slot — it is not
 * issue-specific, and bootstrap reuses it for a project number, a field's
 * declared type ordinal, or a milestone number, whichever the completion
 * represents. No schema field, validator, or `SYNC_MAP_VERSION` changes.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SYNC_MAP_FILE_NAME = '.github-sync.json';
export const SYNC_MAP_VERSION = '1';

export interface RepositoryIdentity {
  owner: string;
  repo: string;
  number: number;
}

export interface SyncCompletion {
  logicalKey: string;
  nodeId: string;
  issueNumber?: number;
  completedAt: string;
  owner: string;
  repo: string;
  repositoryNumber: number;
}

export interface SyncMap {
  version: typeof SYNC_MAP_VERSION;
  repository: RepositoryIdentity;
  completions: Record<string, SyncCompletion>;
}

export type SyncMapReadResult =
  | { kind: 'absent' }
  | { kind: 'valid'; map: SyncMap }
  | { kind: 'blocking'; reason: 'invalid_schema' | 'unsupported_version' | 'unreadable' | 'repository_mismatch' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRepositoryIdentity(value: unknown): value is RepositoryIdentity {
  if (!isRecord(value) || !hasOnlyKeys(value, ['owner', 'repo', 'number'])) return false;
  return isNonEmptyString(value.owner) && isNonEmptyString(value.repo) &&
    typeof value.number === 'number' && Number.isSafeInteger(value.number) && value.number > 0;
}

function isCompletion(value: unknown): value is SyncCompletion {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'logicalKey', 'nodeId', 'issueNumber', 'completedAt', 'owner', 'repo', 'repositoryNumber',
  ])) return false;
  if (!isNonEmptyString(value.logicalKey) || !isNonEmptyString(value.nodeId) ||
    !isNonEmptyString(value.completedAt) || !isNonEmptyString(value.owner) || !isNonEmptyString(value.repo)) return false;
  if (Number.isNaN(Date.parse(value.completedAt))) return false;
  const issueNumber = value.issueNumber;
  const repositoryNumber = value.repositoryNumber;
  if (issueNumber !== undefined && (typeof issueNumber !== 'number' || !Number.isSafeInteger(issueNumber) || issueNumber <= 0)) return false;
  return typeof repositoryNumber === 'number' && Number.isSafeInteger(repositoryNumber) && repositoryNumber > 0;
}

function sameRepository(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return left.owner === right.owner && left.repo === right.repo && left.number === right.number;
}

function isSyncMap(value: unknown): value is SyncMap {
  if (!isRecord(value) || !hasOnlyKeys(value, ['version', 'repository', 'completions'])) return false;
  const mapRepository = value.repository;
  const completions = value.completions;
  if (value.version !== SYNC_MAP_VERSION || !isRepositoryIdentity(mapRepository) || !isRecord(completions)) return false;
  return Object.entries(completions).every(([logicalKey, completion]) =>
    logicalKey.length > 0 && isCompletion(completion) && completion.logicalKey === logicalKey &&
    completion.owner === mapRepository.owner && completion.repo === mapRepository.repo &&
    completion.repositoryNumber === mapRepository.number,
  );
}

/**
 * Read state without changing it. A present invalid, unreadable, or foreign map
 * remains in place and blocks callers from applying remote writes.
 */
export function readSyncMapStrict(repoDir: string, repository: RepositoryIdentity): SyncMapReadResult {
  const filePath = path.join(repoDir, '.planning', SYNC_MAP_FILE_NAME);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'blocking', reason: 'unreadable' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'blocking', reason: 'invalid_schema' };
  }
  if (isRecord(parsed) && typeof parsed.version === 'string' && parsed.version !== SYNC_MAP_VERSION) {
    return { kind: 'blocking', reason: 'unsupported_version' };
  }
  if (!isSyncMap(parsed)) return { kind: 'blocking', reason: 'invalid_schema' };
  if (!sameRepository(parsed.repository, repository)) return { kind: 'blocking', reason: 'repository_mismatch' };
  return { kind: 'valid', map: parsed };
}

/**
 * Return a complete new checkpoint from trusted completed-operation data. The
 * input is intentionally the narrow SyncCompletion shape rather than a remote
 * response, so transport payloads and credentials have no persistence path.
 */
export function recordCompletion(current: SyncMap | null, completion: SyncCompletion): SyncMap {
  const repository: RepositoryIdentity = current?.repository ?? {
    owner: completion.owner,
    repo: completion.repo,
    number: completion.repositoryNumber,
  };
  if (!isCompletion(completion) || !sameRepository(repository, {
    owner: completion.owner,
    repo: completion.repo,
    number: completion.repositoryNumber,
  })) {
    throw new Error('Cannot record a completion that is not bound to the current repository.');
  }
  return {
    version: SYNC_MAP_VERSION,
    repository: { ...repository },
    completions: { ...(current?.completions ?? {}), [completion.logicalKey]: { ...completion } },
  };
}

function fsyncContainingDir(filePath: string): void {
  let dirFd: number | null = null;
  try {
    dirFd = fs.openSync(path.dirname(filePath), 'r');
    fs.fsyncSync(dirFd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EISDIR' || code === 'EPERM' || code === 'EINVAL' || code === 'EBADF') return;
    throw new Error(`Directory fsync for ${path.dirname(filePath)} failed; checkpoint durability is uncertain: ${(err as Error).message}`);
  } finally {
    if (dirFd !== null) {
      try { fs.closeSync(dirFd); } catch { /* best effort after directory fsync */ }
    }
  }
}

/**
 * Replace the complete map with a same-directory, exclusive temporary file.
 * No installed map is edited in place; a failed pre-rename step leaves the
 * previous checkpoint available for repair/reconciliation.
 */
export function writeSyncMapAtomically(repoDir: string, map: SyncMap): void {
  if (!isSyncMap(map)) throw new Error('Refusing to persist an invalid sync map.');
  const planningDir = path.join(repoDir, '.planning');
  const filePath = path.join(planningDir, SYNC_MAP_FILE_NAME);
  fs.mkdirSync(planningDir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmpPath, 'wx');
  let writeError: Error | null = null;
  try {
    fs.writeFileSync(fd, JSON.stringify(map, null, 2) + '\n');
    fs.fsyncSync(fd);
  } catch (err) {
    writeError = err instanceof Error ? err : new Error(String(err));
  } finally {
    let closeError: Error | null = null;
    try { fs.closeSync(fd); } catch (err) { closeError = err instanceof Error ? err : new Error(String(err)); }
    if (writeError !== null || closeError !== null) {
      try { fs.unlinkSync(tmpPath); } catch { /* best effort temp cleanup */ }
      throw writeError ?? closeError;
    }
  }
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* best effort temp cleanup */ }
    throw err;
  }
  fsyncContainingDir(filePath);
}
