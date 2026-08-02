'use strict';
/**
 * Authoritative local desired-state projection for github-sync. Planning files
 * are read here, once, and callers receive a JSON-safe result rather than raw
 * Markdown/YAML parser output or filesystem errors.
 */

import fs from 'node:fs';
import path from 'node:path';

const DESIRED_REASON = Object.freeze({
  OK: 'ok',
  LOCAL_UNAVAILABLE: 'local_unavailable',
} as const);

type DesiredReason = typeof DESIRED_REASON[keyof typeof DESIRED_REASON];

interface DesiredPhase {
  id: string;
  title: string;
  goal: string;
}

interface DesiredPlan {
  id: string;
  phaseId: string;
  wave: number | null;
  autonomous: boolean;
  requirements: string[];
  complete: boolean;
}

/**
 * A single desired GitHub Milestone: the current one (`archived: false`) or
 * one per archived milestone (`archived: true`). D-26: identity is `version`
 * alone. `title` is `version`, a space, an em-dash, a space, and `name`.
 * `description` is set once (D-27) — the current milestone's from
 * ROADMAP.md's own H1, an archived one's from that archive's own H1 (the
 * roadmap heading as it stood when the milestone shipped).
 */
interface DesiredMilestone {
  version: string;
  name: string;
  title: string;
  description: string;
  archived: boolean;
}

interface DesiredState {
  available: boolean;
  reason: DesiredReason;
  phases: DesiredPhase[];
  plans: DesiredPlan[];
  currentPhase: string | null;
  milestones: DesiredMilestone[];
  /** Titles of desired-milestone entries discarded by dedupeMilestonesByVersion (D-26 identity, cycle-2 non-HIGH #5). */
  duplicateMilestones: string[];
}

function unavailable(): DesiredState {
  return {
    available: false,
    reason: DESIRED_REASON.LOCAL_UNAVAILABLE,
    phases: [],
    plans: [],
    currentPhase: null,
    milestones: [],
    duplicateMilestones: [],
  };
}

function normalizeId(value: string): string {
  return value.padStart(2, '0');
}

function parseRoadmap(raw: string): DesiredPhase[] | null {
  const matches = [...raw.matchAll(/^### Phase (\d+(?:\.\d+)?):\s*(.+)$/gm)];
  if (matches.length === 0) return null;
  const phases: DesiredPhase[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const nextOffset = matches[index + 1]?.index ?? raw.length;
    const section = raw.slice(match.index! + match[0].length, nextOffset);
    const goal = /^\*\*Goal\*\*:\s*(.+)$/m.exec(section)?.[1]?.trim() ?? '';
    phases.push({ id: normalizeId(match[1]), title: match[2].trim(), goal });
  }
  return phases.sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
}

function parseCurrentPhase(raw: string): string | null {
  const match = /^current_phase:\s*['\"]?(\d+(?:\.\d+)?)['\"]?\s*$/m.exec(raw);
  return match ? normalizeId(match[1]) : null;
}

function parsePlanMetadata(raw: string): Pick<DesiredPlan, 'wave' | 'autonomous' | 'requirements'> | null {
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(raw)?.[1];
  if (!frontmatter) return null;
  const waveMatch = /^wave:\s*(\d+)\s*$/m.exec(frontmatter);
  const autonomousMatch = /^autonomous:\s*(true|false)\s*$/m.exec(frontmatter);
  const requirementsMatch = /^requirements:\s*\[([^\]]*)\]\s*$/m.exec(frontmatter);
  return {
    wave: waveMatch ? Number(waveMatch[1]) : null,
    autonomous: autonomousMatch?.[1] === 'true',
    requirements: requirementsMatch?.[1].split(',').map((item) => item.trim()).filter(Boolean) ?? [],
  };
}

function readPlans(planningDir: string): DesiredPlan[] | null {
  const phaseRoot = path.join(planningDir, 'phases');
  let phaseDirs: string[];
  try { phaseDirs = fs.readdirSync(phaseRoot); } catch { return []; }
  const plans: DesiredPlan[] = [];
  for (const phaseDir of phaseDirs.sort()) {
    const directory = path.join(phaseRoot, phaseDir);
    let entries: string[];
    try { entries = fs.readdirSync(directory); } catch { return null; }
    for (const entry of entries.sort()) {
      const match = /^(\d+(?:\.\d+)?)-(\d+)-PLAN\.md$/.exec(entry);
      if (!match) continue;
      let metadata: Pick<DesiredPlan, 'wave' | 'autonomous' | 'requirements'> | null;
      try { metadata = parsePlanMetadata(fs.readFileSync(path.join(directory, entry), 'utf8')); } catch { return null; }
      if (!metadata) return null;
      const id = `${normalizeId(match[1])}-${match[2]}`;
      plans.push({ ...metadata, id, phaseId: normalizeId(match[1]), complete: fs.existsSync(path.join(directory, `${match[1]}-${match[2]}-SUMMARY.md`)) });
    }
  }
  return plans.sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
}

const EM_DASH = '—';

/** D-26's fixed title format: version, a space, an em-dash, a space, name. */
function milestoneTitle(version: string, name: string): string {
  return `${version} ${EM_DASH} ${name}`;
}

/** The first `# ...` heading, hash-and-space stripped and trimmed — D-27's description source. */
function parseFirstHeading(raw: string): string | null {
  const match = /^#\s+(.+)$/m.exec(raw);
  return match ? match[1].trim() : null;
}

function parseCurrentMilestoneVersion(raw: string): string | null {
  const match = /^milestone:\s*['"]?([^'"\n]+?)['"]?\s*$/m.exec(raw);
  return match ? match[1].trim() : null;
}

function parseCurrentMilestoneName(raw: string): string | null {
  const match = /^milestone_name:\s*['"]?([^'"\n]+?)['"]?\s*$/m.exec(raw);
  return match ? match[1].trim() : null;
}

/**
 * The same numeric-aware comparison `parseRoadmap` already uses for phase ids
 * (line 60's `localeCompare(..., { numeric: true })`), named explicitly here
 * (cycle-1 non-HIGH #8) so a double-digit or multi-segment version sorts
 * correctly rather than relying on default string comparison.
 */
function compareVersions(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

/**
 * Reads `MILESTONES.md`'s `## <version> <name> (Shipped: <date>)` entries
 * (`src/milestone.cts:696` — the only place an archived milestone's name is
 * recorded) into a version -> name lookup. Absent or unreadable collapses to
 * an empty map, never a failure — losing the name is a cosmetic degradation,
 * never a BOOT-05 failure (the archive's version, from its filename, still
 * carries the entry).
 */
function parseMilestonesMdNames(raw: string | null): Map<string, string> {
  const names = new Map<string, string>();
  if (!raw) return names;
  const entryPattern = /^##\s+(\S+)\s+(.+?)\s+\(Shipped:[^)]*\)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(raw)) !== null) {
    names.set(match[1], match[2].trim());
  }
  return names;
}

function readTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * `<version>-ROADMAP.md` — the exact filename `src/milestone.cts:674` writes
 * (a verbatim copy of ROADMAP.md, no header prepended: the version lives in
 * the filename and nowhere in the content). A sibling artifact in the same
 * directory (`<version>-REQUIREMENTS.md`, `<version>-MILESTONE-AUDIT.md`)
 * never matches this suffix and is silently ignored — identity is the
 * roadmap-archive filename alone.
 */
const ARCHIVE_ROADMAP_FILENAME = /^(.+)-ROADMAP\.md$/;

/**
 * Archived milestones — sourced from where `src/milestone.cts` actually
 * writes them (cycle-4 HIGH-5), not from a header nothing writes. A missing
 * archives directory yields an empty list, not a failure; a filename that
 * does not match `ARCHIVE_ROADMAP_FILENAME` is skipped without producing an
 * entry with an empty version.
 */
function readArchivedMilestones(planningDir: string): DesiredMilestone[] {
  const archiveDir = path.join(planningDir, 'milestones');
  let entries: string[];
  try {
    entries = fs.readdirSync(archiveDir);
  } catch {
    return [];
  }

  const namesByVersion = parseMilestonesMdNames(readTextFile(path.join(planningDir, 'MILESTONES.md')));
  const milestones: DesiredMilestone[] = [];
  for (const entry of entries.sort()) {
    const match = ARCHIVE_ROADMAP_FILENAME.exec(entry);
    if (!match || match[1].length === 0) continue;
    const version = match[1];
    const raw = readTextFile(path.join(archiveDir, entry));
    if (raw === null) continue;
    const name = namesByVersion.get(version) ?? version;
    const title = milestoneTitle(version, name);
    // The archive's own first H1 is the roadmap heading as it stood when the
    // milestone shipped — D-27's description source for an archived entry. A
    // malformed or absent H1 is not a skip: the entry still appears, its
    // description falling back to the title (the H1 is never the identity).
    milestones.push({ version, name, title, description: parseFirstHeading(raw) ?? title, archived: true });
  }
  return milestones;
}

/**
 * Keeps the first occurrence of each version in `milestones` — input order
 * decides "first" — reporting every later occurrence's title on the
 * duplicate list rather than dropping it silently (D-26 identity, cycle-2
 * non-HIGH #5). Callers control priority entirely through input order: this
 * function carries no opinion about archives vs. the current milestone.
 * Exported (unlike its sibling helpers) because two real archive files
 * sharing one version token cannot arise on a single filesystem — their
 * filenames ARE their version identity — so this is the only surface that
 * can exercise the archive-vs-archive collision case directly.
 */
function dedupeMilestonesByVersion(milestones: DesiredMilestone[]): { milestones: DesiredMilestone[]; duplicates: string[] } {
  const seen = new Map<string, DesiredMilestone>();
  const duplicates: string[] = [];
  for (const milestone of milestones) {
    if (seen.has(milestone.version)) {
      duplicates.push(milestone.title);
      continue;
    }
    seen.set(milestone.version, milestone);
  }
  return { milestones: [...seen.values()], duplicates };
}

/**
 * D-28: the sole planning-file reader for milestone data — no bootstrap
 * module parses ROADMAP.md or STATE.md itself. Reuses the ROADMAP/STATE
 * strings `readDesiredState` already read; never reads either file a second
 * time. Returns null (never a partial result) when the current milestone's
 * version or name cannot be recovered, matching how a missing current phase
 * is already handled.
 */
function parseMilestones(roadmapRaw: string, stateRaw: string, planningDir: string): { milestones: DesiredMilestone[]; duplicates: string[] } | null {
  const currentVersion = parseCurrentMilestoneVersion(stateRaw);
  const currentName = parseCurrentMilestoneName(stateRaw);
  if (!currentVersion || !currentName) return null;

  const current: DesiredMilestone = {
    version: currentVersion,
    name: currentName,
    title: milestoneTitle(currentVersion, currentName),
    description: parseFirstHeading(roadmapRaw) ?? '',
    archived: false,
  };

  const sortedArchives = readArchivedMilestones(planningDir).sort((left, right) => compareVersions(left.version, right.version));
  const { milestones: dedupedArchives, duplicates: archiveDuplicates } = dedupeMilestonesByVersion(sortedArchives);

  // D-26: the current milestone always wins over an archive sharing its
  // version — it is the live one Phase 4 assigns issues to. Handled as its
  // own pass, after the archive-vs-archive dedup and before the current
  // milestone is appended, so the current milestone is always last (cycle-1
  // non-HIGH #8's ordering guarantee holds even on a version collision).
  const duplicates = [...archiveDuplicates];
  const collisionIndex = dedupedArchives.findIndex((milestone) => milestone.version === current.version);
  const finalArchives = collisionIndex === -1
    ? dedupedArchives
    : dedupedArchives.filter((_milestone, index) => index !== collisionIndex);
  if (collisionIndex !== -1) duplicates.push(dedupedArchives[collisionIndex].title);

  return { milestones: [...finalArchives, current], duplicates };
}

function readDesiredState(cwd: string): DesiredState {
  try {
    const planningDir = path.join(cwd, '.planning');
    const roadmapRaw = fs.readFileSync(path.join(planningDir, 'ROADMAP.md'), 'utf8');
    const stateRaw = fs.readFileSync(path.join(planningDir, 'STATE.md'), 'utf8');
    const phases = parseRoadmap(roadmapRaw);
    const currentPhase = parseCurrentPhase(stateRaw);
    const plans = readPlans(planningDir);
    const milestonesResult = parseMilestones(roadmapRaw, stateRaw, planningDir);
    if (!phases || !currentPhase || !plans || !milestonesResult) return unavailable();
    return {
      available: true,
      reason: DESIRED_REASON.OK,
      phases,
      plans,
      currentPhase,
      milestones: milestonesResult.milestones,
      duplicateMilestones: milestonesResult.duplicates,
    };
  } catch {
    return unavailable();
  }
}

export = { readDesiredState, DESIRED_REASON, dedupeMilestonesByVersion };
