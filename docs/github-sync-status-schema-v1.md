# GitHub Sync Status JSON Schema v1

`gsd-tools github-sync status --json` emits a compact JSON object with `version: 1`.
The DTO is safe for automation: it contains only logical operation keys and fixed reason codes,
never GitHub transport output, credentials, or remote payloads.

| Field | Meaning |
| --- | --- |
| `version` | Schema version, always `1`. |
| `available` | Whether a complete remote snapshot was available. |
| `creates` | Ordered logical keys for planned creates. |
| `updates` | Ordered logical keys for planned updates. |
| `noops` | Ordered logical keys already reconciled. |
| `blocked` | Typed local/map blockers, optionally with a safe `detail`. |
| `uncertain` | Typed operation or remote uncertainties. |
| `limitations` | Fixed, actionable limitations that apply to this report. |
| `message` | Present only for unavailable status; a fixed operator-facing remediation. |

Grouping is by operation outcome: `creates`, `updates`, and `noops` contain only logical keys;
`blocked` and `uncertain` preserve only typed reasons. An unavailable remote response sets
`available` to `false`, returns empty normal groups, reports `remote_unavailable` under
`uncertain`, and exits successfully. Status is read-only and never applies a mutation or writes
the sync map.
