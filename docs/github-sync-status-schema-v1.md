# GitHub Sync Status Output v1

`gsd-tools github-sync status` has two output surfaces. **This is the default** — running
`status` with no flags prints the human summary below. `--raw` is a separate, versioned
machine surface documented in the second section; `--json` is accepted as a synonym but does
not change behavior. The two surfaces never mix: the human summary is for a developer reading
a terminal, and `--raw` is for automation.

## Default output: the human summary (D-13)

Running `status` with no flags prints a heading, then seven group lines in this fixed order —
`creates:`, `updates:`, `no-ops:`, `blocked:`, `uncertain:`, `orphans:`, `updates-pending:` —
each showing its count. Every group always appears, even at zero (D-14). When a group is
non-empty, each member follows on its own indented line: `creates`, `updates`, and `no-ops` list
logical keys verbatim; `blocked` lists its typed reason, with a safe `detail` appended in
parentheses when present; `uncertain` lists its typed reason; `orphans` lists a phase's logical
key, with its issue number appended in parentheses when known (plan 04-04, D-11);
`updates-pending` lists a pending issue-content update's logical key (plan 04-04). If the report
carries any `limitations`, a final `limitations:` line lists each one, indented; the line is
omitted entirely when there are none. This is the surface SYNC-07 promises: every planned
create, update, no-op, orphan, and pending update is named, and every blocked or uncertain entry
is named by its typed reason — actionable without reading source or JSON.

When the remote snapshot is unavailable, the default output is instead the DTO's fixed
operator-facing `message` (see below), and the command still exits successfully (D-16).

## `--raw`: the compact JSON v1 schema (D-15)

`gsd-tools github-sync status --raw` (or `--json`, unchanged behavior) emits a compact JSON
object with `version: 1`. The DTO is safe for automation: it contains only logical operation
keys and fixed reason codes, never GitHub transport output, credentials, or remote payloads.
This is a published, versioned, one-way contract — it is byte-unchanged by the default output
described above.

| Field | Meaning |
| --- | --- |
| `version` | Schema version, always `1`. |
| `available` | Whether a complete remote snapshot was available. |
| `creates` | Ordered logical keys for planned creates. |
| `updates` | Ordered logical keys for planned updates. |
| `noops` | Ordered logical keys already reconciled. |
| `blocked` | Typed local/map blockers, optionally with a safe `detail`. |
| `uncertain` | Typed operation or remote uncertainties. |
| `orphans` | Logical keys of phases whose completions exist but are absent from the desired state, each optionally paired with its known issue number (plan 04-04, D-11). Never acted on — report-only. |
| `pendingIssueUpdates` | Ordered logical keys of phases whose issue content (title/body/milestone) would be updated in place (plan 04-04). `status` names these without reading the issue body. |
| `limitations` | Fixed, actionable limitations that apply to this report. |
| `message` | Present only for unavailable status; a fixed operator-facing remediation. |

Grouping is by operation outcome: `creates`, `updates`, and `noops` contain only logical keys;
`blocked` and `uncertain` preserve only typed reasons. Status is read-only and never applies a
mutation or writes the sync map.

## Unavailable status: two distinct reason codes (G-02-4)

An unavailable status report (`available: false`) always has an outcome-specific `message`, but
that `message` is selected from a fixed catalog keyed by fault class — never assembled from a
config value or a caught error (D-07/SAFE-04) — and the two fault classes are reported through
different DTO shapes so a local configuration fault can never read as a GitHub outage:

- **`remote_unavailable`** (genuinely unreadable remote): `uncertain` carries
  `[{ reason: 'remote_unavailable' }]`, `blocked` is empty, and `message` is the fixed retry
  remediation ("Retry shortly.") — appropriate because a transient remote failure can resolve on
  its own.
- **`target_unavailable`** (a local `github_sync.target` configuration fault): `blocked` carries
  `[{ reason: 'target_unavailable', detail }]`, where `detail` is one of the six values in the
  closed `SYNC_TARGET_FIELD` catalog (`config`, `target`, `owner`, `repo`, `repository_number`,
  `project_number`) naming the field readSyncTarget's own validation rejected — `uncertain` is
  empty, because retrying a fixed local config value can never help. `message` names the
  offending field with its full dotted path (e.g. `github_sync.target.repository_number`) and a
  concrete remedy, drawn from the same frozen catalog. **A local target fault therefore reports
  no `uncertain` entry** — automation keying on `uncertain` alone to detect "something's wrong"
  will see an empty list for this fault class and must also check `blocked`.

Both classes exit successfully (D-16) and make no remote read or write.
