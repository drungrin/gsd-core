# Roadmap: Recorded Fixture Project

Frozen input for `tests/github-sync-desired.test.cjs` (WINDOWS #6 / D-18). This
file is authored independently of this repository's own `.planning/ROADMAP.md`
and never mirrors it — copying it into `.planning/` would recreate the exact
self-reference D-18 removes. Do not edit its phase count, checklist state, or
`current_phase` correspondence in `STATE.md` without updating the test
assertions in `tests/github-sync-desired.test.cjs` that were recorded against
this exact content.

- [x] **Phase 01: One** - complete
- [ ] **Phase 02: Two** - in progress
- [ ] **Phase 03: Three** - not started
- [ ] **Phase 04: Four** - not started

### Phase 01: One

**Goal**: exercise the Done branch (checklist entry checked)

### Phase 02: Two

**Goal**: exercise the In Progress branch (unchecked, equals STATE.md's current_phase)

### Phase 03: Three

**Goal**: exercise the Todo branch (unchecked, not the current phase)

### Phase 04: Four

**Goal**: exercise the Todo branch a second time (unchecked, not the current phase)
