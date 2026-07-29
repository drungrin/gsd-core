'use strict';

/**
 * github-sync-collision.test.cjs — CAP-05 non-collision proof.
 *
 * Drives the REAL exported `validateCrossCapability(capMap, centralKeys)` from
 * `capability-validator.cjs` — not a hardcoded string comparison — over the
 * real `capabilities/github-sync/capability.json` manifest plus a synthetic
 * `projects-sync` fixture built from facts recorded during Phase 1 research.
 * See `01-RESEARCH.md` § Common Pitfalls, Pitfall 4: asserting our
 * id/skill/namespace strings differ from `projects-sync`'s proves only that
 * they differ TODAY, not that the loader treats them as non-colliding at
 * runtime — this suite exercises the actual invariant-checking code path.
 *
 * ONE DELIBERATE SUBSTITUTION, documented here rather than hidden: the "same
 * capability id" fail-first control is NOT driven through
 * `validateCrossCapability`. `capMap` is a `Map<string, object>` keyed by
 * capability id — a JS `Map` structurally cannot hold two different manifest
 * values under one key, so two capabilities "sharing an id" can never appear
 * as two entries of the same `capMap` in the first place. And reading the
 * function's source confirms it: every error message it produces keys off the
 * `Map` key (`capId`), never off `cap.id` — there is no comparison of `cap.id`
 * values anywhere in `validateCrossCapability`. Id collision is enforced by a
 * DIFFERENT, real code path: `capability-loader.cjs`'s
 * `loadRegistry({ includeInstalled: true })` overlay scan — this is exactly
 * ADR-1244 D2's "first-party always wins" invariant, the actual mechanism
 * that keeps an already-installed v1 `projects-sync` overlay from being
 * evicted by an id-squatting candidate. The "same id" control below drives
 * THAT real path instead, which is a strictly stronger proof of the CAP-05
 * guarantee than forcing an input `validateCrossCapability` cannot represent.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { validateCrossCapability } = require('../gsd-core/bin/lib/capability-validator.cjs');
const { loadCentralConfigKeys } = require('../scripts/gen-capability-registry.cjs');
const { loadRegistry } = require('../gsd-core/bin/lib/capability-loader.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');

// Required directly (not copied) so this suite tracks the real manifest
// rather than a snapshot of it.
const GITHUB_SYNC_MANIFEST = require('../capabilities/github-sync/capability.json');

const centralKeys = loadCentralConfigKeys();

// ─── Synthetic projects-sync fixture ──────────────────────────────────────
//
// Source: github.com/The-Artificer-of-Ciphers-LLC/projects-sync-capability
// Captured via a direct fetch during Phase 1 research on 2026-07-29 (see
// 01-RESEARCH.md § Requirements Traceability, CAP-05, and § Common Pitfalls,
// Pitfall 4). The real manifest declares id "projects-sync", config keys
// "projects-sync.enabled" / "projects-sync.board" / "projects-sync.project_url",
// and an empty `skills` array.
//
// LIMITATION: this is a PINNED snapshot, not a live fetch. If the external
// capability renames its id, config keys, or ships a skill in a future
// release, this fixture keeps passing while reality changes — the
// registry-wide invariant sweep below (over every REAL first-party
// capability, including github-sync itself) is what stays true regardless of
// what the external capability does. Fields beyond the recorded facts (title,
// version, tier, commands, …) are conforming filler, not researched facts.
function projectsSyncManifest(overrides = {}) {
  return {
    id: 'projects-sync',
    role: 'feature',
    version: '0.1.0',
    title: 'Projects Sync (external — pinned research fixture, not the real file)',
    description: 'Synthetic stand-in for the real external projects-sync-capability manifest.',
    tier: 'standard',
    requires: [],
    engines: { gsd: '>=1.0.0' },
    runtimeCompat: { supported: ['*'], unsupported: [] },
    skills: [],
    agents: [],
    activationKey: 'projects-sync.enabled',
    config: {
      'projects-sync.enabled': { type: 'boolean', default: false, description: 'Enable the projects-sync mirror.' },
      'projects-sync.board': { type: 'string', default: '', description: 'Target board name.' },
      'projects-sync.project_url': { type: 'string', default: '', description: 'Pre-existing Project v2 URL.' },
    },
    commands: [{ family: 'projects-sync', module: 'projects-sync-router.cjs', router: 'routeProjectsSync' }],
    hooks: [],
    steps: [],
    contributions: [],
    gates: [],
    ...overrides,
  };
}

describe('CAP-05 — validateCrossCapability(github-sync, projects-sync fixture)', () => {
  test('clean case: real github-sync manifest + clean synthetic projects-sync manifest -> no errors', () => {
    const capMap = new Map([
      ['github-sync', GITHUB_SYNC_MANIFEST],
      ['projects-sync', projectsSyncManifest()],
    ]);
    const errors = validateCrossCapability(capMap, centralKeys);
    assert.deepEqual(errors, [], 'expected zero cross-capability errors for the clean fixture pair');
  });

  test('fail-first control: same skill stem -> non-empty error array', () => {
    const capMap = new Map([
      ['github-sync', GITHUB_SYNC_MANIFEST],
      ['projects-sync', projectsSyncManifest({ skills: ['sync-github'] })],
    ]);
    const errors = validateCrossCapability(capMap, centralKeys);
    assert.ok(errors.length > 0, 'expected a skill-stem collision error');
    assert.ok(
      errors.some((e) => /skill "sync-github" is owned by both/.test(e)),
      'expected a skill-ownership error message: ' + errors.join('\n'),
    );
  });

  test('fail-first control: same command family -> non-empty error array', () => {
    const capMap = new Map([
      ['github-sync', GITHUB_SYNC_MANIFEST],
      ['projects-sync', projectsSyncManifest({
        commands: [{ family: 'github-sync', module: 'impostor.cjs', router: 'routeImpostor' }],
      })],
    ]);
    const errors = validateCrossCapability(capMap, centralKeys);
    assert.ok(errors.length > 0, 'expected a command-family collision error');
    assert.ok(
      errors.some((e) => /command family "github-sync" is owned by both/.test(e)),
      'expected a family-ownership error message: ' + errors.join('\n'),
    );
  });

  test('fail-first control: same config key -> non-empty error array', () => {
    const capMap = new Map([
      ['github-sync', GITHUB_SYNC_MANIFEST],
      ['projects-sync', projectsSyncManifest({
        config: { 'github_sync.enabled': { type: 'boolean', default: false, description: 'impostor key' } },
      })],
    ]);
    const errors = validateCrossCapability(capMap, centralKeys);
    assert.ok(errors.length > 0, 'expected a config-key collision error');
    assert.ok(
      errors.some((e) => /config key "github_sync\.enabled" is owned by both/.test(e)),
      'expected a config-key-ownership error message: ' + errors.join('\n'),
    );
  });

  test('fail-first control: same capability id -> rejected by the REAL id-collision code path (loadRegistry, not validateCrossCapability)', (t) => {
    // See the module doc comment above: validateCrossCapability cannot detect
    // this case by construction. This drives the actual ADR-1244 D2
    // "first-party wins" enforcement in capability-loader.cjs's loadRegistry.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'github-sync-id-collision-'));
    t.after(() => cleanup(home));
    const overlayDir = path.join(home, '.gsd', 'capabilities', 'github-sync');
    fs.mkdirSync(overlayDir, { recursive: true });
    const impostor = projectsSyncManifest({ id: 'github-sync', title: 'Impostor github-sync (id-squatting fixture)' });
    fs.writeFileSync(path.join(overlayDir, 'capability.json'), JSON.stringify(impostor));

    const reg = loadRegistry({ includeInstalled: true, gsdHome: home, cwd: home, hostVersion: '1.8.0' });

    // First-party wins: the real manifest's title survives; the impostor's does not.
    assert.equal(reg.capabilities['github-sync'].title, GITHUB_SYNC_MANIFEST.title);
    assert.ok(
      reg._overlay && reg._overlay.warnings.some((w) => w.id === 'github-sync' && /collide/i.test(w.reason)),
      'expected an id-collision skip warning naming "github-sync"',
    );
  });
});

describe('CAP-05 — registry-wide uniqueness sweep (generalized, not pair-specific)', () => {
  // Re-derives ownership maps from the raw `registry.capabilities` source of
  // truth (not the already-deduplicated derived views like bySkill/
  // commandFamilies, which cannot structurally show a duplicate) so a future
  // capability that reintroduces a collision actually turns this test red.
  function deriveOwnershipMaps() {
    const idSeen = new Set();
    const activationKeyOwner = new Map();
    const familyOwner = new Map();
    const configKeyOwner = new Map();
    const skillOwner = new Map();
    const errors = [];

    for (const [capId, cap] of Object.entries(registry.capabilities)) {
      if (idSeen.has(capId)) errors.push('duplicate capability id "' + capId + '"');
      idSeen.add(capId);

      if (typeof cap.activationKey === 'string' && cap.activationKey.length > 0) {
        if (activationKeyOwner.has(cap.activationKey)) {
          errors.push(
            'activationKey "' + cap.activationKey + '" is owned by both "' +
            activationKeyOwner.get(cap.activationKey) + '" and "' + capId + '"',
          );
        } else {
          activationKeyOwner.set(cap.activationKey, capId);
        }
      }

      for (const cmd of Array.isArray(cap.commands) ? cap.commands : []) {
        if (!cmd || typeof cmd.family !== 'string' || cmd.family.length === 0) continue;
        if (familyOwner.has(cmd.family)) {
          errors.push(
            'command family "' + cmd.family + '" is owned by both "' +
            familyOwner.get(cmd.family) + '" and "' + capId + '"',
          );
        } else {
          familyOwner.set(cmd.family, capId);
        }
      }

      for (const key of Object.keys(cap.config && typeof cap.config === 'object' ? cap.config : {})) {
        if (configKeyOwner.has(key)) {
          errors.push(
            'config key "' + key + '" is owned by both "' + configKeyOwner.get(key) + '" and "' + capId + '"',
          );
        } else {
          configKeyOwner.set(key, capId);
        }
      }

      for (const skill of Array.isArray(cap.skills) ? cap.skills : []) {
        if (skillOwner.has(skill)) {
          errors.push(
            'skill stem "' + skill + '" is owned by both "' + skillOwner.get(skill) + '" and "' + capId + '"',
          );
        } else {
          skillOwner.set(skill, capId);
        }
      }
    }

    return { errors, activationKeyOwner, familyOwner, configKeyOwner, skillOwner };
  }

  test('every capability id, activationKey, command family, config key, and skill stem is owned by exactly one capability', () => {
    const { errors } = deriveOwnershipMaps();
    assert.deepEqual(errors, [], 'expected zero ownership collisions across the whole registry');
  });

  test('the github_sync config-key namespace prefix is claimed by exactly one capability', () => {
    // NOTE — scoped, not registry-wide: this test does NOT assert "no two
    // capabilities anywhere in the registry share a config-key prefix". That
    // broader reading (present in this plan's <behavior> prose) does not hold
    // against the real registry: "workflow" is an intentionally-shared prefix
    // used by many first-party capabilities (ai-integration, code-review,
    // drift, security, ui, …), each owning distinct dotted keys under it —
    // proven when a first draft of this test asserted the universal form and
    // went red against 20 pre-existing, legitimate "workflow.*" pairs. The
    // acceptance criterion this plan actually specifies is narrower and is
    // exactly what CAP-05 needs: the github_sync namespace prefix itself
    // resolves to exactly one owner, github-sync, and no other capability
    // (including the mutation cases above) may claim it.
    const owners = new Set();
    for (const [capId, cap] of Object.entries(registry.capabilities)) {
      for (const key of Object.keys(cap.config && typeof cap.config === 'object' ? cap.config : {})) {
        if (key.split('.')[0] === 'github_sync') owners.add(capId);
      }
    }
    assert.deepEqual([...owners], ['github-sync']);
  });

  test('this capability owns exactly one bySkill entry and one capabilityClusters entry, both naming sync-github', () => {
    assert.equal(registry.bySkill['sync-github'], 'github-sync');
    assert.deepEqual(registry.capabilityClusters['github-sync'], ['sync-github']);
  });

  test('the github-sync identity triple (id, skill stem, config-key prefix) shares no token with the external projects-sync capability', () => {
    const ours = new Set(['github-sync', 'sync-github', 'github_sync']);
    // The external capability's recorded facts (see fixture doc comment above):
    // id "projects-sync" and config-key prefix "projects-sync" (it ships no
    // skill, so there is no third token to compare).
    const theirs = ['projects-sync'];
    for (const token of theirs) {
      assert.ok(!ours.has(token), 'token "' + token + '" collides with the external capability\'s claim');
    }
  });
});
