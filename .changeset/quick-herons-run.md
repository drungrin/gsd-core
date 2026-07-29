---
type: Fixed
pr: 2763
---
Registered the `gsd-sync-github` skill (shipped in plan 01-04) in the surfaces that make it discoverable and routable: the `workspace_state` skill cluster, the `gsd-manage` namespace router, `/gsd:help`'s Repository Integration section, and the consolidation allowlist. The skill and command files themselves were already correct; only their registration in these five downstream surfaces was missing.
