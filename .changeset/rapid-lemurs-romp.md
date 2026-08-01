---
type: Fixed
pr: 0
---
`github-sync status` now prints its human summary by default — the renderer was unreachable because the router passed it through an output path that only consumes a rendered string under `--raw`, so every invocation emitted JSON. `--raw` still emits the unchanged compact v1 object, and the summary now lists the planned creates, updates, no-ops, blockers, and uncertainties by name.
