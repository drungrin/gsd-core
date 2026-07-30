---
type: Fixed
pr: 2763
---
`github-sync preflight` with no GitHub credentials configured previously reported a transient GitHub outage and pointed at githubstatus.com, because the classifier only recognized an authentication failure by its HTTP error text and `gh` never reaches the API in that state. It now reports the actual cause: a developer is told to run `gh auth login`, and CI is pointed at a classic personal access token exported as `GH_TOKEN`.
