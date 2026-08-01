---
type: Fixed
pr: 0
---
`github-sync` no longer passes the configured `owner` and `repo` through `gh api`'s typed `-F` flag. `-F` performs magic value substitution before the request is built — a value beginning with `@` is read from a local file and `{owner}`/`{repo}`/`{branch}` are expanded from the local git repo — so a `.planning/config.json` carrying `owner: "@/path/to/secret"` would have made `gh` read that file and transmit its contents to GitHub. Both values now use the raw `-f` flag; numeric variables keep `-F` because they require Int typing and are validated positive integers.
