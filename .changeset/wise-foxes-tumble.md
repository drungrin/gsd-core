---
type: Fixed
pr: 0
---
**GitHub-sync bootstrap now persists the resolved repository number** — a bootstrap run that resolves the repository number from `gh repo view` now persists that resolved value instead of re-serializing a stale one already on disk, so `status` and `sync` stop reporting `target_unavailable` after a successful `init`.
