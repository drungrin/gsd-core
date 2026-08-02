---
type: Fixed
pr: 0
---
**`github-sync status`/`sync` no longer fail with `remote_unavailable`/`uncertain` on a bootstrapped target** — `collectIssueNodeIdHints` was feeding bootstrap completions' generic remote-number slot (project number, milestone number) into the issue-number lookup as if they were real issue numbers, so GitHub's NOT_FOUND response for those numbers cascaded into a full remote-unavailable failure on every call once `init` had bootstrapped a target. Hint collection is now scoped to issue-bearing logical keys only (`issue:phase:<id>` and the legacy `phase:<id>`).
