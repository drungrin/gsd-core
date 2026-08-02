'use strict';
/**
 * github-sync-issue-body.cts — pure, zero-I/O marker/fence/region renderer
 * for a GSD-owned phase issue body (plan 04-01). Every later phase-issue
 * body write composes through this module rather than string-building its
 * own marker or fence inline.
 *
 * Zero I/O imports: this module reads no file, no environment variable, and
 * makes no network or filesystem call. Every input is a typed
 * phase-shaped value already produced by `github-sync-desired.cts`.
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

interface RenderablePhase {
  id: string;
  title: string;
  goal: string;
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
 * The region interior for a phase: the goal under a heading, then a
 * provenance line naming the roadmap source and the phase's own section —
 * phrased so a reader arriving from a notification understands the issue is
 * a projection, not an authored artifact. Emits no markdown checkbox
 * anywhere, under any condition. Success criteria and requirement IDs are
 * added by a later plan in this phase once the desired-state reader
 * supplies them to this function's caller — this function's shape does not
 * change when they arrive, only its rendered contents.
 */
export function renderPhaseRegion(phase: RenderablePhase): string {
  const goalLine = phase.goal.length > 0 ? phase.goal : '_No goal recorded on the roadmap._';
  return [
    '## Goal',
    '',
    goalLine,
    '',
    '---',
    `_This issue is generated from \`${ROADMAP_PATH}\`, Phase ${phase.id}'s section. It is a one-way projection — edits made here are never synced back; update the roadmap instead._`,
  ].join('\n');
}

/**
 * D-04: the marker, a newline, the begin fence, the region, the end fence,
 * and one trailing newline — and nothing else.
 */
export function renderNewIssueBody(phase: RenderablePhase): string {
  return `${phaseMarker(phase.id)}\n${FENCE_BEGIN}\n${renderPhaseRegion(phase)}\n${FENCE_END}\n`;
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
