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

/**
 * The three status-option names this projection can derive from disk truth,
 * spelled exactly as `GSD_STATUS_OPTIONS` declares them
 * (`src/github-sync-bootstrap-plan.cts`) — the reconciler resolves this
 * value against that catalog's option ids, so a spelling drift here would
 * make every phase item land in a No-Status column. `Blocked` and
 * `Deferred` are deliberately absent: neither is derivable from disk truth
 * today, and emitting a guess would silently overwrite a value a developer
 * set by hand on the board (D-16).
 */
const PHASE_STATUS = Object.freeze({
  TODO: 'Todo',
  IN_PROGRESS: 'In Progress',
  DONE: 'Done',
} as const);

type PhaseStatus = typeof PHASE_STATUS[keyof typeof PHASE_STATUS];

interface DesiredPhase {
  id: string;
  title: string;
  goal: string;
  /** Ordered, trimmed, numbering-stripped success-criteria items. Empty when the phase declares none — a real state, never an unavailable read. */
  successCriteria: string[];
  /** Ordered, trimmed requirement IDs. Empty when the phase declares none — a real state, never an unavailable read. */
  requirements: string[];
  /** Total by construction: every phase carries one of the three `PHASE_STATUS` members. */
  status: PhaseStatus;
}

interface DesiredPlan {
  id: string;
  phaseId: string;
  wave: number | null;
  autonomous: boolean;
  requirements: string[];
  complete: boolean;
  /** D-04: the sub-issue title, via `planTitleFor`'s three-tier fallback chain — total by construction, never empty. */
  title: string;
  /** D-01: the PLAN.md body's `<task>`/`<name>` blocks, in document order, no deduplication. */
  tasks: string[];
  /** Plan 05-01's tracer scope: the two-state form `plan.complete ? DONE : TODO`. Plan 05-02 replaces this with D-09's three-state `derivePlanStatus`. */
  status: PhaseStatus;
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

/**
 * Line-anchored bold `Requirements` label on the per-phase section slice.
 * Handles both spellings seen across GSD roadmaps — a bare comma-separated
 * list and one wrapped in a single pair of square brackets — trimming each
 * ID and dropping empties. Absent label yields an empty array: a phase with
 * no declared requirements is a real state, never an unavailable read.
 */
function extractRequirements(section: string): string[] {
  const match = /^\*\*Requirements\*\*:\s*(.+)$/m.exec(section);
  if (!match) return [];
  let value = match[1].trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

/**
 * Bold `Success Criteria` label on the per-phase section slice. Reads
 * forward to the first following line that is a new bold label (a line
 * whose first non-whitespace run opens a bold span and ends with a colon)
 * or to the end of the slice, whichever comes first — that window is the
 * hard outer boundary. Within it, an item begins at an optional-indent
 * decimal-numbered line; every following non-blank line that does not start
 * a new numbered item is a continuation, joined after a single space. A
 * blank line ends the current item; the first non-numbered block reached
 * after at least one item has been collected (an italic amendment note, a
 * `**Confidence handling**:` paragraph inside the window, etc.) ends
 * collection entirely rather than being swept in as a continuation. Absent
 * label yields an empty array: a phase with no declared criteria is a real
 * state, never an unavailable read.
 */
function extractSuccessCriteria(section: string): string[] {
  const labelMatch = /^\*\*Success Criteria\*\*.*$/m.exec(section);
  if (!labelMatch) return [];
  const afterLabel = section.slice(labelMatch.index + labelMatch[0].length);
  const stopMatch = /^\*\*[^*\n]+\*\*:.*$/m.exec(afterLabel);
  const windowText = stopMatch ? afterLabel.slice(0, stopMatch.index) : afterLabel;

  const items: string[] = [];
  let current: string[] | null = null;
  for (const line of windowText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      if (current) {
        items.push(current.join(' ').trim());
        current = null;
      }
      continue;
    }
    const numberedMatch = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (numberedMatch) {
      if (current) items.push(current.join(' ').trim());
      current = [numberedMatch[1]];
    } else if (current) {
      current.push(trimmed);
    } else if (items.length > 0) {
      // Past the list (its last item was already flushed at a blank line)
      // and this block does not open a new numbered item — an amendment
      // note or similar prose inside the window. Stop collecting for good.
      break;
    }
  }
  if (current) items.push(current.join(' ').trim());
  return items;
}

/**
 * D-16: milestone-phase-checklist line shape — a hyphen, a bracketed space
 * or `x`, a bold span opening with the word `Phase`, the id, and a colon.
 * This is a distinct construct from the `### Phase N:` heading `parseRoadmap`
 * walks (a different section of ROADMAP.md, and the two can legitimately
 * disagree in count), so it gets its own regex rather than widening that
 * one. Ids are normalized through `normalizeId` so a checklist id and a
 * detail-heading id are comparable.
 */
function parsePhaseChecklist(roadmapRaw: string): Map<string, boolean> {
  const checklist = new Map<string, boolean>();
  const pattern = /^-\s*\[([ xX])\]\s*\*\*Phase\s+(\d+(?:\.\d+)?):/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(roadmapRaw)) !== null) {
    checklist.set(normalizeId(match[2]), match[1].toLowerCase() === 'x');
  }
  return checklist;
}

/**
 * D-16's status derivation, total by construction: a checked checklist
 * entry is Done; an unchecked entry whose normalized id equals the current
 * phase id is In Progress; any other unchecked entry is Todo; a phase with
 * no checklist entry at all falls back to the same current-phase test. No
 * branch can produce a null, which is what keeps "no card without a value"
 * true.
 */
function derivePhaseStatus(id: string, checklist: Map<string, boolean>, currentPhaseId: string | null): PhaseStatus {
  const checked = checklist.get(id);
  if (checked === true) return PHASE_STATUS.DONE;
  return id === currentPhaseId ? PHASE_STATUS.IN_PROGRESS : PHASE_STATUS.TODO;
}

function parseRoadmap(raw: string, checklist: Map<string, boolean>, currentPhaseId: string | null): DesiredPhase[] | null {
  const matches = [...raw.matchAll(/^### Phase (\d+(?:\.\d+)?):\s*(.+)$/gm)];
  if (matches.length === 0) return null;
  const phases: DesiredPhase[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const nextOffset = matches[index + 1]?.index ?? raw.length;
    const section = raw.slice(match.index + match[0].length, nextOffset);
    const goal = /^\*\*Goal\*\*:\s*(.+)$/m.exec(section)?.[1]?.trim() ?? '';
    const id = normalizeId(match[1]);
    phases.push({
      id,
      title: match[2].trim(),
      goal,
      successCriteria: extractSuccessCriteria(section),
      requirements: extractRequirements(section),
      status: derivePhaseStatus(id, checklist, currentPhaseId),
    });
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

/**
 * D-04: `.planning/ROADMAP.md`'s per-phase plan-list rows —
 * `- [x] 04-03-PLAN.md — <description>` (a hyphen-en-dash-space, then free
 * text) or a bare `- [x] 04-03-PLAN.md` with no description at all. A row
 * carrying no description contributes no map entry — `planTitleFor`'s second
 * fallback tier handles that case, not this parser.
 */
function parseRoadmapPlanDescriptions(roadmapRaw: string): Map<string, string> {
  const descriptions = new Map<string, string>();
  const pattern = /^-\s*\[[ xX]\]\s*(\d+(?:\.\d+)?)-(\d+)-PLAN\.md(?:\s*—\s*(.+))?\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(roadmapRaw)) !== null) {
    const description = match[3]?.trim();
    if (!description) continue;
    descriptions.set(`${normalizeId(match[1])}-${match[2]}`, description);
  }
  return descriptions;
}

/**
 * D-04's mandatory fallback chain, total by construction and never empty:
 * description present -> `<id> — <description>`; description absent but the
 * phase is present in ROADMAP.md -> `<id> — <phaseTitle>`; phase absent ->
 * `<id>` alone.
 */
function planTitleFor(id: string, description: string | undefined, phaseTitle: string | undefined): string {
  if (description) return `${id} ${EM_DASH} ${description}`;
  if (phaseTitle) return `${id} ${EM_DASH} ${phaseTitle}`;
  return id;
}

/**
 * D-01: PLAN.md's `<task>` blocks read from the file's **body** (never the
 * frontmatter — `parsePlanMetadata`'s job stops at the closing `---`), in
 * document order, each contributing its `<name>` element text, trimmed. No
 * deduplication: two blocks whose `<name>` text is byte-identical both
 * contribute their own entry.
 */
function parsePlanTaskNames(raw: string): string[] {
  const afterFrontmatter = /^---\n[\s\S]*?\n---(?:\n|$)([\s\S]*)$/.exec(raw);
  const body = afterFrontmatter ? afterFrontmatter[1] : raw;
  const names: string[] = [];
  const taskPattern = /<task\b[^>]*>([\s\S]*?)<\/task>/g;
  let taskMatch: RegExpExecArray | null;
  while ((taskMatch = taskPattern.exec(body)) !== null) {
    const nameMatch = /<name>([\s\S]*?)<\/name>/.exec(taskMatch[1]);
    if (nameMatch) names.push(nameMatch[1].trim());
  }
  return names;
}

function readPlans(planningDir: string, roadmapRaw: string, phases: DesiredPhase[] | null): DesiredPlan[] | null {
  const phaseRoot = path.join(planningDir, 'phases');
  let phaseDirs: string[];
  try { phaseDirs = fs.readdirSync(phaseRoot); } catch { return []; }
  const planDescriptions = parseRoadmapPlanDescriptions(roadmapRaw);
  const phaseTitles = new Map<string, string>((phases ?? []).map((phase) => [phase.id, phase.title]));
  const plans: DesiredPlan[] = [];
  for (const phaseDir of phaseDirs.sort()) {
    const directory = path.join(phaseRoot, phaseDir);
    let entries: string[];
    try { entries = fs.readdirSync(directory); } catch { return null; }
    for (const entry of entries.sort()) {
      const match = /^(\d+(?:\.\d+)?)-(\d+)-PLAN\.md$/.exec(entry);
      if (!match) continue;
      let raw: string;
      try { raw = fs.readFileSync(path.join(directory, entry), 'utf8'); } catch { return null; }
      const metadata = parsePlanMetadata(raw);
      if (!metadata) return null;
      const id = `${normalizeId(match[1])}-${match[2]}`;
      const phaseId = normalizeId(match[1]);
      const complete = fs.existsSync(path.join(directory, `${match[1]}-${match[2]}-SUMMARY.md`));
      plans.push({
        ...metadata,
        id,
        phaseId,
        complete,
        title: planTitleFor(id, planDescriptions.get(id), phaseTitles.get(phaseId)),
        tasks: parsePlanTaskNames(raw),
        status: complete ? PHASE_STATUS.DONE : PHASE_STATUS.TODO,
      });
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
    const currentPhase = parseCurrentPhase(stateRaw);
    const checklist = parsePhaseChecklist(roadmapRaw);
    const phases = parseRoadmap(roadmapRaw, checklist, currentPhase);
    const plans = readPlans(planningDir, roadmapRaw, phases);
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

export = {
  readDesiredState,
  DESIRED_REASON,
  dedupeMilestonesByVersion,
  PHASE_STATUS,
  parsePhaseChecklist,
  planTitleFor,
  parsePlanTaskNames,
  parseRoadmapPlanDescriptions,
};
