'use strict';
/**
 * github-sync-bootstrap-config.cts — the config surface `init` reads and
 * writes (plan 03-03 Task 3, D-01/D-02). Three responsibilities:
 *
 * - `readPartialSyncTarget` tolerates a target missing only its
 *   `project_number` — the exact case `readSyncTarget`
 *   (`github-sync-target.cts`) cannot serve, because it discards every valid
 *   value the moment one key fails its all-or-nothing check.
 * - `resolveTarget` composes an explicitly-configured target, a
 *   partially-configured one, a `gh repo view` fallback, and a sync-map
 *   project-number recovery, in that corrected order (D-01/D-02) — see the
 *   long comment at its declaration for why the ordering is load-bearing.
 * - `writeProjectNumber` is the one narrowly-scoped exception to this
 *   capability's one-way disk-to-GitHub direction: it persists a resolved
 *   `project_number` back into `.planning/config.json`, atomically and
 *   shape-preservingly, so the developer's next `status`/`sync` needs no
 *   manual step.
 *
 * `readSyncTarget`'s validity predicates (non-empty string for owner/repo, a
 * positive safe integer for both numbers) are module-private there
 * (`github-sync-target.cts` exports only three symbols), so they are
 * necessarily duplicated here. A differential test in
 * `tests/github-sync-bootstrap-config.test.cjs` pins the two readers'
 * validity judgments against each other over a shared candidate table —
 * prose instructing parity cannot enforce it; the test does.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import targetMod = require('./github-sync-target.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import mapMod = require('./github-sync-map.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import bootstrapRemoteMod = require('./github-sync-bootstrap-remote.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ghMod = require('./github-sync-gh.cjs');

interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  reason: string;
}
type ExecGh = (args: string[], opts: { cwd?: string }) => GhResult;

const CONFIG_WRITE_REASON = Object.freeze({
  WRITTEN: 'written',
  UNREADABLE: 'config_unreadable',
  UNRECOGNIZED_SHAPE: 'unrecognized_shape',
  INVALID_NUMBER: 'invalid_project_number',
} as const);
type ConfigWriteReason = typeof CONFIG_WRITE_REASON[keyof typeof CONFIG_WRITE_REASON];

const RESOLVE_TARGET_REASON = Object.freeze({
  // readSyncTarget was already available — an explicitly configured value
  // always wins (D-01) and nothing is resolved.
  CONFIGURED: 'configured',
  // A partial config, `gh repo view`, and/or the sync map filled a complete
  // identity.
  RESOLVED: 'resolved',
  // The identity could not be completed by any of the three fallback steps.
  UNRESOLVABLE: 'unresolvable',
} as const);
type ResolveTargetReason = typeof RESOLVE_TARGET_REASON[keyof typeof RESOLVE_TARGET_REASON];

const TARGET_SHAPE = Object.freeze({
  ABSENT: 'absent',
  RECOGNIZED: 'recognized',
  UNRECOGNIZED: 'unrecognized',
} as const);
type TargetShape = typeof TARGET_SHAPE[keyof typeof TARGET_SHAPE];

interface PartialSyncTarget {
  owner: string | null;
  repo: string | null;
  repositoryNumber: number | null;
  projectNumber: number | null;
  shape: TargetShape;
}

interface ConfigWriteResult {
  ok: boolean;
  reason: ConfigWriteReason;
}

interface ResolvedTarget {
  owner: string;
  repo: string;
  repositoryNumber: number;
  projectNumber: number | null;
}

interface ResolvedTargetResult {
  target: ResolvedTarget | null;
  reason: ResolveTargetReason;
  /** The strict-map read this call performed, bound to the resolved identity — null when the identity could not be resolved. */
  strictMapRead: ReturnType<typeof mapMod.readSyncMapStrict> | null;
  /**
   * Plan 07-10 Task 3 (D-01 option-d): set ONLY when
   * `configuredProjectNumberConfirmedAbsent` overrode the configured
   * `project_number` with the sync map's own `project` completion number —
   * the original configured value, so a caller (e.g. `status`) can report
   * the divergence between what `.planning/config.json` says and what this
   * call actually resolved to. Absent on every other path, including the
   * ordinary CONFIGURED path where no override was requested or possible.
   */
  configuredProjectNumber?: number;
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

const TARGET_KEYS_FULL = ['owner', 'repo', 'repository_number', 'project_number'] as const;
const TARGET_KEYS_PARTIAL = ['owner', 'repo', 'repository_number'] as const;

/**
 * The single shape decision `readPartialSyncTarget` and `writeProjectNumber`
 * both consume — "apply the same validity predicates" made enforceable by
 * routing both callers through this one function rather than restating the
 * key-set check twice.
 */
function classifyTargetKeys(target: Record<string, unknown>): 'four-key' | 'three-key' | 'unrecognized' {
  const keys = Object.keys(target);
  if (keys.length === 4 && TARGET_KEYS_FULL.every((key) => Object.hasOwn(target, key))) return 'four-key';
  if (keys.length === 3 && TARGET_KEYS_PARTIAL.every((key) => Object.hasOwn(target, key))) return 'three-key';
  return 'unrecognized';
}

function readConfigRecord(cwd: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(cwd, '.planning', 'config.json'), 'utf8'));
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

/**
 * Partial-tolerant target reader (D-01). Applies the same validity
 * predicates `readSyncTarget` uses (non-empty string for owner/repo, a
 * positive safe integer for both numbers) but never discards a valid field
 * because a sibling field failed — the whole reason this reader exists.
 */
function readPartialSyncTarget(cwd: string): PartialSyncTarget {
  const absent: PartialSyncTarget = { owner: null, repo: null, repositoryNumber: null, projectNumber: null, shape: TARGET_SHAPE.ABSENT };

  const config = readConfigRecord(cwd);
  if (config === null) return absent;
  const githubSync = config.github_sync;
  if (!isRecord(githubSync) || !isRecord(githubSync.target)) return absent;
  const target = githubSync.target;

  const kind = classifyTargetKeys(target);
  if (kind === 'unrecognized') {
    return { owner: null, repo: null, repositoryNumber: null, projectNumber: null, shape: TARGET_SHAPE.UNRECOGNIZED };
  }

  return {
    owner: isNonEmptyString(target.owner) ? target.owner : null,
    repo: isNonEmptyString(target.repo) ? target.repo : null,
    repositoryNumber: isPositiveSafeInteger(target.repository_number) ? target.repository_number : null,
    projectNumber: kind === 'four-key' && isPositiveSafeInteger(target.project_number) ? target.project_number : null,
    shape: TARGET_SHAPE.RECOGNIZED,
  };
}

/** Returns the configured `github_sync.project_title`, or null when absent, empty, or non-string. */
function readProjectTitle(cwd: string): string | null {
  const config = readConfigRecord(cwd);
  if (config === null) return null;
  const githubSync = config.github_sync;
  if (!isRecord(githubSync)) return null;
  const title = githubSync.project_title;
  return isNonEmptyString(title) ? title : null;
}

/**
 * The closed `github_sync.view.layout` config spellings, mapped to the three
 * live-confirmed `ProjectV2ViewLayout` GraphQL enum members
 * (`06-VIEW-PROBE.md` Question 1; mirrors `github-sync-bootstrap-plan.cts`'s
 * `VIEW_LAYOUT` constant). Declared as a frozen module constant so the closed
 * set exists in exactly one place, and `readViewLayout`'s return type is this
 * map's value union rather than `string` — an unvalidated configured value
 * cannot typecheck into a `layout` GraphQL argv entry (T-06-01).
 */
const VIEW_LAYOUT_CONFIG = Object.freeze({
  board: 'BOARD_LAYOUT',
  table: 'TABLE_LAYOUT',
  roadmap: 'ROADMAP_LAYOUT',
} as const);
type ViewLayoutConfigKey = keyof typeof VIEW_LAYOUT_CONFIG;
type ViewLayoutEnum = typeof VIEW_LAYOUT_CONFIG[ViewLayoutConfigKey];

/** The `board` config spelling; the reader derives its default through the map, never as a second literal. */
const DEFAULT_VIEW_LAYOUT_CONFIG: ViewLayoutConfigKey = 'board';

/**
 * Returns the GraphQL `ProjectV2ViewLayout` enum member for
 * `github_sync.view.layout`, validated against `VIEW_LAYOUT_CONFIG`'s closed
 * set. Every rejection path — absent key, absent `github_sync`/`view` block,
 * absent/unreadable/unparseable config, wrong type, wrong case, or a spelling
 * outside the closed set — falls back to the `board` default and never
 * raises: `github-sync` never gates the GSD loop (P1 D-11), so a typo in
 * one config key must not stop an `init` run that would otherwise converge
 * the whole board. The configured value is never trimmed, lowercased, or
 * otherwise coerced before lookup — a trailing space or a capitalized
 * spelling is a typo, and coercing it would teach a spelling the manifest
 * does not declare.
 */
function readViewLayout(cwd: string): ViewLayoutEnum {
  const fallback = VIEW_LAYOUT_CONFIG[DEFAULT_VIEW_LAYOUT_CONFIG];

  const config = readConfigRecord(cwd);
  if (config === null) return fallback;
  const githubSync = config.github_sync;
  if (!isRecord(githubSync)) return fallback;
  const view = githubSync.view;
  if (!isRecord(view)) return fallback;
  const layout = view.layout;
  if (typeof layout !== 'string') return fallback;
  if (!Object.hasOwn(VIEW_LAYOUT_CONFIG, layout)) return fallback;
  return VIEW_LAYOUT_CONFIG[layout as ViewLayoutConfigKey];
}

/**
 * Pins the `gh repo view --json owner,name,databaseId` response shape
 * explicitly: the owner is an OBJECT carrying a login string (not a bare
 * string), the name is a non-empty string, and the database id is a
 * positive safe integer. Anything else — including a non-zero exit, a
 * timeout, or unparseable JSON — is unresolvable; never throws.
 */
function decodeGhRepoView(result: GhResult): { owner: string; name: string; databaseId: number } | null {
  if (result.exitCode !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const owner = parsed.owner;
  const name = parsed.name;
  const databaseId = parsed.databaseId;
  if (!isRecord(owner) || !isNonEmptyString(owner.login)) return null;
  if (!isNonEmptyString(name)) return null;
  if (!isPositiveSafeInteger(databaseId)) return null;
  return { owner: owner.login, name, databaseId };
}

/**
 * Resolves the full repository+project identity, in the corrected order
 * (D-01/D-02, cycle-4 HIGH-D):
 *
 *  1. `readSyncTarget` — if available, return it unchanged and spawn
 *     nothing. An explicitly configured value always wins.
 *  2. `readPartialSyncTarget` — every recovered value is kept verbatim.
 *  3. `gh repo view` — invoked at most once, only to fill whatever of
 *     owner/repo/repositoryNumber step 2 left absent. Its owner/name are
 *     passed through `assertPathSafeTarget` before being returned.
 *  4. The sync map — now that a complete repository identity exists, read
 *     it strictly with that identity. If the project number is still null
 *     and the map holds a valid `project` completion with a positive
 *     remote-number slot, adopt that number. `readSyncMapStrict` already
 *     rejects a map bound to a different repository (`repository_mismatch`),
 *     so a completion recovered here is guaranteed bound to the identity
 *     just resolved — a project completion for a foreign repository is
 *     ignored by construction, not by a second check here.
 *
 * Steps 3 and 4 are swapped relative to earlier drafts of this capability,
 * and the swap is the whole point: `readSyncMapStrict` requires a complete
 * repository identity. In the exact crash this recovery exists for — the
 * config write after a create failed, so the target block may be absent
 * entirely — putting the map read before the identity was resolved left it
 * with nothing to read, filled owner/repo/number from `gh repo view` but
 * left the project number null, and `planProject` created a SECOND board
 * (a BOOT-07 violation). Do not restore that ordering.
 *
 * The strict-map read this call performs is returned alongside the target
 * so the caller (the `init` handler) consumes one map read bound to the
 * resolved identity, never a second one with the same identity.
 *
 * Plan 07-10 Task 3 (D-01 option-d): `options.configuredProjectNumberConfirmedAbsent`
 * adds one more tier, consulted ONLY on the CONFIGURED path and ONLY when the
 * caller passes it as `true`. `resolveTarget` never performs a remote read of
 * its own to decide this — it is the identity-resolution seam, not a reader —
 * so the caller must have already established (via `existence.absenceGateSatisfied`
 * against a PRIOR run's persisted absence marker, or an equivalent durable
 * confirmation) that the configured `project_number` is gone. When that is
 * true AND the strict map already holds a `project` completion with a
 * DIFFERENT, valid remote number, that number wins — `.planning/config.json`
 * is never written, and the divergence rides back on `configuredProjectNumber`
 * for the caller to surface. Every other case (flag absent/false, no
 * qualifying map entry, or the map's number matching the configured one)
 * returns the CONFIGURED target completely unchanged from before this option
 * existed.
 */
function resolveTarget(cwd: string, options: { execGh?: ExecGh; configuredProjectNumberConfirmedAbsent?: boolean } = {}): ResolvedTargetResult {
  const full = targetMod.readSyncTarget(cwd);
  if (full.available && full.target) {
    const strictMapRead = mapMod.readSyncMapStrict(cwd, {
      owner: full.target.owner,
      repo: full.target.repo,
      number: full.target.repositoryNumber,
    });
    if (options.configuredProjectNumberConfirmedAbsent === true && strictMapRead.kind === 'valid') {
      const projectCompletion = strictMapRead.map.completions.project;
      const recoveredNumber = projectCompletion?.issueNumber;
      if (isPositiveSafeInteger(recoveredNumber) && recoveredNumber !== full.target.projectNumber) {
        return {
          target: { ...full.target, projectNumber: recoveredNumber },
          reason: RESOLVE_TARGET_REASON.CONFIGURED,
          strictMapRead,
          configuredProjectNumber: full.target.projectNumber,
        };
      }
    }
    return { target: full.target, reason: RESOLVE_TARGET_REASON.CONFIGURED, strictMapRead };
  }

  const partial = readPartialSyncTarget(cwd);
  if (partial.shape === TARGET_SHAPE.UNRECOGNIZED) {
    return { target: null, reason: RESOLVE_TARGET_REASON.UNRESOLVABLE, strictMapRead: null };
  }

  let owner = partial.owner;
  let repo = partial.repo;
  let repositoryNumber = partial.repositoryNumber;
  const projectNumberFromConfig = partial.projectNumber;

  if (owner === null || repo === null || repositoryNumber === null) {
    const execGh = options.execGh ?? ghMod.execGh;
    const result = execGh(['repo', 'view', '--json', 'owner,name,databaseId'], { cwd });
    const decoded = decodeGhRepoView(result);
    if (!decoded) return { target: null, reason: RESOLVE_TARGET_REASON.UNRESOLVABLE, strictMapRead: null };
    if (!bootstrapRemoteMod.assertPathSafeTarget(decoded.owner, decoded.name)) {
      return { target: null, reason: RESOLVE_TARGET_REASON.UNRESOLVABLE, strictMapRead: null };
    }
    owner = owner ?? decoded.owner;
    repo = repo ?? decoded.name;
    repositoryNumber = repositoryNumber ?? decoded.databaseId;
  }

  if (owner === null || repo === null || repositoryNumber === null) {
    return { target: null, reason: RESOLVE_TARGET_REASON.UNRESOLVABLE, strictMapRead: null };
  }

  const strictMapRead = mapMod.readSyncMapStrict(cwd, { owner, repo, number: repositoryNumber });
  let projectNumber = projectNumberFromConfig;
  if (projectNumber === null && strictMapRead.kind === 'valid') {
    const projectCompletion = strictMapRead.map.completions.project;
    if (projectCompletion && isPositiveSafeInteger(projectCompletion.issueNumber)) {
      projectNumber = projectCompletion.issueNumber;
    }
  }

  return {
    target: { owner, repo, repositoryNumber, projectNumber },
    reason: RESOLVE_TARGET_REASON.RESOLVED,
    strictMapRead,
  };
}

/**
 * DEFECT.WINDOWS-FS-OPS: on Windows a concurrent reader or antivirus scanner
 * can transiently hold the rename target open, throwing EPERM/EBUSY/EACCES.
 * Bounded exponential-ish retry on those three errnos only (mirrors
 * `src/broken-windows.cts`'s `renameWithRetry`); any other error, or the
 * final attempt, rethrows immediately.
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
    throw new Error(`Directory fsync for ${path.dirname(filePath)} failed; config durability is uncertain: ${(err as Error).message}`);
  } finally {
    if (dirFd !== null) {
      try { fs.closeSync(dirFd); } catch { /* best effort after directory fsync */ }
    }
  }
}

/**
 * Persists a resolved `project_number` into `.planning/config.json` at the
 * nested path `github_sync.target.project_number` — never a dotted key
 * (D-02). Mutates only that one scalar: every unrelated top-level key, and
 * a sibling `github_sync.project_title`, are preserved byte-identically.
 *
 * The present-block gate accepts two key sets: the closed four snake_case
 * keys, and the three-key set that omits only `project_number` — the exact
 * partial shape `readPartialSyncTarget` exists to serve, and the shape most
 * often handed to this function (a developer configured owner/repo/kind,
 * and `init` just resolved the number that completes them). Any other key
 * set refuses with the unrecognized-shape reason and writes nothing.
 *
 * All four written values (`owner`, `repo`, `repository_number`,
 * `project_number`) come from the caller's resolved `target` argument, in
 * both the create-fresh and the existing-target branch (CR-02 fix,
 * D-01/D-02) — the present-block gate (`classifyTargetKeys`) decides
 * whether to refuse the existing block, it is never a source of the values
 * written. Do not re-source `owner`/`repo`/`repository_number` from the
 * on-disk `existingTarget` here.
 *
 * Atomic: a temp file in the same directory is renamed over the original,
 * and the containing directory is fsynced — the same durability shape
 * `github-sync-map.cts`'s `writeSyncMapAtomically` uses (duplicated rather
 * than imported: that helper is not exported).
 */
function writeProjectNumber(cwd: string, target: { owner: string; repo: string; repositoryNumber: number }, projectNumber: number): ConfigWriteResult {
  if (!isPositiveSafeInteger(projectNumber)) return { ok: false, reason: CONFIG_WRITE_REASON.INVALID_NUMBER };

  const configPath = path.join(cwd, '.planning', 'config.json');
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    return { ok: false, reason: CONFIG_WRITE_REASON.UNREADABLE };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: CONFIG_WRITE_REASON.UNREADABLE };
  }
  if (!isRecord(parsed)) return { ok: false, reason: CONFIG_WRITE_REASON.UNREADABLE };

  const githubSync = isRecord(parsed.github_sync) ? parsed.github_sync : null;
  const existingTarget = githubSync !== null && isRecord(githubSync.target) ? githubSync.target : null;

  if (existingTarget !== null) {
    const kind = classifyTargetKeys(existingTarget);
    if (kind === 'unrecognized') return { ok: false, reason: CONFIG_WRITE_REASON.UNRECOGNIZED_SHAPE };
  }

  const newTarget: Record<string, unknown> = {
    owner: target.owner,
    repo: target.repo,
    repository_number: target.repositoryNumber,
    project_number: projectNumber,
  };

  const newGithubSync = { ...(githubSync ?? {}), target: newTarget };
  const newParsed = { ...parsed, github_sync: newGithubSync };
  const serialized = JSON.stringify(newParsed, null, 2) + '\n';

  const tmpPath = `${configPath}.tmp.${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmpPath, 'wx');
  let writeError: Error | null = null;
  try {
    fs.writeFileSync(fd, serialized);
    fs.fsyncSync(fd);
  } catch (err) {
    writeError = err instanceof Error ? err : new Error(String(err));
  } finally {
    let closeError: Error | null = null;
    try { fs.closeSync(fd); } catch (err) { closeError = err instanceof Error ? err : new Error(String(err)); }
    if (writeError !== null || closeError !== null) {
      try { fs.unlinkSync(tmpPath); } catch { /* best effort temp cleanup */ }
      throw writeError ?? closeError ?? new Error('Unknown failure writing the config temp file.');
    }
  }
  try {
    renameWithRetry(tmpPath, configPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* best effort temp cleanup */ }
    throw err;
  }
  fsyncContainingDir(configPath);

  return { ok: true, reason: CONFIG_WRITE_REASON.WRITTEN };
}

export = {
  readPartialSyncTarget,
  readProjectTitle,
  readViewLayout,
  resolveTarget,
  writeProjectNumber,
  CONFIG_WRITE_REASON,
  RESOLVE_TARGET_REASON,
  VIEW_LAYOUT_CONFIG,
  DEFAULT_VIEW_LAYOUT_CONFIG,
};
