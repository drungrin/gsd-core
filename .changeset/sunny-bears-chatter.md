---
type: Fixed
pr: 5407
---
**Git-source capability installs stay trackable in project repositories** — omit the temporary clone’s `.git` metadata while preserving checkout files, validation, and consent hashing. The next Git install or upgrade changes the content hash once; existing installs are not rewritten.
