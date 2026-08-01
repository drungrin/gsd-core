---
type: Fixed
pr: 0
---
`github-sync` now reads Project v2 fields with a schema-valid GraphQL document — the previous selection on the `ProjectV2FieldConfiguration` union was rejected live with `selectionMismatch`, so every remote read aborted and `status` always reported the remote as unreadable. Recorded fixtures are now contract-checked against the documents that produce them.
