---
type: Fixed
pr: 0
---
**A single GSD view that cannot resolve a visible field no longer discards the whole `init` options pass.** Previously, the moment one of the five GSD views (most commonly By-Wave, on the very first run before its fields have finished creating) could not resolve a declared field against the remote snapshot, `github-sync init` silently applied none of the options pass: not the `Status` option merge, not the `Autonomous` option merge, and not the other views that had already resolved cleanly and were ready to create. Now the other four views, the Status option merge, and the Autonomous option merge are all applied normally, and the skipped view is named — along with the field it needs — in the run's `views` report line, in both the human and `--raw` output. A genuinely run-fatal condition (a field that already exists with the wrong data type, or no `Status` field at all) still suppresses the entire pass, unchanged.
