---
type: Fixed
pr: 2763
---
**`/gsd:sync-github preflight`'s published reason catalog now matches what preflight can actually emit** -- the command doc and its generated skill previously documented a `preflight_failed` reason value the implementation never returns, so an agent branching on it would match nothing on a real auth failure (e.g. `wrong_scope`). Both surfaces now list the five real values (`no_token`, `wrong_scope`, `outage`, `rate_limited`, `sso_or_null_payload`) alongside the already-correct `ok`/`missing_gh`, and instruct the agent to display the `message` field verbatim rather than branch on `reason` text.
