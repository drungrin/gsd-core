---
type: Fixed
pr: 0
---
`github-sync status` now reports a misconfigured `github_sync.target` as a local configuration fault naming the offending field, instead of output byte-identical to a GitHub outage that advised an impossible retry. The machine object carries a typed `target_unavailable` blocker whose detail is the field name; a genuine unreadable remote still reports `remote_unavailable`.
