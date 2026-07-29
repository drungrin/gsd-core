---
type: Fixed
pr: 2763
---
github-sync now exits 0 and degrades with an actionable message even if resolving the capability's enabled state or running the auth preflight throws, so a fault inside github-sync can never gate the GSD loop; the disabled-path no-op is now proven under concurrent and interrupted invocation rather than inferred.
