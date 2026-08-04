'use strict';
/**
 * github-sync-bootstrap-report.cts — human and raw rendering of the `init`
 * two-pass outcome, following `github-sync-status.cts`'s precedent (Phase 2
 * D-13/D-14/D-15): a pure DTO builder (`buildInitReportV1`) and a separate
 * renderer (`renderInitReportV1`) that decides human-vs-JSON. No I/O
 * imports, no filesystem, no subprocess.
 *
 * **The outcome journal is the report's only source of counts; the plan is
 * the only source of the noop/partial notes it renders; a note never
 * increments a quantity.** Reading counts off the plan instead would let the report claim
 * an object was created when its mutation failed (the composition suite's
 * partial-failure case would catch that); reading them off a bare confirmed-
 * key list would report five adopted `Status` options as five creations
 * (nothing would catch that) — see `OperationOutcome`'s doc comment in
 * `github-sync-operation.cts` and plan 03-01's `<checkpoint_contract>`
 * clause 3a for the aggregation rule this module implements:
 *
 * - **created / updated / linked** — distinct non-null `operationKey`
 *   values among that stage's entries whose result is confirmed. One
 *   dispatched mutation is one remote action, however many completions it
 *   fanned out to (a `Status` merge confirms five option keys under one
 *   `operationKey` and counts as one update, never five).
 * - **adopted / unchanged** — distinct **logical keys** whose action is
 *   observe (an observation dispatches nothing, so its `operationKey` is
 *   always `null`, and distinct-operation counting would collapse every
 *   observation in a stage into one).
 * - **skipped** — distinct non-null `operationKey` values whose result is
 *   already-exists. Nothing else: a noop that produced no checkpoint at all
 *   is a plan-level fact, never a journal fact, and is surfaced as a note
 *   instead (see below).
 *
 * **Stage attribution** is read from the plan's own declared `stage` only
 * where the logical-key namespace is ambiguous (`field:*`, shared by the
 * FIELDS and AUTONOMOUS stages — plan 03-04 Task 3's stage-tagging exists
 * for exactly this). Every other namespace (`project`, `project-link`,
 * `label:*`, `milestone:*`, `option:status:*`) is exclusively owned by one
 * stage and is resolved directly from the key, because `planProject` and
 * `planStatusOptionMerge` do not themselves stamp a `stage` field.
 *
 * **Noops become human-readable notes, and are never counted.** The plan
 * carries information the journal cannot — which spelling a case-variant
 * label was adopted under, that a stage found nothing to do — attributed to
 * a stage by the noop's own reason (a closed catalog), rendered under that
 * stage's line in the human form.
 *
 * **`partial` entries (06-07 gap closure) become notes the same way, never
 * a count and never `blocked`.** A plan's `partial` field (see
 * `github-sync-bootstrap-plan.cts`'s `BootstrapPlan.partial`) carries a
 * per-item skip whose apply still ran — `tallyPartials` renders each entry
 * through `reasonSentence` so the note names the specific view and field,
 * while `deriveOutcome` never reads `partial` at all: a run that applied
 * everything it could stays `completed`.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import bootstrapPlanMod = require('./github-sync-bootstrap-plan.cjs');

const { BOOTSTRAP_OPERATION_REASON } = bootstrapPlanMod as { BOOTSTRAP_OPERATION_REASON: Record<string, string> };

/**
 * Mirrors `github-sync-gh.cts`'s `GH_REASON` (its transport seam pulls in a
 * real subprocess module, which this pure DTO/renderer module never
 * imports — the same zero-I/O-import precedent `github-sync-bootstrap-
 * plan.cts` sets for its own duplicated GraphQL document text). Four short
 * literal strings, pinned against the canonical copy by a differential test.
 */
const GH_TRANSPORT_REASON = Object.freeze({
  OK: 'ok',
  ENOENT: 'gh_not_found',
  TIMEOUT: 'gh_timed_out',
  EXIT_NONZERO: 'gh_exit_nonzero',
} as const);

const REPORT_SCHEMA_VERSION = 1;

const REPORT_STAGE = Object.freeze({
  PROJECT: 'project',
  LINK: 'link',
  FIELDS: 'fields',
  LABELS: 'labels',
  MILESTONES: 'milestones',
  STATUS: 'status',
  AUTONOMOUS: 'autonomous',
  VIEWS: 'views',
} as const);
type ReportStage = typeof REPORT_STAGE[keyof typeof REPORT_STAGE];

const OUTCOME_KIND = Object.freeze({
  COMPLETED: 'completed',
  BLOCKED: 'blocked',
  FAILED: 'failed',
  UNCERTAIN: 'uncertain',
} as const);
type OutcomeKind = typeof OUTCOME_KIND[keyof typeof OUTCOME_KIND];

// ─── input shapes (structurally compatible with, not imported from, the producer modules) ──

interface PlanEntryLike { logicalKey: string; stage?: string; }
interface NoopLike { reason: string; detail?: string; }
interface BlockedLike { reason: string; detail?: string; }
interface UncertainLike { reason: string; }
interface PlanLike {
  operations?: PlanEntryLike[];
  checkpoints?: PlanEntryLike[];
  noops?: NoopLike[];
  blocked?: BlockedLike[];
  uncertain?: UncertainLike[];
  /**
   * 06-07 gap closure (CR-01 Task 2): per-item blocked entries the plan
   * layer no longer routes through `blocked` (a producer that predates
   * this field, or an injected test seam, still builds a report without
   * it — optional for that reason).
   */
  partial?: BlockedLike[];
}
interface OutcomeLike { logicalKey: string; operationKey: string | null; action: string; result: string; }
interface ApplyResultLike {
  kind: 'completed' | 'failed' | 'uncertain';
  outcomes?: OutcomeLike[];
  logicalKey?: string;
  remediation?: string;
}
interface PreflightFailureLike { reason: string; message: string; }
/** A router-level failure outside the closed BOOTSTRAP_OPERATION_REASON/GH_REASON catalogs (e.g. `target_unavailable`) — the router already composed its own message once; this module forwards it rather than re-deriving one through the exhaustive switch, exactly as it forwards a preflight failure. */
interface ExternalBlockedLike { reason: string; remediation: string; kind?: 'blocked' | 'uncertain'; }

interface InitReportTarget {
  owner: string | null;
  repo: string | null;
  projectNumber: number | null;
}

interface BuildInitReportInput {
  target: InitReportTarget;
  /** When set, preflight failed before any pass ran — its message is forwarded verbatim, never re-derived. */
  preflightFailure?: PreflightFailureLike | null;
  /** When set (and `preflightFailure` is not), a router-level failure outside this plan's reason catalogs is forwarded verbatim. */
  externalBlocked?: ExternalBlockedLike | null;
  structurePlan?: PlanLike | null;
  structureApply?: ApplyResultLike | null;
  optionsPlan?: PlanLike | null;
  optionsApply?: ApplyResultLike | null;
  /** A non-fatal notice about the config write step (D-02) — attached to a `completed` outcome without changing its kind. */
  configWriteNotice?: string | null;
}

interface InitReportStage {
  stage: ReportStage;
  created: number;
  updated: number;
  linked: number;
  adopted: number;
  unchanged: number;
  skipped: number;
  notes: string[];
}

interface InitReportOutcome {
  kind: OutcomeKind;
  reason?: string;
  logicalKey?: string;
  remediation: string;
  pass?: 'structure' | 'options';
  configWriteNotice?: string;
}

interface InitReportV1 {
  version: typeof REPORT_SCHEMA_VERSION;
  target: InitReportTarget;
  stages: InitReportStage[];
  outcome: InitReportOutcome;
}

// ─── stage resolution ───────────────────────────────────────────────────

function emptyStage(stage: ReportStage): InitReportStage {
  return { stage, created: 0, updated: 0, linked: 0, adopted: 0, unchanged: 0, skipped: 0, notes: [] };
}

function planEntries(plan: PlanLike | null | undefined): PlanEntryLike[] {
  if (!plan) return [];
  return [...(plan.operations ?? []), ...(plan.checkpoints ?? [])];
}

/**
 * `project`, `project-link`, `label:*`, `milestone:*`, and `option:status:*`
 * are each exclusively owned by one stage — resolved directly from the key.
 * `field:*` is the one ambiguous namespace (shared by FIELDS and
 * AUTONOMOUS): resolved by looking the entry up in the combined plan
 * (matched by `operationKey` when present, else by the observation's own
 * `logicalKey`) and reading its declared `stage`, defaulting to FIELDS when
 * the match carries no stage or is not found (every `field:*` entry that is
 * NOT the Autonomous merge is FIELDS, tagged or not).
 */
function resolveStage(outcome: OutcomeLike, allEntries: PlanEntryLike[]): ReportStage | null {
  const key = outcome.logicalKey;
  if (key === 'project') return REPORT_STAGE.PROJECT;
  if (key === 'project-link') return REPORT_STAGE.LINK;
  if (key.startsWith('label:')) return REPORT_STAGE.LABELS;
  if (key.startsWith('milestone:')) return REPORT_STAGE.MILESTONES;
  if (key.startsWith('option:status:')) return REPORT_STAGE.STATUS;
  // Phase 6 D-01: a view's own reserved key namespace — exclusively owned by
  // the VIEWS stage, resolved directly from the key like `label:`/`milestone:`
  // above; without this branch every view outcome resolves to `null` and is
  // silently dropped from every stage tally.
  if (key.startsWith('view:')) return REPORT_STAGE.VIEWS;
  if (key.startsWith('field:')) {
    const matchKey = outcome.operationKey ?? outcome.logicalKey;
    const found = allEntries.find((entry) => entry.logicalKey === matchKey);
    return found?.stage === 'autonomous' ? REPORT_STAGE.AUTONOMOUS : REPORT_STAGE.FIELDS;
  }
  return null;
}

function attributeNoopStage(reason: string): ReportStage | null {
  if (reason === BOOTSTRAP_OPERATION_REASON.LABEL_EXISTS) return REPORT_STAGE.LABELS;
  if (reason === BOOTSTRAP_OPERATION_REASON.MILESTONE_EXISTS) return REPORT_STAGE.MILESTONES;
  if (reason === BOOTSTRAP_OPERATION_REASON.PROJECT_UNSET) return REPORT_STAGE.PROJECT;
  // 06-07 gap closure (CR-01 Task 2): a per-item view skip is attributed to
  // the VIEWS stage — the same stage a `view:*` outcome resolves to in
  // `resolveStage` above — so its note lands beside the rest of that
  // stage's activity rather than nowhere.
  if (reason === BOOTSTRAP_OPERATION_REASON.VIEW_FIELD_UNRESOLVED) return REPORT_STAGE.VIEWS;
  return null;
}

function noteText(noop: NoopLike): string {
  return noop.detail ? `${noop.reason}: ${noop.detail}` : noop.reason;
}

/** Per-stage `operationKey`/`logicalKey` distinctness sets, keyed `${stage}|${bucket}`, discarded after tallying. */
function tallyOutcomes(outcomes: OutcomeLike[], allEntries: PlanEntryLike[], stageMap: Map<ReportStage, InitReportStage>): void {
  const seen = new Map<string, Set<string>>();
  const markDistinct = (bucketKey: string, distinctKey: string): boolean => {
    let set = seen.get(bucketKey);
    if (!set) { set = new Set(); seen.set(bucketKey, set); }
    if (set.has(distinctKey)) return false;
    set.add(distinctKey);
    return true;
  };

  for (const outcome of outcomes) {
    const stage = resolveStage(outcome, allEntries);
    if (!stage) continue;
    const counts = stageMap.get(stage);
    if (!counts) continue;

    if (outcome.result === 'confirmed' && outcome.action === 'observe') {
      if (markDistinct(`${stage}|adopted`, outcome.logicalKey)) counts.adopted += 1;
      continue;
    }
    if (outcome.result === 'unchanged') {
      if (markDistinct(`${stage}|unchanged`, outcome.logicalKey)) counts.unchanged += 1;
      continue;
    }
    if (outcome.result === 'already-exists' && outcome.operationKey) {
      if (markDistinct(`${stage}|skipped`, outcome.operationKey)) counts.skipped += 1;
      continue;
    }
    if (outcome.result === 'confirmed' && outcome.operationKey) {
      const bucket = outcome.action === 'create' ? 'created' : outcome.action === 'update' ? 'updated' : outcome.action === 'link' ? 'linked' : null;
      if (bucket && markDistinct(`${stage}|${bucket}`, outcome.operationKey)) {
        (counts as unknown as Record<string, number>)[bucket] += 1;
      }
    }
  }
}

function tallyNoops(noops: NoopLike[] | undefined, stageMap: Map<ReportStage, InitReportStage>): void {
  for (const noop of noops ?? []) {
    const stage = attributeNoopStage(noop.reason);
    if (!stage) continue;
    stageMap.get(stage)?.notes.push(noteText(noop));
  }
}

/**
 * 06-07 gap closure (CR-01 Task 2): mirrors `tallyNoops`' shape but reads a
 * pass's `partial` array (its per-item, non-fatal blocked entries — see
 * `PlanLike.partial`'s doc comment) instead of `noops`, and renders each
 * entry through `reasonSentence` rather than `noteText`'s bare
 * `reason: detail` pairing — a `partial` entry's `detail` carries the view
 * name and the missing field name a developer needs to see, and
 * `reasonSentence`'s `view_field_unresolved` case is the one place that
 * composes the full, actionable sentence around it. Increments no counter:
 * a skipped view dispatched nothing, so it produced no outcome-journal
 * entry, and this module's own header states a note never increments a
 * quantity — do not "fix" this back into a skipped/blocked count.
 */
function tallyPartials(partials: BlockedLike[] | undefined, stageMap: Map<ReportStage, InitReportStage>): void {
  for (const entry of partials ?? []) {
    const stage = attributeNoopStage(entry.reason);
    if (!stage) continue;
    stageMap.get(stage)?.notes.push(reasonSentence(entry.reason as ReportReason, entry.detail));
  }
}

// ─── outcome derivation ─────────────────────────────────────────────────

/**
 * A closed literal union mirroring `BOOTSTRAP_OPERATION_REASON`'s eleven
 * blocked/uncertain-eligible members plus `GH_TRANSPORT_REASON`'s four
 * members — duplicated as string literals, not derived from the imported
 * `Record<string, string>` enum objects, because a switch discriminant
 * typed as plain `string` cannot narrow to `never` after exhausting cases
 * (the enum objects' own values are widened to `string` the moment they
 * cross a `require()` boundary). A differential test in
 * `tests/github-sync-bootstrap-report.test.cjs` pins every literal below
 * against the canonical enum member it mirrors, so a future rename cannot
 * silently drift. `PROJECT_UNSET`/`LABEL_EXISTS`/`MILESTONE_EXISTS` are
 * noop-only reasons in the plan layer but are covered here too, since the
 * exhaustiveness guarantee is over the whole enum, not only its
 * blocked/uncertain subset.
 */
type BootstrapOperationReason =
  | 'desired_unavailable' | 'remote_unavailable' | 'map_blocking' | 'missing_status_field'
  | 'project_unset' | 'unsafe_target' | 'project_not_found' | 'owner_unresolvable'
  | 'field_type_mismatch' | 'rest_unavailable' | 'label_exists' | 'milestone_exists'
  | 'view_field_unresolved';
type GhTransportReason = 'ok' | 'gh_not_found' | 'gh_timed_out' | 'gh_exit_nonzero';
type ReportReason = BootstrapOperationReason | GhTransportReason;

function reasonSentence(reason: ReportReason, detail?: string): string {
  const withDetail = (base: string): string => (detail ? `${base} (${detail})` : base);
  switch (reason) {
    case 'desired_unavailable':
      return withDetail('Local .planning/ state could not be read — fix the reported planning-file fault, then re-run `gsd-tools github-sync init`.');
    case 'remote_unavailable':
      return withDetail('GitHub could not be read — retry `gsd-tools github-sync init` shortly; check https://www.githubstatus.com if the problem persists.');
    case 'map_blocking':
      return withDetail('The local sync map (.planning/.github-sync.json) is invalid, unsupported, or bound to a different repository — repair or remove it, then re-run.');
    case 'missing_status_field':
      return 'The Project has no built-in Status field, which every Project v2 board carries by default — verify the board was not modified in an unsupported way.';
    case 'project_unset':
      return 'No Project is configured yet — the next run creates one.';
    case 'unsafe_target':
      return withDetail('The configured owner or repository name contains a character (brace, slash, or at-sign) that cannot safely build a GitHub API request — correct github_sync.target in .planning/config.json.');
    case 'project_not_found':
      return withDetail('The configured github_sync.target.project_number does not resolve for this owner — correct the number, or clear it so `init` creates a fresh board.');
    case 'owner_unresolvable':
      return withDetail('The repository owner could not be resolved from GitHub — verify github_sync.target.owner and repo in .planning/config.json.');
    case 'field_type_mismatch':
      return withDetail('A field GSD needs already exists with the wrong data type. GSD will not delete the field, because doing so destroys every value stored in it — retype or rename the field on GitHub, then re-run.');
    case 'rest_unavailable':
      return withDetail('A GitHub REST list read (labels or milestones) failed — retry `gsd-tools github-sync init` shortly.');
    case 'label_exists':
      return withDetail('The label already exists and was adopted rather than created.');
    case 'milestone_exists':
      return withDetail('The milestone already exists and was adopted rather than created.');
    case 'view_field_unresolved':
      return withDetail('A GSD view needs a field that does not resolve on this Project yet — it will be created once that field exists (usually after the next run\'s fields stage completes).');
    case 'ok':
      return 'The GitHub CLI call succeeded.';
    case 'gh_not_found':
      return 'The `gh` CLI was not found on PATH. Install it from https://cli.github.com, then re-run.';
    case 'gh_timed_out':
      return 'The GitHub CLI call timed out — retry `gsd-tools github-sync init` shortly.';
    case 'gh_exit_nonzero':
      return 'The GitHub CLI call failed — retry `gsd-tools github-sync init` shortly; check https://www.githubstatus.com if the problem persists.';
    default:
      return assertNeverReason(reason);
  }
}

/**
 * The reason switch's exhaustiveness terminal. Not merely the absence of a
 * default clause: a member added to either reason enum in a later phase
 * without a corresponding case here fails `npm run build:lib` at THIS call
 * site under the error-blocking compiler setting, rather than silently
 * rendering an empty string — the enum and this switch must co-evolve in
 * the same change.
 */
function assertNeverReason(reason: never): never {
  throw new Error(`github-sync-bootstrap-report: unhandled reason "${String(reason)}" — add a case to reasonSentence.`);
}

function withConfigWriteNotice(outcome: InitReportOutcome, input: BuildInitReportInput): InitReportOutcome {
  return input.configWriteNotice ? { ...outcome, configWriteNotice: input.configWriteNotice } : outcome;
}

function deriveOutcome(input: BuildInitReportInput): InitReportOutcome {
  if (input.preflightFailure) {
    return { kind: OUTCOME_KIND.BLOCKED, reason: input.preflightFailure.reason, remediation: input.preflightFailure.message };
  }
  if (input.externalBlocked) {
    return {
      kind: input.externalBlocked.kind ?? OUTCOME_KIND.BLOCKED,
      reason: input.externalBlocked.reason,
      remediation: input.externalBlocked.remediation,
    };
  }

  const structurePlan = input.structurePlan ?? null;
  if (structurePlan?.blocked && structurePlan.blocked.length > 0) {
    const { reason, detail } = structurePlan.blocked[0];
    return { kind: OUTCOME_KIND.BLOCKED, reason, remediation: reasonSentence(reason as ReportReason, detail), pass: 'structure' };
  }
  if (structurePlan?.uncertain && structurePlan.uncertain.length > 0) {
    const { reason } = structurePlan.uncertain[0];
    return { kind: OUTCOME_KIND.UNCERTAIN, reason, remediation: reasonSentence(reason as ReportReason), pass: 'structure' };
  }
  const structureApply = input.structureApply ?? null;
  if (structureApply && structureApply.kind !== 'completed') {
    return {
      kind: structureApply.kind,
      logicalKey: structureApply.logicalKey,
      remediation: structureApply.remediation ?? 'Retry `gsd-tools github-sync init` after resolving the reported GitHub failure.',
      pass: 'structure',
    };
  }

  const optionsPlan = input.optionsPlan ?? null;
  if (optionsPlan?.blocked && optionsPlan.blocked.length > 0) {
    const { reason, detail } = optionsPlan.blocked[0];
    return { kind: OUTCOME_KIND.BLOCKED, reason, remediation: reasonSentence(reason as ReportReason, detail), pass: 'options' };
  }
  if (optionsPlan?.uncertain && optionsPlan.uncertain.length > 0) {
    const { reason } = optionsPlan.uncertain[0];
    return { kind: OUTCOME_KIND.UNCERTAIN, reason, remediation: reasonSentence(reason as ReportReason), pass: 'options' };
  }
  const optionsApply = input.optionsApply ?? null;
  if (optionsApply && optionsApply.kind !== 'completed') {
    return {
      kind: optionsApply.kind,
      logicalKey: optionsApply.logicalKey,
      remediation: optionsApply.remediation ?? 'Retry `gsd-tools github-sync init` after resolving the reported GitHub failure.',
      pass: 'options',
    };
  }

  return withConfigWriteNotice({ kind: OUTCOME_KIND.COMPLETED, remediation: 'init completed successfully.' }, input);
}

// ─── the two exports ────────────────────────────────────────────────────

/**
 * Builds the DTO from both passes' plans and apply results. Counts are
 * derived from the outcome journal's declared action and result only; notes
 * are derived from the plan's noops only — see this module's header for the
 * aggregation rule and why the two must never be confused.
 */
function buildInitReportV1(input: BuildInitReportInput): InitReportV1 {
  const stageMap = new Map<ReportStage, InitReportStage>();
  for (const stage of Object.values(REPORT_STAGE)) stageMap.set(stage, emptyStage(stage));

  const allEntries = [...planEntries(input.structurePlan), ...planEntries(input.optionsPlan)];
  tallyOutcomes(input.structureApply?.outcomes ?? [], allEntries, stageMap);
  tallyOutcomes(input.optionsApply?.outcomes ?? [], allEntries, stageMap);
  tallyNoops(input.structurePlan?.noops, stageMap);
  tallyNoops(input.optionsPlan?.noops, stageMap);
  // 06-07 gap closure (CR-01 Task 2): notes from the plan's `partial`
  // entries, immediately after the two `tallyNoops` calls — the ordering
  // rule stays "counts from the journal, notes from the plan".
  tallyPartials(input.structurePlan?.partial, stageMap);
  tallyPartials(input.optionsPlan?.partial, stageMap);

  return {
    version: REPORT_SCHEMA_VERSION,
    target: input.target,
    stages: Object.values(REPORT_STAGE).map((stage) => stageMap.get(stage) as InitReportStage),
    outcome: deriveOutcome(input),
  };
}

function stageLabel(stage: ReportStage): string {
  switch (stage) {
    case REPORT_STAGE.PROJECT: return 'project';
    case REPORT_STAGE.LINK: return 'link';
    case REPORT_STAGE.FIELDS: return 'fields';
    case REPORT_STAGE.LABELS: return 'labels';
    case REPORT_STAGE.MILESTONES: return 'milestones';
    case REPORT_STAGE.STATUS: return 'status';
    case REPORT_STAGE.AUTONOMOUS: return 'autonomous';
    case REPORT_STAGE.VIEWS: return 'views';
    default: return assertNeverStage(stage);
  }
}
function assertNeverStage(stage: never): never {
  throw new Error(`github-sync-bootstrap-report: unhandled stage "${String(stage)}".`);
}

function renderStageLine(stage: InitReportStage): string[] {
  const quantities: string[] = [];
  if (stage.created > 0) quantities.push(`created ${stage.created}`);
  if (stage.updated > 0) quantities.push(`updated ${stage.updated}`);
  if (stage.linked > 0) quantities.push(`linked ${stage.linked}`);
  if (stage.adopted > 0) quantities.push(`adopted ${stage.adopted}`);
  if (stage.unchanged > 0) quantities.push(`unchanged ${stage.unchanged}`);
  if (stage.skipped > 0) quantities.push(`skipped ${stage.skipped}`);
  if (quantities.length === 0 && stage.notes.length === 0) return [];
  const summary = quantities.length > 0 ? quantities.join(', ') : 'no changes';
  const lines = [`${stageLabel(stage.stage)}: ${summary}`];
  for (const note of stage.notes) lines.push(`  - ${note}`);
  return lines;
}

/**
 * `renderInitReportV1(report, raw)`: the serialized DTO under the raw flag,
 * a human-readable block otherwise — following `renderStatusV1`'s
 * established shape (raw branch first, so the machine surface can never be
 * affected by the human summary growing). A run that created nothing and
 * adopted everything reads as an adoption ("adopted N"), never as a silent,
 * empty bootstrap, because a stage with only `adopted`/`unchanged` still
 * renders its line.
 */
function renderInitReportV1(report: InitReportV1, raw: boolean): string {
  if (raw) return JSON.stringify(report);

  const lines: string[] = [];
  const targetBits = [report.target.owner ?? '(unresolved)', report.target.repo ?? '(unresolved)'];
  const projectBit = report.target.projectNumber ? `#${report.target.projectNumber}` : '(none yet)';
  lines.push(`github-sync init: ${targetBits.join('/')} project ${projectBit}`);

  for (const stage of report.stages) {
    lines.push(...renderStageLine(stage));
  }

  const outcome = report.outcome;
  if (outcome.kind === OUTCOME_KIND.COMPLETED) {
    lines.push('outcome: completed');
  } else {
    const passSuffix = outcome.pass ? ` (${outcome.pass} pass)` : '';
    const reasonBit = outcome.reason ? ` [${outcome.reason}]` : (outcome.logicalKey ? ` [${outcome.logicalKey}]` : '');
    lines.push(`outcome: ${outcome.kind}${passSuffix}${reasonBit} — ${outcome.remediation}`);
  }
  if (outcome.configWriteNotice) {
    lines.push(`config write notice: ${outcome.configWriteNotice}`);
  }

  return lines.join('\n') + '\n';
}

export = {
  buildInitReportV1,
  renderInitReportV1,
  REPORT_SCHEMA_VERSION,
  REPORT_STAGE,
  OUTCOME_KIND,
  GH_TRANSPORT_REASON,
};
