'use strict';
/**
 * github-sync-issue-body.cts — pure, zero-I/O marker/fence/region renderer
 * for a GSD-owned phase issue body (plan 04-01). Every later phase-issue
 * body write composes through this module rather than string-building its
 * own marker or fence inline.
 *
 * Zero filesystem and network imports: this module reads no file, no
 * environment variable, and makes no network or filesystem call. Every
 * input is a typed phase-shaped value already produced by
 * `github-sync-desired.cts`. Plan 04-03 Task 2 adds the module's only
 * import, Node's stdlib `crypto` module, for the non-cryptographic content
 * hash below — this is change detection, not authentication, so the
 * "zero I/O" framing is narrowed to what it always meant: no file, network,
 * or environment read.
 *
 * Two distinct token families, deliberately kept apart (D-01/D-02):
 *
 * - `phaseMarker(id)` is the issue's *identity* — an HTML comment naming the
 *   phase id. It never changes once an issue exists (D-01's one-way-door
 *   reversibility note): a later plan that re-derives identity from this
 *   marker depends on its exact string form never drifting.
 * - `FENCE_BEGIN` / `FENCE_END` bound the *region* GSD owns and rewrites on
 *   every sync. A developer who damages or removes the fence still leaves
 *   an issue whose identity marker is intact, because the two are distinct
 *   tokens rather than one combined delimiter.
 *
 * D-04's transparency rule governs every string this module renders: no
 * markdown checkbox, or any other control a reader could interact with,
 * ever appears inside a GSD-owned region — a one-way mirror must never
 * invite an edit it will silently discard on the next sync.
 */

import crypto from 'node:crypto';

interface RenderablePhase {
  id: string;
  title: string;
  goal: string;
  /** Plan 04-05: ordered, verbatim success-criteria text. Omitted or empty renders no criteria heading at all — an empty section is noise, not information. */
  successCriteria?: string[];
  /** Plan 04-05: ordered, verbatim requirement IDs. Omitted or empty renders no requirements heading at all, for the same reason. */
  requirements?: string[];
}

/** The exact planning-file path every rendered provenance line names (D-04's "this is a projection" framing). */
const ROADMAP_PATH = '.planning/ROADMAP.md';

/**
 * The identity marker (D-01): an HTML comment whose content is
 * `gsd:phase id="<id>"`. Takes an already-normalized id and does not
 * normalize it — normalization is `github-sync-desired.cts`'s job
 * (`normalizeId`), and duplicating it here would let the two disagree: a
 * phase spelled `4` on one call and `04` on another must already agree
 * before either reaches this renderer.
 */
export function phaseMarker(id: string): string {
  return `<!-- gsd:phase id="${id}" -->`;
}

/**
 * D-02: deliberately distinct tokens from `phaseMarker`'s output — a
 * developer who mangles or deletes the region between these two fences
 * still leaves an issue whose identity marker is untouched.
 */
export const FENCE_BEGIN = '<!-- gsd:begin -->';
export const FENCE_END = '<!-- gsd:end -->';

/**
 * The region interior for a phase (D-14, plan 04-05): the goal under a
 * heading, success criteria as a plain numbered list, requirement IDs as
 * plain comma-separated text, and last a provenance line naming the roadmap
 * source and the phase's own section — phrased so a reader arriving from a
 * notification understands the issue is a projection, not an authored
 * artifact, before they consider editing it. Composes only from the typed
 * `phase` fields this function is given; an unrelated property on `phase`
 * (a dependency list, a plan count) changes nothing in the output — plan
 * count is Phase 5's data and a dependency line was deliberately excluded
 * (D-14), not merely never added.
 *
 * Emits no markdown checkbox anywhere, under any condition. A criteria or
 * requirements list of length zero omits its heading entirely — an empty
 * section is noise, not information — rather than rendering an empty list
 * under a heading. Does not escape, transform, or interpret any developer
 * text: it renders exactly as written, and the only property that must hold
 * (pinned by a `spliceRegion` round-trip test, not by this function) is that
 * no developer string can forge a second fence pair.
 */
export function renderPhaseRegion(phase: RenderablePhase): string {
  const goalLine = phase.goal.length > 0 ? phase.goal : '_No goal recorded on the roadmap._';
  const lines: string[] = ['## Goal', '', goalLine];

  const successCriteria = phase.successCriteria ?? [];
  if (successCriteria.length > 0) {
    lines.push('', '## Success Criteria', '');
    successCriteria.forEach((criterion, index) => lines.push(`${index + 1}. ${criterion}`));
  }

  const requirements = phase.requirements ?? [];
  if (requirements.length > 0) {
    lines.push('', '## Requirements', '', requirements.join(', '));
  }

  lines.push(
    '',
    '---',
    `_This issue is generated from \`${ROADMAP_PATH}\`, Phase ${phase.id}'s section. It is a one-way projection, regenerated on every sync — edits made here are never synced back; update the roadmap instead._`,
  );

  return lines.join('\n');
}

/**
 * D-04: the marker, a newline, the begin fence, the region, the end fence,
 * and one trailing newline — and nothing else.
 */
export function renderNewIssueBody(phase: RenderablePhase): string {
  return `${phaseMarker(phase.id)}\n${FENCE_BEGIN}\n${renderPhaseRegion(phase)}\n${FENCE_END}\n`;
}

/**
 * Phase 5 (D-01): the plan sub-issue's identity marker — an HTML comment
 * naming the plan id. Mirrors `phaseMarker` exactly and normalizes nothing:
 * the same already-normalized-id contract applies (normalization is
 * `github-sync-desired.cts`'s job).
 */
export function planMarker(id: string): string {
  return `<!-- gsd:plan id="${id}" -->`;
}

/**
 * Phase 5 (D-05): this tracer's two-state form. Plan 05-02 replaces this with
 * D-09's three-state `derivePlanStatus`, which is a fill on this skeleton,
 * not a reshape of it.
 */
export type PlanStatus = 'Todo' | 'In Progress' | 'Done';

/**
 * D-05: the status glyph is a plan-level rollup — every task inherits its
 * plan's own derived Status, because GSD stores no per-task completion state
 * on disk. Frozen so no caller can add a fourth glyph without touching this
 * one declaration.
 */
export const TASK_GLYPH: Readonly<Record<PlanStatus, string>> = Object.freeze({
  Todo: '○',
  'In Progress': '▶',
  Done: '✓',
});

/**
 * D-06: one line per task — a glyph, a single space, then the `<name>` text
 * verbatim, nothing else (no file list, no behavior summary, no numbering).
 * Document order is preserved and two byte-identical `<name>` texts both
 * render as their own line — this function never deduplicates.
 */
export function renderTaskList(status: PlanStatus, taskNames: string[]): string {
  const glyph = TASK_GLYPH[status];
  return taskNames.map((name) => `${glyph} ${name}`).join('\n');
}

export interface RenderablePlan {
  id: string;
  title: string;
  status: PlanStatus;
  tasks: string[];
  /**
   * Plan 05-03 Task 2 (D-02/D-03): ordered plan ids this plan depends on.
   * Rendered as one dependency-reference slot per entry, resolved to a real
   * issue reference only at dispatch time (05-06). Optional and defaulting
   * to empty, mirroring `RenderablePhase.successCriteria`/`.requirements` —
   * an existing caller that does not yet supply it renders with no
   * `## Depends On` section at all, exactly as if it had passed `[]`.
   */
  dependsOn?: string[];
}

/**
 * D-03: a dependency reference is rendered now and resolved later. Delimited
 * by NUL code points (U+0000) on both sides — a byte sequence that cannot
 * survive in a well-formed GitHub issue body or in any PLAN.md-derived
 * developer text, so the sentinel's presence anywhere outside this module's
 * own output already signals a corrupt input, never a plausible authoring
 * choice. `countDependencyRefSlots`/`substituteDependencyRefs` below are the
 * anti-forgery pair: a slot-count disagreement is reported, never guessed
 * past (T-5-06).
 */
export const DEPENDENCY_REF_SENTINEL = ' gsd:dep-ref ';

/**
 * Counts non-overlapping occurrences of `DEPENDENCY_REF_SENTINEL` in `region`
 * via the same split-length-minus-one technique `spliceRegion` already uses
 * for its own fence tokens — literal scanning, no markdown parser.
 */
export function countDependencyRefSlots(region: string): number {
  return region.split(DEPENDENCY_REF_SENTINEL).length - 1;
}

/**
 * The two-member result of a dependency-slot substitution. The `mismatch`
 * member deliberately carries no `text` field at all — mirroring
 * `SpliceOutcome`'s damaged member — so no caller can read a partial
 * substitution out of a failed one.
 */
export type DependencyRefSubstitution =
  | { kind: 'substituted'; text: string }
  | { kind: 'mismatch'; detail: string };

/**
 * Strictly positional and total: replaces the Nth sentinel occurrence with
 * the Nth entry of `values`, and scans for nothing else. Refuses — returning
 * the typed `mismatch` member — when the slot count and the value count
 * differ, rather than binding a value to the wrong slot or leaving a slot
 * unfilled. This is the anti-forgery guarantee D-03/T-5-06 rests on: if a
 * developer string (a task name, a title) ever happened to contain the
 * sentinel, the observed slot count would no longer match the caller's
 * intended dependency count, and this function reports rather than silently
 * mis-binding a reference to the wrong issue.
 */
export function substituteDependencyRefs(region: string, values: string[]): DependencyRefSubstitution {
  const slotCount = countDependencyRefSlots(region);
  if (slotCount !== values.length) {
    return {
      kind: 'mismatch',
      detail: `expected ${slotCount} dependency reference slot(s), received ${values.length} value(s)`,
    };
  }
  if (slotCount === 0) return { kind: 'substituted', text: region };

  const parts = region.split(DEPENDENCY_REF_SENTINEL);
  let text = parts[0];
  for (let index = 0; index < values.length; index += 1) {
    text += values[index] + parts[index + 1];
  }
  return { kind: 'substituted', text };
}

/**
 * D-05's accepted limitation made visible to the reader (plan 05-03 Task 1):
 * one line directly beneath the `## Tasks` heading naming each of the three
 * glyphs and stating plainly that the glyph reflects the plan's own derived
 * status, not any per-task progress — GSD stores no per-task completion
 * state on disk, so the renderer never implies knowledge it does not have.
 */
const TASK_GLYPH_LEGEND =
  `Legend: ${TASK_GLYPH.Done} Done · ${TASK_GLYPH['In Progress']} In Progress · ${TASK_GLYPH.Todo} Todo` +
  ' — every task shows its plan’s own status; GSD records no per-task completion state.';

/**
 * Plan 05-03 Task 1: the single explanatory placeholder line a zero-task
 * plan renders under `## Tasks`, mirroring `renderPhaseRegion`'s own
 * `_No goal recorded on the roadmap._` precedent for the identical
 * situation — never an empty heading, never an empty list beneath one.
 */
const NO_TASKS_PLACEHOLDER = '_This plan records no tasks._';

/**
 * The literal path template every rendered plan provenance line names.
 * `RenderablePlan` carries only the plan's own id, not the phase-directory
 * slug (`05-plan-sub-issues-task-rendering`), so the directory segment
 * renders as a literal ellipsis rather than a guessed or silently omitted
 * directory name.
 */
const PLAN_PATH_PREFIX = '.planning/phases/.../';
const PLAN_PATH_SUFFIX = '-PLAN.md';

/**
 * D-07/D-12: the plan sub-issue's region — a `## Tasks` heading, the task
 * list (D-05/D-06), and a provenance line naming the plan's own PLAN.md path
 * and stating the issue is a one-way projection regenerated on every sync.
 * Per D-12's coupling constraint, the region **never** repeats `Wave`,
 * `Autonomous`, or `Requirements` as body text — those belong to the other
 * convergence unit (the item fields), and a field change must not rewrite a
 * body. Emits no markdown checkbox anywhere, under any condition (D-04's
 * transparency rule, carried over unchanged from the phase renderer).
 */
export function renderPlanRegion(plan: RenderablePlan): string {
  const taskLines = plan.tasks.length > 0 ? renderTaskList(plan.status, plan.tasks) : NO_TASKS_PLACEHOLDER;
  const lines: string[] = ['## Tasks', '', TASK_GLYPH_LEGEND, '', taskLines];

  const dependsOn = plan.dependsOn ?? [];
  if (dependsOn.length > 0) {
    const refsLine = dependsOn.map(() => DEPENDENCY_REF_SENTINEL).join(', ');
    lines.push('', '## Depends On', '', refsLine);
  }

  lines.push(
    '',
    '---',
    `_This issue is generated from \`${PLAN_PATH_PREFIX}${plan.id}${PLAN_PATH_SUFFIX}\`. It is a one-way projection, regenerated on every sync — edits made here are never synced back; update the plan file instead._`,
  );
  return lines.join('\n');
}

/**
 * D-07: the marker, a newline, the begin fence, the region, the end fence,
 * and one trailing newline — the same five-part shape `renderNewIssueBody`
 * produces for a phase.
 */
export function renderNewPlanIssueBody(plan: RenderablePlan): string {
  return `${planMarker(plan.id)}\n${FENCE_BEGIN}\n${renderPlanRegion(plan)}\n${FENCE_END}\n`;
}

/**
 * D-03's three-way severity catalog for splicing a fresh region into an
 * existing body. Mirrors the frozen-catalog style of
 * `github-sync-reconcile.cts`'s `OPERATION_REASON`.
 *
 * - `SPLICED` — exactly one fence pair, in correct order: interior replaced,
 *   everything outside the fences unchanged and in its original position.
 * - `SELF_HEAL` — no fence pair at all: the original body is preserved
 *   verbatim and a fresh fenced region is appended.
 * - `DAMAGED` — anything else (unbalanced, duplicated, or inverted fences):
 *   no replacement body is produced at all. GSD refuses to guess when a
 *   rewrite could destroy hand-written text (D-03's report-don't-destroy
 *   posture, mirroring `03-CONTEXT.md` D-21).
 */
export const SPLICE_RESULT = Object.freeze({
  SPLICED: 'spliced',
  SELF_HEAL: 'self-heal',
  DAMAGED: 'damaged',
} as const);
export type SpliceResultKind = typeof SPLICE_RESULT[keyof typeof SPLICE_RESULT];

/**
 * The two repairing members carry the new body string; the damaged member
 * carries a detail string and, deliberately, no `body` field at all — so no
 * caller can accidentally read a partial replacement out of a damaged
 * result.
 */
export type SpliceOutcome =
  | { kind: typeof SPLICE_RESULT.SPLICED; body: string }
  | { kind: typeof SPLICE_RESULT.SELF_HEAL; body: string }
  | { kind: typeof SPLICE_RESULT.DAMAGED; detail: string };

/** Counts non-overlapping occurrences of a literal token via split-length minus one. */
function countFenceOccurrences(body: string, token: string): number {
  return body.split(token).length - 1;
}

/**
 * Splices `region` into `currentBody` by severity (D-03/D-04). Literal
 * string scanning only — no markdown parser: the fence tokens are GSD's own
 * fixed literals, not general markdown structure (04-RESEARCH.md "Don't
 * Hand-Roll"). Never throws, for any input including the empty string. Does
 * not normalize, trim, or reflow any part of the body outside the region,
 * and never moves the region's position within the body.
 */
export function spliceRegion(currentBody: string, region: string): SpliceOutcome {
  const beginCount = countFenceOccurrences(currentBody, FENCE_BEGIN);
  const endCount = countFenceOccurrences(currentBody, FENCE_END);

  if (beginCount === 0 && endCount === 0) {
    return {
      kind: SPLICE_RESULT.SELF_HEAL,
      body: `${currentBody}\n${FENCE_BEGIN}\n${region}\n${FENCE_END}\n`,
    };
  }

  if (beginCount === 1 && endCount === 1) {
    const beginIndex = currentBody.indexOf(FENCE_BEGIN);
    const endIndex = currentBody.indexOf(FENCE_END);
    if (endIndex < beginIndex) {
      return {
        kind: SPLICE_RESULT.DAMAGED,
        detail: 'the end fence appears before the begin fence — the pair is inverted, not merely miscounted',
      };
    }
    const before = currentBody.slice(0, beginIndex + FENCE_BEGIN.length);
    const after = currentBody.slice(endIndex);
    return { kind: SPLICE_RESULT.SPLICED, body: `${before}\n${region}\n${after}` };
  }

  return {
    kind: SPLICE_RESULT.DAMAGED,
    detail: `expected exactly one begin fence and one end fence; found ${beginCount} begin fence(s) and ${endCount} end fence(s)`,
  };
}

/**
 * D-13: the full issue-content projection — title, rendered region, and
 * milestone number together — so a rename or a milestone reassignment
 * cannot hash-equal a stale record and silently never converge.
 */
export interface ContentProjection {
  title: string;
  region: string;
  milestoneNumber: number;
}

/**
 * D-08: a pure function of its inputs, with no I/O and no clock — the same
 * projection hashes identically across processes and machines, which is
 * what lets `planReconciliation` decide the no-op branch offline with no
 * remote body read at all.
 *
 * Serializes via `JSON.stringify` over an object literal whose keys are
 * written in this fixed order — unambiguous under any input, including one
 * whose title or region contains the serialization's own delimiter
 * characters (04-RESEARCH.md "Don't Hand-Roll": `JSON.stringify` needs no
 * encoding rules of its own, unlike a delimiter-joined concatenation). This
 * is change detection, not authentication: no keyed or HMAC construction is
 * warranted, and none is used.
 */
export function contentHash(projection: ContentProjection): string {
  const canonical = JSON.stringify({
    title: projection.title,
    region: projection.region,
    milestoneNumber: projection.milestoneNumber,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * D-12: the four item field values compared as their own convergence unit,
 * independent of the issue-content projection above — advancing a phase
 * emits one field write and touches no issue body.
 */
export interface FieldValues {
  gsdId: string;
  phaseId: string;
  requirements: string[];
  status: string;
}

/** The four `FieldValues` keys, in the fixed order `changedFields` reports them. */
const FIELD_NAMES = ['gsdId', 'phaseId', 'requirements', 'status'] as const;
export type FieldName = typeof FIELD_NAMES[number];

/**
 * A parsed field-state record: `known` when the serialized string decoded
 * to a well-shaped `FieldValues`, `unknown` for anything else — absent,
 * unparseable, or shape-mismatched input. An `unknown` previous state must
 * read as "every field differs", so the next run rewrites all four and
 * converges rather than skipping a write it cannot justify (see
 * `changedFields` below).
 */
export type ParsedFieldState =
  | { kind: 'known'; values: FieldValues }
  | { kind: 'unknown' };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Serializes the four item field values as a flat string via
 * `JSON.stringify`, for the same reason `contentHash` uses it. Stored as a
 * flat string on the completion record: the sync map's validator is a
 * closed schema of scalars, and a nested object would need a new validator
 * branch for no benefit.
 */
export function renderFieldState(values: FieldValues): string {
  return JSON.stringify({
    gsdId: values.gsdId,
    phaseId: values.phaseId,
    requirements: values.requirements,
    status: values.status,
  });
}

/**
 * Parses a serialized field state. Never throws: any JSON parse failure,
 * any non-record top level, or any field whose shape does not match
 * `FieldValues` exactly (including a requirements entry that is not a
 * string) yields `{ kind: 'unknown' }` rather than a partial result.
 */
export function parseFieldState(serialized: string): ParsedFieldState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return { kind: 'unknown' };
  }
  if (!isPlainRecord(parsed)) return { kind: 'unknown' };
  const { gsdId, phaseId, requirements, status } = parsed;
  if (typeof gsdId !== 'string' || typeof phaseId !== 'string' || typeof status !== 'string') {
    return { kind: 'unknown' };
  }
  if (!Array.isArray(requirements) || !requirements.every((entry) => typeof entry === 'string')) {
    return { kind: 'unknown' };
  }
  return { kind: 'known', values: { gsdId, phaseId, requirements, status } };
}

function sameRequirements(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/**
 * D-12's predicate: the subset of the four field names whose values differ
 * between `previous` and `desired`, treating an unknown previous state as
 * all four differing. Kept beside `renderFieldState`/`parseFieldState` so
 * the write decision and the state format cannot disagree.
 */
export function changedFields(previous: ParsedFieldState, desired: FieldValues): FieldName[] {
  if (previous.kind === 'unknown') return [...FIELD_NAMES];
  const changed: FieldName[] = [];
  if (previous.values.gsdId !== desired.gsdId) changed.push('gsdId');
  if (previous.values.phaseId !== desired.phaseId) changed.push('phaseId');
  if (!sameRequirements(previous.values.requirements, desired.requirements)) changed.push('requirements');
  if (previous.values.status !== desired.status) changed.push('status');
  return changed;
}
