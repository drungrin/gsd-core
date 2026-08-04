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
 *
 * Plan 04-03 Task 3 (D-09): `contentHash` and `fieldState` are added as
 * optional flat-string members, widening the allow-list without loosening
 * it — an unknown key is still rejected. `SYNC_MAP_VERSION` deliberately
 * does not bump: both keys are optional, every map already on disk remains
 * valid under the widened allow-list, and no map has shipped to a developer
 * yet (D-09 records no installed map exists to protect), so a version bump
 * would only force a needless re-`init` for zero migration benefit.
 *
 * Plan 07-01 (D-08): `absenceCount` and `absenceFirstSeenAt` widen the same
 * allow-list the identical way — two more optional flat scalars, no
 * `SYNC_MAP_VERSION` bump, every map already on disk stays valid. D-08's own
 * watch-out: `recordCompletion` below is a WHOLESALE REPLACE of whatever was
 * previously recorded at a logical key — it silently wiped `contentHash`
 * twice already (plans 05-05 and 05-06, both genuine live convergence bugs,
 * WINDOWS #9). The absence marker must never be re-losable the same way:
 * every capture that writes it goes through `mergeCompletion` below, never a
 * bare `recordCompletion` call built from a partial object.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SYNC_MAP_FILE_NAME = '.github-sync.json';
export const SYNC_MAP_VERSION = '1';

/**
 * D-08 (plan 05-06): the plan issue's own recorded open/closed state — the
 * second state machine P4 D-16 deliberately refused for phases (a
 * hand-edited roadmap checkbox is too weak a signal) and deferred here, now
 * justified because a sibling `SUMMARY.md`'s presence is a far stronger one.
 * A flat scalar restricted to exactly these two literals, following the same
 * closed-schema discipline `contentHash`/`fieldState` already established.
 */
export const ISSUE_STATE = Object.freeze({
  OPEN: 'open',
  CLOSED: 'closed',
} as const);
export type IssueStateValue = typeof ISSUE_STATE[keyof typeof ISSUE_STATE];

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
  /** D-08/D-13: the issue-content projection's hash (title, region, milestone number together). */
  contentHash?: string;
  /** D-09/D-12: the serialized per-field convergence state (`renderFieldState`). */
  fieldState?: string;
  /** D-08 (plan 05-06): the plan issue's own recorded open/closed state — see `ISSUE_STATE`. */
  issueState?: IssueStateValue;
  /** D-08 (plan 07-01): the number of consecutive confirmed absences recorded for this key. Cleared on a `present` verdict. */
  absenceCount?: number;
  /** D-08 (plan 07-01): the ISO 8601 instant the FIRST confirmed absence was recorded — never restamped by later confirmations. Cleared on a `present` verdict. */
  absenceFirstSeenAt?: string;
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
    'contentHash', 'fieldState', 'issueState', 'absenceCount', 'absenceFirstSeenAt',
  ])) return false;
  if (!isNonEmptyString(value.logicalKey) || !isNonEmptyString(value.nodeId) ||
    !isNonEmptyString(value.completedAt) || !isNonEmptyString(value.owner) || !isNonEmptyString(value.repo)) return false;
  if (Number.isNaN(Date.parse(value.completedAt))) return false;
  const issueNumber = value.issueNumber;
  const repositoryNumber = value.repositoryNumber;
  if (issueNumber !== undefined && (typeof issueNumber !== 'number' || !Number.isSafeInteger(issueNumber) || issueNumber <= 0)) return false;
  if (value.contentHash !== undefined && !isNonEmptyString(value.contentHash)) return false;
  if (value.fieldState !== undefined && !isNonEmptyString(value.fieldState)) return false;
  if (value.issueState !== undefined && value.issueState !== ISSUE_STATE.OPEN && value.issueState !== ISSUE_STATE.CLOSED) return false;
  if (value.absenceCount !== undefined && (typeof value.absenceCount !== 'number' || !Number.isSafeInteger(value.absenceCount) || value.absenceCount <= 0)) return false;
  if (value.absenceFirstSeenAt !== undefined && !isNonEmptyString(value.absenceFirstSeenAt)) return false;
  return typeof repositoryNumber === 'number' && Number.isSafeInteger(repositoryNumber) && repositoryNumber > 0;
}

/**
 * D-08 (plan 07-01): merges `next` onto `previous` (when supplied), then
 * deletes every member named in `options.clear`. Exists because
 * `recordCompletion` below replaces the WHOLE completion object at a key
 * rather than merging into it — every capture that must preserve
 * previously-recorded optional members (the absence marker included) goes
 * through this helper, never a bare object literal built from scratch. The
 * explicit `clear` list exists so that erasing a member — which the D-08
 * marker lifecycle requires on a `present` verdict — is always a stated
 * intent, never an accident of omission.
 */
export function mergeCompletion(
  previous: SyncCompletion | undefined,
  next: Partial<SyncCompletion>,
  options: { clear?: ReadonlyArray<keyof SyncCompletion> } = {},
): SyncCompletion {
  const merged: Partial<SyncCompletion> = { ...(previous ?? {}), ...next };
  for (const key of options.clear ?? []) {
    delete merged[key];
  }
  return merged as SyncCompletion;
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

/**
 * DEFECT.WINDOWS-FS-OPS: on Windows a concurrent reader or antivirus scanner
 * can transiently hold the rename target open, throwing EPERM/EBUSY/EACCES.
 * Bounded exponential-ish retry on those three errnos only (mirrors
 * `src/github-sync-bootstrap-config.cts`'s `renameWithRetry`); any other
 * error, or the final attempt, rethrows immediately. Pre-existing lint
 * findings (`@typescript-eslint/only-throw-error`, `local/require-fs-op-
 * fallback`) fixed alongside this plan's own edits to this file, matching
 * plan 04-02's established precedent of satisfying a whole-file
 * `eslint ... 0 warnings` acceptance criterion.
 */
const RENAME_RETRY_ERRNOS = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_MAX_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 25;

function renameWithRetry(tmpPath: string, targetPath: string): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(tmpPath, targetPath);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code && RENAME_RETRY_ERRNOS.has(code) && attempt < RENAME_MAX_ATTEMPTS - 1) {
        const delay = RENAME_BACKOFF_MS * Math.pow(2, attempt);
        const start = Date.now();
        while (Date.now() - start < delay) {
          // Busy-wait a very short time — Windows transient locks usually clear in <100ms.
        }
        continue;
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
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
      throw writeError ?? closeError ?? new Error('Unknown failure writing the sync map temp file.');
    }
  }
  try {
    renameWithRetry(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* best effort temp cleanup */ }
    throw err;
  }
  fsyncContainingDir(filePath);
}
