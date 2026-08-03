---
type: Added
pr: 0
---
**`gsd-tools github-sync sync` mirrors every roadmap phase into a repository Issue** — labeled `gsd:phase`, assigned to its GSD milestone, and added to the Project board with `GSD ID`/`Phase`/`Requirements`/`Status` fields filled. A stable `<!-- gsd:phase id="NN" -->` marker identifies each issue independent of the delimited `<!-- gsd:begin -->`/`<!-- gsd:end -->` region GSD regenerates on every sync; text a developer writes outside that region survives byte-for-byte. Issues are never closed, reopened, deleted, commented on, or relabeled — a phase removed from the roadmap is reported as an orphan and left alone.
