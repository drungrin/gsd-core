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

### API ceiling

`createProjectV2View`/`updateProjectV2View` accept only `(projectId, name, layout, filter)` —
**view grouping, sort order, and visible-fields configuration are not settable through the
GitHub API at all**, and Project v2 **Insights** charts have no mutation surface whatsoever.
`init` does not attempt either. See
[`.planning/phases/03-project-bootstrap/COVERAGE.md`](../../.planning/phases/03-project-bootstrap/COVERAGE.md)
for the full, enumerated record of every GraphQL/REST capability this phase integrated or
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
