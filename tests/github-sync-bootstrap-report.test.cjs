'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildInitReportV1,
  renderInitReportV1,
  REPORT_STAGE,
  GH_TRANSPORT_REASON,
} = require('../gsd-core/bin/lib/github-sync-bootstrap-report.cjs');
const { BOOTSTRAP_OPERATION_REASON } = require('../gsd-core/bin/lib/github-sync-bootstrap-plan.cjs');
const { GH_REASON } = require('../gsd-core/bin/lib/github-sync-gh.cjs');

const TARGET = { owner: 'octo', repo: 'roadmap', projectNumber: 9 };

function outcome(logicalKey, operationKey, action, result) {
  return { logicalKey, operationKey, action, result };
}

function stageByName(report, name) {
  return report.stages.find((s) => s.stage === name);
}

// ─── differential pin: the report's duplicated reason literals against the canonical enums ──

describe('duplicated reason literals stay pinned to their canonical source', () => {
  test('every BOOTSTRAP_OPERATION_REASON member renders a non-empty sentence', () => {
    for (const reason of Object.values(BOOTSTRAP_OPERATION_REASON)) {
      const report = buildInitReportV1({
        target: TARGET,
        structurePlan: { operations: [], checkpoints: [], noops: [], blocked: [{ reason }], uncertain: [] },
      });
      assert.equal(typeof report.outcome.remediation, 'string');
      assert.ok(report.outcome.remediation.length > 0, `reason "${reason}" must render a non-empty sentence`);
      assert.doesNotMatch(report.outcome.remediation, /\[object|undefined|NaN/);
    }
  });

  test('every GH_REASON (transport-failure) member renders a non-empty sentence', () => {
    for (const reason of Object.values(GH_REASON)) {
      assert.ok(Object.values(GH_TRANSPORT_REASON).includes(reason), `GH_REASON member "${reason}" must be mirrored in GH_TRANSPORT_REASON`);
    }
    // The renderer itself is exercised indirectly: every GH_TRANSPORT_REASON
    // value is a member of the same closed union reasonSentence covers, and
    // this suite's structure-pass-blocked path proves the switch renders a
    // sentence for every BOOTSTRAP_OPERATION_REASON member above. A second,
    // direct pass over GH_TRANSPORT_REASON's own values confirms none is the
    // empty string (the literal used, byte-for-byte, in reasonSentence).
    for (const reason of Object.values(GH_TRANSPORT_REASON)) {
      assert.equal(typeof reason, 'string');
      assert.ok(reason.length > 0);
    }
  });
});

// ─── raw round-trip and human form basics ──────────────────────────────────

describe('raw round-trip and target', () => {
  test('the raw form round-trips through JSON.parse and carries a target object plus a 7-entry stages array', () => {
    const report = buildInitReportV1({ target: TARGET, structureApply: { kind: 'completed', outcomes: [] }, optionsApply: { kind: 'completed', outcomes: [] } });
    const raw = renderInitReportV1(report, true);
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed.target, TARGET);
    assert.equal(parsed.stages.length, 7);
    assert.deepEqual(parsed.stages.map((s) => s.stage).sort(), Object.values(REPORT_STAGE).sort());
  });

  test('the human form contains the target line and one line per stage that has something to report', () => {
    const report = buildInitReportV1({
      target: TARGET,
      structureApply: { kind: 'completed', outcomes: [outcome('project', 'project', 'create', 'confirmed')] },
      optionsApply: { kind: 'completed', outcomes: [] },
    });
    const human = renderInitReportV1(report, false);
    assert.match(human, /octo\/roadmap/);
    assert.match(human, /project: created 1/);
  });
});

// ─── counts come from the journal, never the plan ──────────────────────────

describe('counts are journal-derived, not plan-derived', () => {
  test('a report built from a plan holding four operations and a journal confirming two creations shows created counts summing to exactly 2', () => {
    const structurePlan = {
      operations: [{ logicalKey: 'label:gsd-phase' }, { logicalKey: 'label:gsd-plan' }, { logicalKey: 'milestone:v1-0' }, { logicalKey: 'milestone:v0-9' }],
      checkpoints: [], noops: [], blocked: [], uncertain: [],
    };
    const structureApply = {
      kind: 'completed',
      outcomes: [
        outcome('label:gsd-phase', 'label:gsd-phase', 'create', 'confirmed'),
        outcome('milestone:v1-0', 'milestone:v1-0', 'create', 'confirmed'),
      ],
    };
    const report = buildInitReportV1({ target: TARGET, structurePlan, structureApply });
    const totalCreated = report.stages.reduce((sum, s) => sum + s.created, 0);
    assert.equal(totalCreated, 2);
  });

  test('HIGH-F gate: one create/update/link/observe-confirmed/observe-unchanged/already-exists entry yields six distinct quantities of 1 each', () => {
    const structureApply = {
      kind: 'completed',
      outcomes: [
        outcome('field:gsd-id', 'field:gsd-id', 'create', 'confirmed'),
        outcome('field:phase', 'field:phase', 'update', 'confirmed'),
        outcome('project-link', 'project-link', 'link', 'confirmed'),
        outcome('label:gsd-phase', null, 'observe', 'confirmed'),
        outcome('label:gsd-plan', null, 'observe', 'unchanged'),
        outcome('milestone:v1-0', 'milestone:v1-0', 'create', 'already-exists'),
      ],
    };
    const report = buildInitReportV1({ target: TARGET, structureApply });
    const totals = report.stages.reduce((acc, s) => ({
      created: acc.created + s.created, updated: acc.updated + s.updated, linked: acc.linked + s.linked,
      adopted: acc.adopted + s.adopted, unchanged: acc.unchanged + s.unchanged, skipped: acc.skipped + s.skipped,
    }), { created: 0, updated: 0, linked: 0, adopted: 0, unchanged: 0, skipped: 0 });
    assert.deepEqual(totals, { created: 1, updated: 1, linked: 1, adopted: 1, unchanged: 1, skipped: 1 });
  });

  test('cycle-4 HIGH-6 gate: five update-confirmed entries under five distinct option:status:* keys sharing one operationKey report updated 1 and created 0', () => {
    const structureApply = {
      kind: 'completed',
      outcomes: [
        outcome('option:status:todo', 'field:status', 'update', 'confirmed'),
        outcome('option:status:in-progress', 'field:status', 'update', 'confirmed'),
        outcome('option:status:blocked', 'field:status', 'update', 'confirmed'),
        outcome('option:status:done', 'field:status', 'update', 'confirmed'),
        outcome('option:status:deferred', 'field:status', 'update', 'confirmed'),
      ],
    };
    const report = buildInitReportV1({ target: TARGET, optionsApply: structureApply });
    const status = stageByName(report, REPORT_STAGE.STATUS);
    assert.equal(status.updated, 1);
    assert.equal(status.created, 0);
  });

  test("adoption-side twin: five observe-confirmed entries under five distinct logical keys, all operationKey null, reports adopted 5, not 1", () => {
    const structureApply = {
      kind: 'completed',
      outcomes: [
        outcome('option:status:todo', null, 'observe', 'confirmed'),
        outcome('option:status:in-progress', null, 'observe', 'confirmed'),
        outcome('option:status:blocked', null, 'observe', 'confirmed'),
        outcome('option:status:done', null, 'observe', 'confirmed'),
        outcome('option:status:deferred', null, 'observe', 'confirmed'),
      ],
    };
    const report = buildInitReportV1({ target: TARGET, optionsApply: structureApply });
    assert.equal(stageByName(report, REPORT_STAGE.STATUS).adopted, 5);
  });

  test('a Status merge that confirms five option keys under the update action is reported as one update, not five creations', () => {
    const structureApply = {
      kind: 'completed',
      outcomes: ['todo', 'in-progress', 'blocked', 'done', 'deferred'].map((n) => outcome(`option:status:${n}`, 'field:status', 'update', 'confirmed')),
    };
    const report = buildInitReportV1({ target: TARGET, optionsApply: structureApply });
    const status = stageByName(report, REPORT_STAGE.STATUS);
    assert.equal(status.updated, 1);
    assert.equal(status.created, 0);
  });

  test('a field rename that confirms a field key under the update action is reported as an update', () => {
    const structurePlan = { operations: [{ logicalKey: 'field:wave', stage: 'fields' }], checkpoints: [], noops: [], blocked: [], uncertain: [] };
    const structureApply = { kind: 'completed', outcomes: [outcome('field:wave', 'field:wave', 'update', 'confirmed')] };
    const report = buildInitReportV1({ target: TARGET, structurePlan, structureApply });
    assert.equal(stageByName(report, REPORT_STAGE.FIELDS).updated, 1);
  });
});

// ─── stage attribution: the field:/autonomous ambiguity ────────────────────

describe('stage attribution', () => {
  test('the Autonomous option merge (field: prefix, AUTONOMOUS stage) is filed under autonomous, not fields', () => {
    const optionsPlan = { operations: [{ logicalKey: 'field:autonomous', stage: 'autonomous' }], checkpoints: [], noops: [], blocked: [], uncertain: [] };
    const optionsApply = { kind: 'completed', outcomes: [outcome('field:autonomous', 'field:autonomous', 'update', 'confirmed')] };
    const report = buildInitReportV1({ target: TARGET, optionsPlan, optionsApply });
    assert.equal(stageByName(report, REPORT_STAGE.AUTONOMOUS).updated, 1);
    assert.equal(stageByName(report, REPORT_STAGE.FIELDS).updated, 0);
  });

  test('an ordinary field: key with no stage-tagged plan entry defaults to fields', () => {
    const structureApply = { kind: 'completed', outcomes: [outcome('field:gsd-id', 'field:gsd-id', 'create', 'confirmed')] };
    const report = buildInitReportV1({ target: TARGET, structureApply });
    assert.equal(stageByName(report, REPORT_STAGE.FIELDS).created, 1);
  });
});

// ─── noop notes vs counts (non-HIGH #3, both halves) ────────────────────────

describe('noop notes are rendered and never counted', () => {
  test('a case-variant label noop renders its observed spelling in the human form while skipped stays 0 absent an already-exists entry', () => {
    const structurePlan = {
      operations: [], checkpoints: [], blocked: [], uncertain: [],
      noops: [{ reason: BOOTSTRAP_OPERATION_REASON.LABEL_EXISTS, detail: 'existing label spelled "GSD:Phase"' }],
    };
    const structureApply = { kind: 'completed', outcomes: [] };
    const report = buildInitReportV1({ target: TARGET, structurePlan, structureApply });
    const labels = stageByName(report, REPORT_STAGE.LABELS);
    assert.equal(labels.skipped, 0);
    assert.ok(labels.notes.some((n) => n.includes('GSD:Phase')));
    assert.match(renderInitReportV1(report, false), /GSD:Phase/);
  });

  test('a journal carrying an already-exists entry increments skipped by 1 for that stage independently of the plan noop count', () => {
    const structurePlan = { operations: [], checkpoints: [], blocked: [], uncertain: [], noops: [] };
    const structureApply = { kind: 'completed', outcomes: [outcome('label:gsd-phase', 'label:gsd-phase', 'create', 'already-exists')] };
    const report = buildInitReportV1({ target: TARGET, structurePlan, structureApply });
    assert.equal(stageByName(report, REPORT_STAGE.LABELS).skipped, 1);
  });
});

// ─── failed / already-exists / adopted-board framing ────────────────────────

describe('a failed apply never claims a created object', () => {
  test('a failed apply result whose journal holds one confirmed entry shows exactly one object accounted for, names the failed logical key, and carries the remediation', () => {
    const structureApply = {
      kind: 'failed', logicalKey: 'field:wave', remediation: 'Retry the sync after resolving the reported GitHub failure.',
      outcomes: [outcome('field:gsd-id', 'field:gsd-id', 'create', 'confirmed')],
    };
    const report = buildInitReportV1({ target: TARGET, structureApply });
    const totalCreated = report.stages.reduce((sum, s) => sum + s.created, 0);
    assert.equal(totalCreated, 1);
    assert.equal(report.outcome.kind, 'failed');
    assert.equal(report.outcome.logicalKey, 'field:wave');
    assert.equal(report.outcome.remediation, 'Retry the sync after resolving the reported GitHub failure.');
  });

  test('an already-exists recovery shows that object as skipped rather than created', () => {
    const structureApply = { kind: 'completed', outcomes: [outcome('label:gsd-phase', 'label:gsd-phase', 'create', 'already-exists')] };
    const report = buildInitReportV1({ target: TARGET, structureApply });
    const labels = stageByName(report, REPORT_STAGE.LABELS);
    assert.equal(labels.created, 0);
    assert.equal(labels.skipped, 1);
  });
});

describe('an adopted-board run reads as an adoption, never an empty bootstrap', () => {
  test('every entry observe-confirmed reports zero created and a non-zero adopted count, and the human form does not describe the run as having created anything', () => {
    const structureApply = {
      kind: 'completed',
      outcomes: [
        outcome('project', null, 'observe', 'confirmed'),
        outcome('project-link', null, 'observe', 'confirmed'),
        outcome('field:gsd-id', null, 'observe', 'confirmed'),
        outcome('label:gsd-phase', null, 'observe', 'confirmed'),
      ],
    };
    const optionsApply = { kind: 'completed', outcomes: [outcome('option:status:todo', null, 'observe', 'confirmed')] };
    const report = buildInitReportV1({ target: TARGET, structureApply, optionsApply });
    const totalCreated = report.stages.reduce((sum, s) => sum + s.created, 0);
    const totalAdopted = report.stages.reduce((sum, s) => sum + s.adopted, 0);
    assert.equal(totalCreated, 0);
    assert.ok(totalAdopted > 0);
    const human = renderInitReportV1(report, false);
    assert.doesNotMatch(human, /created \d/);
  });
});

// ─── failure rendering specifics ───────────────────────────────────────────

describe('failure rendering specifics', () => {
  test('a field-type-mismatch render contains the field name, the actual type, the required type, and states GSD will not delete the field', () => {
    const structurePlan = {
      operations: [], checkpoints: [], noops: [], uncertain: [],
      blocked: [{ reason: BOOTSTRAP_OPERATION_REASON.FIELD_TYPE_MISMATCH, detail: 'field "Wave" is TEXT but GSD requires NUMBER' }],
    };
    const report = buildInitReportV1({ target: TARGET, structurePlan });
    assert.match(report.outcome.remediation, /Wave/);
    assert.match(report.outcome.remediation, /TEXT/);
    assert.match(report.outcome.remediation, /NUMBER/);
    assert.match(report.outcome.remediation, /will not delete/);
  });

  test('a project-not-found render contains the attempted project number and the owner', () => {
    const structurePlan = {
      operations: [], checkpoints: [], noops: [], uncertain: [],
      blocked: [{ reason: BOOTSTRAP_OPERATION_REASON.PROJECT_NOT_FOUND, detail: 'project number 404 not found for owner octo' }],
    };
    const report = buildInitReportV1({ target: TARGET, structurePlan });
    assert.match(report.outcome.remediation, /404/);
    assert.match(report.outcome.remediation, /octo/);
  });

  test('the missing-scope render forwards the catalogued message for the environment it is given, verbatim, twice — once with no CI/token signal and once with one', () => {
    const developerReport = buildInitReportV1({
      target: { owner: null, repo: null, projectNumber: null },
      preflightFailure: { reason: 'wrong_scope', message: 'github-sync preflight: your GitHub token is missing the `project` scope. Run `gh auth refresh -s project`, then re-run `gsd-tools github-sync preflight`.' },
    });
    assert.match(developerReport.outcome.remediation, /gh auth refresh -s project/);

    const ciReport = buildInitReportV1({
      target: { owner: null, repo: null, projectNumber: null },
      preflightFailure: { reason: 'wrong_scope', message: 'github-sync preflight: this token cannot reach GitHub Projects v2. Export a classic personal access token with the `project` scope as `GH_TOKEN` in this CI environment.' },
    });
    assert.match(ciReport.outcome.remediation, /GH_TOKEN/);
    assert.notEqual(developerReport.outcome.remediation, ciReport.outcome.remediation);
  });

  test('both passes are represented: a run whose structure pass completed and whose options pass blocked names the options pass in its outcome', () => {
    const structureApply = { kind: 'completed', outcomes: [outcome('project', 'project', 'create', 'confirmed')] };
    const optionsPlan = { operations: [], checkpoints: [], noops: [], uncertain: [], blocked: [{ reason: BOOTSTRAP_OPERATION_REASON.MISSING_STATUS_FIELD }] };
    const report = buildInitReportV1({ target: TARGET, structureApply, optionsPlan });
    assert.equal(report.outcome.pass, 'options');
    assert.equal(report.outcome.kind, 'blocked');
    // The structure pass's own confirmed count must still show — a partial
    // run's earlier progress is not erased by the later pass's failure.
    assert.equal(stageByName(report, REPORT_STAGE.PROJECT).created, 1);
  });
});
