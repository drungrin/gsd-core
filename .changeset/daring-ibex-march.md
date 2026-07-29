---
type: Added
pr: 2763
---
github-sync capability shell hardening: an exhaustive test proves the family-entry enablement gate is unbypassable for arbitrary subcommand strings (registered, unregistered including the literal init, empty, and absent), with zero spawns and zero filesystem writes while disabled. A second test proves the command dispatches only through the generic capability registry — gsd-tools.cjs carries no hardcoded case or router require for the family.
<!-- docs-exempt: dispatch and gate guarantees are internal to the unreleased github-sync capability; the capability README lands in Phase 6 (DOC-01) -->
