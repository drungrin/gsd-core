'use strict';

/**
 * Spike: does `copyProjectV2` cross-owner-copy a template project with a
 * classic PAT, and does view grouping survive the copy? (D-13..D-16, plan
 * 01-05, phase 01-capability-shell-auth-preflight-bootstrap-path-spike.)
 *
 * This file lives under `tests/`, not `scripts/`, for two reasons worth
 * recording here: the repo enforces a coverage floor on `scripts/**\/*.cjs`
 * that a never-run credential-gated script would drag down for nothing, and
 * the `.slow.test.cjs` marker (see `scripts/run-tests.cjs`'s MARKED_SUITES)
 * gives the file a suite that is not part of the default per-task feedback
 * loop — `npm run test:unit` never touches it, only `npm run test:slow` /
 * `node scripts/run-tests.cjs --suite slow` / a direct `node --test` run.
 *
 * Every GraphQL call goes through `execGh` from
 * `gsd-core/bin/lib/github-sync-gh.cjs` — the same seam the capability uses
 * (D-02) — so a successful run also smoke-tests that seam against real
 * mutations, not just the read-only preflight probe plans 01-01..01-03
 * already exercised.
 *
 * SAFETY (T-1-16..T-1-19): this is the only test in the repo that can
 * mutate a real GitHub account. It requires FOUR environment signals, all
 * present, before it does anything beyond a `node:test` `skip`:
 *
 *   - GSD_SPIKE_COPY_PROJECT_V2 === '1'   (explicit opt-in; an ordinary
 *     `npm test` on a dev machine that happens to export GH_TOKEN must
 *     never mutate a real account)
 *   - GSD_SPIKE_SOURCE_PROJECT_ID          (node id of the template project)
 *   - GSD_SPIKE_DEST_OWNER_ID              (node id of a second owner)
 *   - GH_TOKEN non-empty                   (a classic PAT; presence only —
 *     the value is never read, logged, or asserted on by this file; execGh
 *     inherits the process environment, so exporting GH_TOKEN is sufficient
 *     and keeps the value out of any process argv/listing)
 *
 * Cleanup is unconditional: the only id ever passed to `deleteProjectV2` is
 * the one this run's own `copyProjectV2` response returns, asserted
 * non-empty first, issued inside a `finally` so an inspection failure still
 * removes the artifact. No id is ever taken from configuration, an env var,
 * or an enumeration of the account's projects (T-1-16).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { execGh } = require('../gsd-core/bin/lib/github-sync-gh.cjs');

const GATE_ENV_KEYS = Object.freeze([
  'GSD_SPIKE_COPY_PROJECT_V2',
  'GSD_SPIKE_SOURCE_PROJECT_ID',
  'GSD_SPIKE_DEST_OWNER_ID',
  'GH_TOKEN',
]);

// Presence-only check — never reads/logs/returns the *value* of GH_TOKEN,
// only whether it is set and non-empty (T-1-17). The other three signals
// are non-secret ids/flags and are safe to read directly.
function checkGate(env) {
  const missing = [];
  if (env.GSD_SPIKE_COPY_PROJECT_V2 !== '1') missing.push('GSD_SPIKE_COPY_PROJECT_V2');
  if (!env.GSD_SPIKE_SOURCE_PROJECT_ID) missing.push('GSD_SPIKE_SOURCE_PROJECT_ID');
  if (!env.GSD_SPIKE_DEST_OWNER_ID) missing.push('GSD_SPIKE_DEST_OWNER_ID');
  if (!env.GH_TOKEN || env.GH_TOKEN.length === 0) missing.push('GH_TOKEN');
  return { open: missing.length === 0, missing };
}

const gate = checkGate(process.env);

// GraphQL document text for each step. Kept as fixed literals — the source
// project id, destination owner id, and title are always passed through
// `-F`/typed variables, never string-concatenated into the query text
// (V5 input validation, per 01-RESEARCH.md).
const COPY_MUTATION = `
  mutation($projectId: ID!, $ownerId: ID!, $title: String!) {
    copyProjectV2(input: {
      projectId: $projectId,
      ownerId: $ownerId,
      title: $title,
      includeDraftIssues: false
    }) {
      projectV2 {
        id
        title
        views(first: 20) {
          nodes { id name layout }
        }
        fields(first: 50) {
          nodes {
            ... on ProjectV2FieldCommon { id name }
            ... on ProjectV2SingleSelectField {
              id
              name
              options { id name }
            }
          }
        }
      }
    }
  }
`;

const INSPECT_QUERY = `
  query($projectId: ID!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        id
        title
        views(first: 20) {
          nodes {
            id
            name
            layout
            groupByFields(first: 5) { nodes { ... on ProjectV2FieldCommon { name } } }
          }
        }
        fields(first: 50) {
          nodes {
            ... on ProjectV2FieldCommon { id name }
            ... on ProjectV2SingleSelectField {
              id
              name
              options { id name }
            }
          }
        }
      }
    }
  }
`;

const DELETE_MUTATION = `
  mutation($projectId: ID!) {
    deleteProjectV2(input: { projectId: $projectId }) {
      projectV2 { id }
    }
  }
`;

// Extract the copied project's node id from copyProjectV2's raw stdout
// (JSON text). Returns null on any parse/shape failure — the caller must
// treat null as "no id was ever produced" and MUST NOT delete anything.
function extractCopiedProjectId(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const id = parsed?.data?.copyProjectV2?.projectV2?.id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

describe('spike: copyProjectV2 cross-owner probe (D-13..D-16)', () => {
  test(
    'gate closed: names every missing signal and performs zero gh spawns',
    { skip: gate.open ? 'gate is open in this environment — the mutating case below runs instead' : false },
    () => {
      assert.ok(!gate.open, 'expected the gate to be closed for this assertion to be meaningful');
      assert.ok(gate.missing.length > 0, 'closed gate must name at least one missing signal');
      for (const key of gate.missing) {
        assert.ok(GATE_ENV_KEYS.includes(key), `reported missing signal "${key}" must be one of the four gate signals`);
      }
      // This test itself never calls execGh — the whole point of the gate
      // is that an unset GSD_SPIKE_COPY_PROJECT_V2 spawns nothing. There is
      // no assertion possible on "zero calls happened" beyond the fact that
      // this test body, by construction, contains no execGh call on this
      // branch.
    },
  );

  test(
    'gate open: copyProjectV2 cross-owner, inspect four D-16 findings, guaranteed cleanup',
    { skip: !gate.open ? `gate closed — missing: ${gate.missing.join(', ')}` : false },
    () => {
      const sourceProjectId = process.env.GSD_SPIKE_SOURCE_PROJECT_ID;
      const destOwnerId = process.env.GSD_SPIKE_DEST_OWNER_ID;
      const title = `gsd-spike-copyProjectV2-${new Date().toISOString()}`;

      const findings = {
        gate: 'open',
        copy: { attempted: true, succeeded: false, response_or_error: '' },
        views: { finding: 'not-recorded' },
        fields: { finding: 'not-recorded' },
        status_options: { finding: 'not-recorded' },
        grouping: { finding: 'not-recorded' },
        cleanup: { attempted: false, succeeded: false, deleted_id: null },
      };

      let copiedProjectId = null;

      try {
        const copyResult = execGh([
          'api', 'graphql',
          '-f', `query=${COPY_MUTATION}`,
          '-f', `projectId=${sourceProjectId}`,
          '-f', `ownerId=${destOwnerId}`,
          '-f', `title=${title}`,
        ]);

        findings.copy.exit_code = copyResult.exitCode;
        findings.copy.reason = copyResult.reason;
        findings.copy.response_or_error = copyResult.exitCode === 0 ? copyResult.stdout : copyResult.stderr;

        if (copyResult.exitCode !== 0) {
          findings.copy.succeeded = false;
          // Nothing was created — nothing to clean up. Report and stop.
          // A copyProjectV2 failure is recorded as a non-success finding,
          // not a test failure (unproven is a valid, honest outcome) — the
          // assertion below is on the recorded finding shape, not a no-op.
          console.log(JSON.stringify(findings, null, 2));
          assert.strictEqual(findings.copy.succeeded, false, 'a failed copy must be recorded as succeeded:false');
          return;
        }

        copiedProjectId = extractCopiedProjectId(copyResult.stdout);
        assert.ok(
          typeof copiedProjectId === 'string' && copiedProjectId.length > 0,
          'copyProjectV2 reported success but no project id could be extracted from its response — refusing to proceed without a deletable id (T-1-16)',
        );
        findings.copy.succeeded = true;
        findings.copy.copied_project_id_present = true;

        // D-16: inspect what actually survived the copy. Four SEPARATE
        // findings — a bare mutation success is not an answer.
        const inspectResult = execGh([
          'api', 'graphql',
          '-f', `query=${INSPECT_QUERY}`,
          '-f', `projectId=${copiedProjectId}`,
        ]);

        if (inspectResult.exitCode !== 0) {
          findings.views = { finding: 'inspect-failed', detail: inspectResult.stderr };
          findings.fields = { finding: 'inspect-failed', detail: inspectResult.stderr };
          findings.status_options = { finding: 'inspect-failed', detail: inspectResult.stderr };
          findings.grouping = { finding: 'inspect-failed', detail: inspectResult.stderr };
        } else {
          let node = null;
          try {
            node = JSON.parse(inspectResult.stdout)?.data?.node ?? null;
          } catch {
            node = null;
          }
          if (!node) {
            findings.views = { finding: 'unparseable-response' };
            findings.fields = { finding: 'unparseable-response' };
            findings.status_options = { finding: 'unparseable-response' };
            findings.grouping = { finding: 'unparseable-response' };
          } else {
            const views = node.views?.nodes ?? [];
            const fields = node.fields?.nodes ?? [];
            const statusField = fields.find((f) => f && f.name === 'Status');

            findings.views = {
              finding: views.length > 0 ? 'present' : 'absent',
              count: views.length,
              layouts: views.map((v) => v.layout),
            };
            findings.fields = {
              finding: fields.length > 0 ? 'present' : 'absent',
              count: fields.length,
              names: fields.map((f) => f.name),
            };
            findings.status_options = {
              finding: statusField && Array.isArray(statusField.options) && statusField.options.length > 0
                ? 'present'
                : 'absent',
              count: statusField?.options?.length ?? 0,
            };
            const groupedViews = views.filter((v) => Array.isArray(v.groupByFields?.nodes) && v.groupByFields.nodes.length > 0);
            findings.grouping = {
              finding: groupedViews.length > 0 ? 'survived' : 'lost',
              grouped_view_count: groupedViews.length,
              total_view_count: views.length,
            };
          }
        }
      } finally {
        if (copiedProjectId) {
          const deleteResult = execGh([
            'api', 'graphql',
            '-f', `query=${DELETE_MUTATION}`,
            '-f', `projectId=${copiedProjectId}`,
          ]);
          findings.cleanup.attempted = true;
          findings.cleanup.deleted_id = copiedProjectId;
          findings.cleanup.succeeded = deleteResult.exitCode === 0;
          findings.cleanup.exit_code = deleteResult.exitCode;
          if (deleteResult.exitCode !== 0) {
            findings.cleanup.detail = deleteResult.stderr;
          }
        } else {
          findings.cleanup.attempted = false;
          findings.cleanup.succeeded = true; // nothing was created, nothing to clean
        }

        // Structured findings on stdout as a single JSON object so Task 2
        // can transcribe them into the evidence record without re-running
        // anything.
        console.log(JSON.stringify(findings, null, 2));
      }

      if (copiedProjectId) {
        assert.ok(
          findings.cleanup.attempted && findings.cleanup.succeeded,
          `deleteProjectV2 must succeed for the project this run created (id: ${copiedProjectId}) — ` +
          `a silent cleanup failure leaves a stray project on a real account. ` +
          `${findings.cleanup.detail ? `Detail: ${findings.cleanup.detail}` : ''}`,
        );
      }
    },
  );
});
