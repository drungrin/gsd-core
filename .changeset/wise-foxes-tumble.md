---
type: Fixed
pr: 0
---
**GitHub-sync bootstrap now persists the resolved repository number** — a bootstrap run that recovers the repository identity from a partial config or the local sync map now persists the resolved value instead of re-serializing a stale one already on disk, so `status` and `sync` stop reporting `target_unavailable` after a successful `init`. (The `gh repo view` recovery path is still blocked by a separate, tracked `gh` 2.96.0 compatibility gap — see `.planning/phases/03-project-bootstrap/deferred-items.md`.)
