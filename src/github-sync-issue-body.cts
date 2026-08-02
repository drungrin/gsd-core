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
