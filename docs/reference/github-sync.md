# `gsd-tools github-sync` Command Reference

> **CLI form:** `gsd-tools github-sync <subcommand>`
> **Capability manifest:** [`capabilities/github-sync/capability.json`](../../capabilities/github-sync/capability.json)
> **See also:** [`docs/COMMANDS.md`](../COMMANDS.md) · [`docs/FEATURES.md`](../FEATURES.md) · [`.planning/PROJECT.md`](../../.planning/PROJECT.md)'s Constraints section for the design boundaries this command honors

`github-sync` mirrors `.planning/` phase and plan state into a GitHub Project v2 board,
one-way — disk to GitHub, never the reverse. It is a default-off capability
(`github_sync.enabled: false`); with it off, every subcommand — including `init` — is a silent
no-op and never blocks the GSD loop.

**Implemented:** `preflight`, `status`, `sync`, `init`.

---

## `init`

**Synopsis**

```
gsd-tools github-sync init [--raw]
```

`init` is a **repair** command, not a one-shot bootstrap. Running it once against an empty
repository builds the board; running it again against the same target — or against a board
someone else built by hand — converges to zero mutations rather than duplicating anything.

### What `init` creates

On a target with no Project v2 board yet, `init` creates, in order:

1. **The Project v2 board itself**, owned by the repository's owner (not the authenticated
   viewer — an organization-owned repository is created under the organization). Titled from
   `github_sync.project_title` when set, otherwise `<repo> Roadmap`.
2. **The repository link** (`linkProjectV2ToRepository`), as its own independently-retryable
   operation — a board can exist without being linked, and a failed link retries on the next run
   without recreating the board.
3. **Five custom fields**, typed to match what they hold:

   | Field | Type | Why |
   |---|---|---|
   | `GSD ID` | Text | Opaque identifier, never numeric-coerced |
   | `Phase` | Text | A decimal phase id (e.g. `2.1`) round-trips exactly; a Number field would coerce or reject it |
   | `Requirements` | Text | A comma-joined requirement-id list |
   | `Wave` | Number | Sorts and filters numerically in a By-Wave view |
   | `Autonomous` | Single select (`Yes`/`No`) | Filterable |

4. **The reconciled `Status` options**, in enforced order — `Todo`, `In Progress`, `Blocked`,
   `Done`, `Deferred` — merged into the board's *built-in* `Status` field (never a custom
   `Status GSD` field: board layouts bind to the built-in field). Every existing option on the
   field — a GSD option or a developer's own custom one — is echoed back by its own id and kept;
   only the missing GSD options are appended. An option is never renamed, recolored, or removed
   after it exists.
5. **The two repository labels** `gsd:phase` and `gsd:plan`.
6. **One GitHub Milestone per GSD milestone** — the current milestone open, each archived
   milestone created already closed.
7. **The five GSD-owned views** — Roadmap, Board, Table-by-Phase, By-Wave, Backlog — created on
   an empty board and repaired on every subsequent run. See [The five views](#the-five-views)
   below.
8. **A layout retype on the project's pre-existing leftmost view** — the tab the board opens on
   by default. See [The five views](#the-five-views) below.

### The five views

Every run of `init` creates or repairs five views, read from the shipped `GSD_VIEWS` table:

| View | Layout | Filter | Visible fields beyond Title |
|---|---|---|---|
| Roadmap | Roadmap | *(none)* | *(none)* |
| Board | Board | *(none)* | *(none)* |
| Table-by-Phase | Table | `label:gsd:phase` | Phase, Status |
| By-Wave | Table | `label:gsd:plan` | Wave, Phase, Status |
| Backlog | Table | `-status:Done` | Status |

GSD owns `name`, `layout`, and `filter` on these five absolutely. A developer who re-filters or
re-types one by hand sees it converged back on the next `init` — these views are derived state,
not authored content. The consequence: **grouping is the one view property GSD cannot set** (see
[API ceiling](#api-ceiling) below), so it is the only one a developer's customization survives on.

The Roadmap view exists and is a real view, but a developer should not expect a populated
timeline: the Roadmap layout is a date-bound visualization, and none of GSD's fields is a date
field — GSD has no deadline concept to mirror.

Separately, `init` retypes the layout of whichever view happens to sit **leftmost** on the
board — the tab a developer sees first, since the API has no other way to express "default view"
(see [API ceiling](#api-ceiling)). This is governed by
[`github_sync.view.layout`](#configuration) (default `board`) and is the only one of the eight
behaviors above that touches a view GSD did not itself create.

### Manual setup in the GitHub UI

GSD does not and cannot know whether any of the following were done — nothing on disk and
nothing on the board records it. What follows describes a finished setup, not a checklist GSD
tracks or ever will.

- **Group the Table-by-Phase view by Milestone.** `groupByFields` is a read-only connection on
  `ProjectV2View`; no input on `createProjectV2View` or `updateProjectV2View` reaches it, so this
  grouping has to be set once, by hand, and it is the one view property that survives every
  future `init`.
- **Milestone swimlanes on the Board view.** `verticalGroupByFields` is read-only for the same
  reason as `groupByFields` above — no mutation input on either view mutation writes to it.
- **Any Insights chart.** Project v2 Insights has no mutation surface on `Mutation` at all; there
  is nothing an API client, including `init`, could ever call to create one.
- **Making a chosen view the one the board opens on.** There is no view-reordering mutation and
  no `isDefault` field on `ProjectV2View`, so "default view" means whichever view sits leftmost.
  `init` retypes that view's layout (governed by [`github_sync.view.layout`](#configuration)) but
  can never move a view into that position.

### What `init` records without creating

Every one of the objects above may already exist — a board built by hand, a pre-existing
`Status` field, a label a developer created before ever running `init`. In every such case,
`init` **adopts and records** the object's GitHub node id into the local sync map
(`.planning/.github-sync.json`) rather than doing nothing. This is why running `init` against an
already-bootstrapped board is useful, not a no-op: it is how the local map catches up to a
GitHub-side reality it never wrote itself. A first run against a fully populated board with an
absent map dispatches **zero** mutations and still leaves every reserved key recorded.

### What `init` deliberately does not do

- **Never renames an adopted board.** A board's title, once created (by `init` or by hand), is
  never rewritten to match a later `github_sync.project_title` change.
- **Never deletes or retypes a field.** A field GSD needs that already exists with the wrong
  data type blocks the entire run with a named error rather than being deleted and recreated —
  deleting it would destroy every value already stored in it.
- **Never edits an existing label or milestone.** A label or milestone GSD finds already present
  is adopted verbatim; its color, description, or state is never rewritten.
- **Never renames a label whose spelling differs only by case.** A repository-existing label
  matching a GSD label under ASCII case folding (e.g. `GSD:Phase` vs `gsd:phase`) is adopted
  under GSD's own reserved key, not renamed and not duplicated.
- **Never sets a due date.** GSD has no deadline concept for a milestone; inventing one would be
  fiction.
- **Never writes back to any planning artifact other than the single project-number scalar** —
  see [Configuration](#configuration) below. `github-sync` is one-way, disk to GitHub; this is
  the one narrowly-scoped exception, and it exists only so a developer's next `status`/`sync`
  needs no manual step after a fresh `init` create.
- **Never deletes a view.** `deleteProjectV2View` appears nowhere in the codebase; a view whose
  recorded id no longer resolves is recreated, not reconciled against an absence record, because
  a view carries no body, no comments, no history, and no sub-issue relations.
- **Never renames the adopted leftmost view, and never writes anything on it but `layout`.**
- **Never attempts a grouping or sort write.** Those connections are read-only, so a best-effort
  attempt would fail on every run for every view.

### API ceiling

`createProjectV2View` and `updateProjectV2View` do not share one input shape.
`CreateProjectV2ViewInput` carries `projectId`, `name`, and `layout` (all required), plus an
optional `configuration` — **no `filter` field exists on it at all**. `filter` exists only on
`UpdateProjectV2ViewInput`, alongside `viewId` (required) and optional `name`/`layout`/
`configuration`. `init` never sends a filter at create time; a view that needs one gets it from a
following `updateProjectV2View` call carrying the view's own id.

`configuration` is `ProjectV2ViewConfigurationInput`, which carries exactly one field:
`visibleFieldIds: [ID!]`. This *is* settable — `init` sets it on the three views
(Table-by-Phase, By-Wave, Backlog; see [The five views](#the-five-views) above) that declare
visible fields beyond the implicit `Title` column.

What remains genuinely outside the API's reach: `groupByFields` and `verticalGroupByFields` are
read-only connections on `ProjectV2View` with no write path anywhere in the schema — no input on
either `createProjectV2View` or `updateProjectV2View` reaches them. Neither mutation carries a
sort input either. Project v2 **Insights** charts have no mutation surface on `Mutation` at all.
And there is no view-reordering mutation and no `isDefault` field on `ProjectV2View` — a board's
"default view" is simply whichever view sits leftmost, and the API can retype that view (see
[The five views](#the-five-views) above) but never move it. See
[Manual setup in the GitHub UI](#manual-setup-in-the-github-ui) above for the finished end-state
this ceiling leaves to a developer, and
[`.planning/phases/03-project-bootstrap/COVERAGE.md`](../../.planning/phases/03-project-bootstrap/COVERAGE.md)
and
[`.planning/phases/06-views-capability-documentation/COVERAGE.md`](../../.planning/phases/06-views-capability-documentation/COVERAGE.md)
for the full, enumerated record of every GraphQL/REST capability this project integrated or
deliberately opted out of, with a reason for each opt-out.

### Output

`init` renders a human-readable report by default and a machine-readable one under `--raw`. Both
forms come from the same DTO, built from the run's own outcome journal — never from what was
merely planned — so the report distinguishes what was **created** from what was **adopted**,
**updated**, **linked**, left **unchanged**, or **skipped** (a create rejected as already
existing by a concurrent run). A run that created nothing and adopted an existing board reads as
an adoption, never as an empty bootstrap.

Every failure mode — a missing `gh` binary, no token, missing `project` scope, a GitHub rate
limit or outage, a blocked plan, a failed mutation, an uncertain checkpoint — is named with its
remediation, and the process exit code stays `0` in every case (`onError: skip`): `init` never
gates the GSD loop.

---

## `status`

**Synopsis**

```
gsd-tools github-sync status [--raw]
```

Read-only. Reports what a `sync` run would create, update, or leave unchanged, without writing
anything.

## `sync`

**Synopsis**

```
gsd-tools github-sync sync [--raw]
```

Reconciles phase and plan state into GitHub Issues linked to the Project board, following the
same one-way, checkpointed-apply discipline `init` uses for the board's own structure.

## Phase Issues

`sync` mirrors every `.planning/ROADMAP.md` phase into a repository Issue: created if none is
mapped yet, updated in place on every later `sync` if its content has drifted, and never
duplicated. Each phase issue carries the `gsd:phase` label, is assigned to its GSD milestone, and
is added to the Project board as an item.

### Identity marker

The first line of a phase issue's body is an identity marker:

```
<!-- gsd:phase id="04" -->
```

This is the issue's identity, independent of the generated region below it. It is what a future
repair path (not shipped by this capability today) would use to re-find an issue if the local
sync map were ever lost — which is why it is a *separate* token from the fence pair that follows,
rather than combined into one delimiter: a developer who damages or removes the generated region
still leaves an issue whose identity is intact and repairable.

### The fenced region

Everything GSD generates and rewrites lives between two literal fence tokens:

```
<!-- gsd:begin -->
<!-- gsd:end -->
```

**The contract, in one sentence: everything between the fences is regenerated on every `sync`;
everything outside them — above the begin fence, below the end fence — is preserved
byte-for-byte and keeps its exact position.** A developer can write anything they like around a
phase issue's generated region — a note, a link, a follow-up comment — and it survives every
future `sync`.

**The one edit that does *not* survive is an edit made *inside* the fences.** If a developer
edits the goal, the success-criteria list, or the requirement IDs directly on GitHub, that edit
is silently overwritten the next time `sync` runs and the phase's content has changed on
`ROADMAP.md`'s side (the content hash no longer matches, so the whole region is rewritten from
disk). **GSD cannot detect that this happened** — the stored content hash tracks GSD's own
intent, not a live diff against the remote body, so a hand-edited region reads as "unchanged"
right up until the roadmap moves and the region is regenerated out from under it. This is a
recorded tradeoff, not an oversight: a developer is entitled to know it before their first `sync`,
not discover it after their first loss. **Treat the region as read-only** — write commentary
outside the fences instead.

### What the region carries

Inside the fences: the phase's goal under a `## Goal` heading, its success criteria as a plain
numbered list under `## Success Criteria`, and its requirement IDs as plain comma-separated text
under `## Requirements` — followed by a provenance line naming `.planning/ROADMAP.md` and the
phase's own section, so a reader arriving from a GitHub notification understands the issue is a
projection before they consider editing it. No markdown checkbox appears anywhere in the region:
a one-way mirror must never invite an edit it will silently discard.

### Damaged regions

If a phase issue's body has no fence pair at all, `sync` treats it as unambiguous drift-free
recovery and appends a fresh region to the end of the body, leaving every existing line verbatim
— nothing generated was ever at risk, so this case self-heals with no report.

If the fence pair is unbalanced, duplicated, or inverted (an end fence appearing before its
begin fence), `sync` refuses to guess: it writes nothing to that issue and names it in the run's
report as needing manual repair. **The repair a developer performs:** open the issue on GitHub
and hand-edit the body so exactly one `<!-- gsd:begin -->` and one `<!-- gsd:end -->` appear, in
that order — the next `sync` then converges it normally.

### Board fields

`sync` writes four item fields on the Project board: the built-in `GSD ID` (the phase's own
logical key, e.g. `phase:04`), `Phase` (the phase id exactly as it appears on disk), and
`Requirements` (the comma-joined requirement-id list) as plain text, plus the built-in `Status`
single-select — derived from `.planning/ROADMAP.md`'s checklist together with `STATE.md`'s
current phase, never from a hand-edited board value. `Wave` and `Autonomous` are deliberately
left empty by this capability: both are plan-level facts, populated once plan sub-issues sync.

**Issue open/closed state is never touched by phase-issue sync.** Completing a phase does not
close its issue — that would be a second, weaker state machine driven by a hand-edited roadmap
checkbox, and Phase 6 is expected to revisit whether plan sub-issues justify it.

### What is deliberately never done

Phase-issue sync never closes, reopens, deletes, comments on, or relabels an issue it manages.
A phase removed from `ROADMAP.md` — or renumbered, which orphans its old id — has its issue and
map entry left exactly in place: `status` and `sync` report it as an orphaned phase issue by
number, and nothing more. Nothing GSD did not create is ever destroyed.

### Scope requirement

Creating and updating phase issues writes to Projects v2, the same as every other mutation in
this capability, and needs the `project` OAuth scope:

```
gh auth refresh -s project
```

See [The `project` scope](#the-project-scope) under `preflight` below for the CI/token
alternative.

---

## Plan Sub-Issues

`sync` mirrors every `<NN>-<PP>-PLAN.md` into a repository Issue too — one per plan, attached to
its phase issue through GitHub's own **sub-issue** relation (`addSubIssue`), not a link or a list
of checkboxes in the phase issue's body. Opening a phase issue on GitHub shows a native
**Sub-issues** section listing its plans with their own progress bar; this is GitHub's own
hierarchy feature, the same one a developer would get building the tree by hand.

### Identity marker and fenced region

A plan sub-issue's first line is its own identity marker, parallel to the phase marker above but
in the plan namespace:

```
<!-- gsd:plan id="05-08" -->
```

Everything GSD generates lives inside the same two fence tokens phase issues use —
`<!-- gsd:begin -->` / `<!-- gsd:end -->` — with the identical contract: text outside the fences
survives byte-for-byte across every future `sync`, in its exact position. **An edit made inside
the fenced region is lost on the next content-changing sync, and GSD cannot detect that it
happened** — the same tradeoff [phase issues](#the-fenced-region) carry, extended to plans without
exception. Treat the region as read-only; write commentary outside the fences instead.

### The five custom fields

A plan item carries the same five custom fields `init` creates, populated from the plan's own
PLAN.md frontmatter (read through the capability's own `readPlans()`/`parsePlanMetadata()`
projection — see [Standing exposure](#standing-exposure-two-frontmatter-parsers) below):

| Field | Source |
|---|---|
| `GSD ID` | The plan's logical key, e.g. `plan:05-08` |
| `Phase` | The owning phase id |
| `Requirements` | The plan's comma-joined requirement-id list |
| `Wave` | The plan's `wave:` frontmatter value, written as a real `NUMBER` field value |
| `Autonomous` | `Yes`/`No`, from the plan's `autonomous:` frontmatter value |

Dependencies are **not** a sixth field — Phase 3 created exactly five custom fields and none of
them holds a dependency list. Instead, a plan's `depends_on` entries render as a `## Depends On`
line inside the fenced region, one native GitHub cross-issue reference per dependency (e.g. `#83`)
that GitHub itself auto-links to the right plan sub-issue.

**Same-run resolution requires the dependency to sort earlier.** Plans are processed in ascending
`localeCompare` id order. A dependency on a plan that sorts *earlier* (e.g. `04-02` depending on
`04-01`) resolves in the same `sync` run — either from a prior run's completion or from the
create operation this run already pushed for it. A dependency on a plan that sorts *later* (e.g.
`04-01` depending on `04-05`, or a forward/cross-phase reference such as a phase-N plan depending
on a phase-(N+1) plan) cannot resolve same-run: the dependent plan is reported as blocked with a
`DEPENDENCY_SLOT_MISMATCH` entry for that run, and converges automatically on the next run once
the dependency's own completion exists. This is self-healing — nothing is corrupted or lost — but
it means a genuinely forward-pointing `depends_on` costs one extra `sync` run before it converges.
Unlike a plan's implicit dependency on its own parent phase (which is guaranteed to resolve
same-run because the phase loop always completes before the plan loop starts), a plan-to-plan
dependency has no such guarantee once the dependency id sorts after the dependent's own id.

### Status: closed/Done, open/Todo, open/In Progress — and who owns it

A plan's `Status` is derived from disk truth, never read back from the board:

- A plan with a sibling `<NN>-<PP>-SUMMARY.md` is **closed**, with Status `Done` — regardless of
  its position relative to `STATE.md`'s current plan.
- The plan named by `STATE.md`'s current position (and not yet complete) is **open**, with Status
  `In Progress`.
- Every other incomplete plan is **open**, with Status `Todo`.

**`Status` is owned by GSD.** A value set by hand on the board — including `Blocked` or
`Deferred` — is reverted to the disk-derived value on the next sync; this is deliberate, not a
bug, so a developer who hand-sets a plan to `Blocked` should expect to see it revert.

**A plan already complete on its first sync (WR-02, 05-REVIEW re-review).** GitHub's REST
issue-create endpoint has no `state` parameter, so a freshly created plan issue is always open
regardless of `plan.complete`. If a plan's `SUMMARY.md` already exists the first time `sync`
creates its issue, the issue is created open even though its `Status` field is written as `Done`
in the same run — a real, visible mismatch for exactly one run if a developer looks at the issue
list right after that first sync. It is cosmetic and self-heals on the very next `sync`, which
detects the open/closed state has not converged and dispatches the closing PATCH.

**A plan issue closes when its SUMMARY.md appears and reopens when it disappears.** Deleting a
SUMMARY.md by accident reopens its plan's issue on the next sync — that is the mirror working
correctly, not a defect to guard against.

### Task rendering

Inside the fenced region, under a `## Tasks` heading, each task from the plan's `<tasks>` renders
as one line — a status glyph, a single space, then the task name verbatim — never as a markdown
checkbox:

```
✓ Done · ▶ In Progress · ○ Todo
✓ Task 1: The live run — backfill, sync, measure, re-sync to zero
✓ Task 2: Confirm on the real board what the offline tests can only assert
▶ Task 3: Document the plan sub-issue contract, ship a changeset, and flip nine requirements
```

The glyph is a **plan-level rollup**, not per-task: every task line takes the same glyph, driven
by the plan's own derived `Status` — a task list has no independent completion state on disk to
render otherwise. This is deliberately non-interactive: a one-way mirror that rendered a real
checkbox would silently discard a developer's own hand-checked box on the next sync, so GSD never
gives them one to check. The rendering itself — glyph selection and line assembly from plan status
and task names alone — is a pure function with no network dependency, unit-tested directly against
its input/output pairs.

### Orphaned plan sub-issues

A plan sub-issue left behind by a deleted or renumbered PLAN.md — one whose `plan:<id>` no longer
matches anything on disk — is **reported by name in the run's output and never closed, unlinked,
commented on, or deleted.** It still counts against the 100-sub-issues-per-parent ceiling below
until a developer removes it by hand.

### The sub-issue ceiling

GitHub caps a parent issue at **100 sub-issues**. `status` and `sync` both warn once a phase
reaches **90** sub-issues under its own phase issue, naming the phase, the parent issue number,
the count, and the limit — a ten-plan runway before the ceiling, not a refusal. **The warning
never blocks a dispatch**; nothing about it changes what `sync` does. Past 100 the `addSubIssue`
create for the 101st plan simply fails and surfaces as an ordinary failed-sync outcome, the same
as any other rejected mutation. A developer approaching the warning has one practical remedy:
split the phase so fewer plans share one phase issue — there is no other lever, since GitHub
enforces the ceiling server-side and this capability has no override for it.

### `wave:` removed from frontmatter

Clearing a plan's `wave:` frontmatter key leaves the board's `Wave` cell at its **previous**
value — it is not blanked. Clearing a `NUMBER` field to empty needs a GraphQL mutation this
capability does not call; a plan that no longer declares a wave keeps showing its last-synced one
until the field is set to a new number. `status` still names the plan under its own
`field-changes-pending` group (CR-02, 05-REVIEW re-review), so this pending, un-appliable change
is visible even though no `Wave` field write is ever dispatched for it.

### Before your first plan sync

Two operational facts a developer needs before running `sync` against plan sub-issues for the
first time:

1. **A board bootstrapped before this release needs one `init` re-run** to backfill the
   `Autonomous` single-select option completions its sync map is missing — without it, the first
   plan sync's `Autonomous` field write reports `field_unresolved` rather than writing `Yes`/`No`.
   Re-running `init` against an already-bootstrapped board is safe and dispatches zero mutations
   for everything it already has; it only fills in the missing option completions.
2. **A first `sync` on an established repository dispatches three content-creating mutations per
   plan** (issue create, `addSubIssue`, add-to-project) against GitHub's 80-per-minute secondary
   rate ceiling, so a repository with dozens of plans **takes minutes**, prints nothing while it
   runs, and is **safe to kill at any point** — every individual mutation is checkpointed to the
   local sync map as it completes, so a killed run resumes from exactly where it stopped rather
   than duplicating anything already created.

### Standing exposure: two frontmatter parsers

This repository now parses `<NN>-<PP>-PLAN.md` frontmatter in two independent places —
`src/phase.cts`'s `cmdPhasePlanIndex` and this capability's own `parsePlanMetadata` — and no guard
prevents the two from drifting apart. This is an accepted exposure, not an oversight: Phase 3
established that `gsd-tools phase list-plans` returns file paths only (no wave, no dependencies,
no requirements), so it cannot satisfy what plan sub-issue sync needs, and the capability reads
its own projection instead.

---

## `preflight`

**Synopsis**

```
gsd-tools github-sync preflight
```

Probes whether the configured `gh` credentials can reach GitHub Projects v2 at all, without
mutating anything. Every other subcommand runs this same check internally before doing any work.

### The `project` scope

Every GraphQL mutation `init` and `sync` issue targets Projects v2, which requires the `project`
OAuth scope — a scope `gh`'s default login does not request. If a preflight or an `init`/`sync`
run reports a missing scope, refresh it:

```
gh auth refresh -s project
```

In CI, or wherever no interactive `gh auth` session exists, export a classic personal access
token carrying the `project` scope as `GH_TOKEN`; the default `GITHUB_TOKEN` Actions provides
cannot reach Projects v2 under any permissions configuration.

---

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `github_sync.enabled` | boolean | `false` | Activation key. Every subcommand is a silent no-op while `false`. |
| `github_sync.target.owner` | string | `""` | GitHub repository owner. |
| `github_sync.target.repo` | string | `""` | GitHub repository name. |
| `github_sync.target.repository_number` | number | `0` | The repository's numeric database id. |
| `github_sync.target.project_number` | number | `0` | The target Project v2's number. **Written by `init`** the first time it creates or recovers a board, if it was not already configured — the one exception to this capability's one-way direction (see [What `init` deliberately does not do](#what-init-deliberately-does-not-do)). |
| `github_sync.project_title` | string | `""` | Title used when `init` creates a board. Empty means `<repo> Roadmap`. |

## `.planning/.github-sync.json`

The local checkpoint map every mutating subcommand reads and writes. It is committed —
repository-scoped GitHub node ids only, **never a token** — and its format is a **stability
surface across capability upgrades**: a future version of `github-sync` may add new reserved
logical keys, but it will not change the meaning of an existing one, so an installed map keeps
working after `gsd-core` is updated.
