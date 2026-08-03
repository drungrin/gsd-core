---
type: Added
pr: 0
---
**`github-sync init` now bootstraps and repairs five GSD-owned views** (Roadmap, Board, Table-by-Phase, By-Wave, Backlog), each converged on `name`/`layout`/`filter` every run, and retypes the layout of whichever view sits leftmost on the board — the tab it opens on by default — through the new `github_sync.view.layout` config key (`board`/`table`/`roadmap`, default `board`). GSD deliberately does not, and cannot, set view grouping, sort order, Insights charts, or view ordering itself: the GraphQL API has no mutation surface for any of the four, a ceiling this release documents rather than works around, alongside the one-time manual setup a developer finishes by hand for the parts GSD cannot reach. See the `github-sync` reference documentation for the full ceiling and the enumerated `.planning/.github-sync.json` reserved-key list.
