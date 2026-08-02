---
type: Added
pr: 0
---
**`gsd-tools github-sync init` bootstraps and repairs a GitHub Project v2 board from `.planning/` state** — creates or adopts the board, its five typed custom fields, the reconciled `Status` options, the `gsd:phase`/`gsd:plan` labels, and one Milestone per GSD milestone, converging to zero mutations on every re-run. Default-off (`github_sync.enabled`) and never gates the GSD loop.
