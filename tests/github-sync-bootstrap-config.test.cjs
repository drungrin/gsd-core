'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readPartialSyncTarget,
  readProjectTitle,
  readViewLayout,
  resolveTarget,
  writeProjectNumber,
  CONFIG_WRITE_REASON,
  RESOLVE_TARGET_REASON,
  VIEW_LAYOUT_CONFIG,
  DEFAULT_VIEW_LAYOUT_CONFIG,
} = require('../gsd-core/bin/lib/github-sync-bootstrap-config.cjs');
const { readSyncTarget } = require('../gsd-core/bin/lib/github-sync-target.cjs');
const realMap = require('../gsd-core/bin/lib/github-sync-map.cjs');
const { cleanup } = require('./helpers.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-bootstrap-config-'));
}

function writeConfig(dir, obj) {
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(obj, null, 2) + '\n');
}

const FULL_TARGET = { owner: 'octo', repo: 'gsd-core', repository_number: 1234, project_number: 9 };

// ─── writeProjectNumber ─────────────────────────────────────────────────────

describe('writeProjectNumber', () => {
  test('given a target holding the four keys and a zero project number, the write sets it to a positive value and readSyncTarget accepts the result', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, target: { ...FULL_TARGET, project_number: 0 } } });
      const result = writeProjectNumber(dir, { owner: 'octo', repo: 'gsd-core', repositoryNumber: 1234 }, 42);
      assert.equal(result.ok, true);
      assert.equal(result.reason, CONFIG_WRITE_REASON.WRITTEN);
      const read = readSyncTarget(dir);
      assert.equal(read.available, true);
      assert.equal(read.target.projectNumber, 42);
    } finally { cleanup(dir); }
  });

  test('every unrelated top-level key is byte-identical after the write, and top-level key order is preserved', () => {
    const dir = tempDir();
    try {
      const original = { alpha: 1, github_sync: { enabled: true, target: FULL_TARGET }, zeta: { nested: true } };
      writeConfig(dir, original);
      writeProjectNumber(dir, { owner: 'octo', repo: 'gsd-core', repositoryNumber: 1234 }, 55);
      const after = JSON.parse(fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8'));
      assert.equal(after.alpha, 1);
      assert.deepEqual(after.zeta, { nested: true });
      assert.deepEqual(Object.keys(after), Object.keys(original));
    } finally { cleanup(dir); }
  });

  test('given a config with no github_sync key at all, it creates the target with all four keys sourced from the resolved target', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { some_other_key: true });
      const result = writeProjectNumber(dir, { owner: 'newowner', repo: 'newrepo', repositoryNumber: 777 }, 3);
      assert.equal(result.ok, true);
      const after = JSON.parse(fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8'));
      assert.deepEqual(Object.keys(after.github_sync.target).sort(), ['owner', 'project_number', 'repo', 'repository_number'].sort());
      assert.equal(after.github_sync.target.owner, 'newowner');
      assert.equal(after.github_sync.target.repo, 'newrepo');
      assert.equal(after.github_sync.target.repository_number, 777);
      assert.equal(after.github_sync.target.project_number, 3);
      const read = readSyncTarget(dir);
      assert.equal(read.available, true);
    } finally { cleanup(dir); }
  });

  test('it never writes a dotted key', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { some_other_key: true });
      writeProjectNumber(dir, { owner: 'o', repo: 'r', repositoryNumber: 1 }, 1);
      const raw = fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8');
      assert.equal(/"github[_-]sync\.\w/.test(raw), false, 'must not contain a dotted github_sync.* key literal');
    } finally { cleanup(dir); }
  });

  test('given a config whose target already holds a fifth, unknown key, it refuses with an unrecognized-shape reason and writes nothing', () => {
    const dir = tempDir();
    try {
      const original = { github_sync: { enabled: true, target: { ...FULL_TARGET, extra_key: 'x' } } };
      writeConfig(dir, original);
      const before = fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8');
      const result = writeProjectNumber(dir, { owner: 'octo', repo: 'gsd-core', repositoryNumber: 1234 }, 42);
      assert.equal(result.ok, false);
      assert.equal(result.reason, CONFIG_WRITE_REASON.UNRECOGNIZED_SHAPE);
      const after = fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8');
      assert.equal(after, before);
    } finally { cleanup(dir); }
  });

  test('given a config carrying a project-title key alongside the target, the write leaves that sibling untouched and still produces exactly four target keys', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, project_title: 'My Board', target: { ...FULL_TARGET, project_number: 0 } } });
      writeProjectNumber(dir, { owner: 'octo', repo: 'gsd-core', repositoryNumber: 1234 }, 42);
      const after = JSON.parse(fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8'));
      assert.equal(after.github_sync.project_title, 'My Board');
      assert.equal(Object.keys(after.github_sync.target).length, 4);
    } finally { cleanup(dir); }
  });

  test('given an unreadable or unparseable config, it refuses with an unreadable reason and throws nothing', () => {
    const dir = tempDir();
    try {
      fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.planning', 'config.json'), '{ not valid json');
      let result;
      assert.doesNotThrow(() => { result = writeProjectNumber(dir, { owner: 'o', repo: 'r', repositoryNumber: 1 }, 1); });
      assert.equal(result.ok, false);
      assert.equal(result.reason, CONFIG_WRITE_REASON.UNREADABLE);

      const missingDir = tempDir();
      cleanup(missingDir); // never create .planning at all
      let result2;
      assert.doesNotThrow(() => { result2 = writeProjectNumber(missingDir, { owner: 'o', repo: 'r', repositoryNumber: 1 }, 1); });
      assert.equal(result2.ok, false);
      assert.equal(result2.reason, CONFIG_WRITE_REASON.UNREADABLE);
    } finally { cleanup(dir); }
  });

  test('given a non-positive or non-integer project number, it refuses with an invalid-number reason and writes nothing', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, target: FULL_TARGET } });
      const before = fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8');
      for (const bad of [0, -1, 1.5, NaN]) {
        const result = writeProjectNumber(dir, { owner: 'octo', repo: 'gsd-core', repositoryNumber: 1234 }, bad);
        assert.equal(result.ok, false);
        assert.equal(result.reason, CONFIG_WRITE_REASON.INVALID_NUMBER);
      }
      const after = fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8');
      assert.equal(after, before);
    } finally { cleanup(dir); }
  });

  test('the write is atomic: no leftover temp file remains, and the target file is fully replaced', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, target: { ...FULL_TARGET, project_number: 0 } } });
      writeProjectNumber(dir, { owner: 'octo', repo: 'gsd-core', repositoryNumber: 1234 }, 42);
      const entries = fs.readdirSync(path.join(dir, '.planning'));
      assert.deepEqual(entries, ['config.json']);
    } finally { cleanup(dir); }
  });

  // ── CR-02 regression: a stale repository_number must be repaired, not re-serialized ──

  test('CR-02: given an existing target whose repository number is stale (0), the write persists the resolved value from the target parameter and readSyncTarget accepts the result', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, target: { owner: 'configured-owner', repo: 'configured-repo', repository_number: 0 } } });
      const result = writeProjectNumber(dir, { owner: 'configured-owner', repo: 'configured-repo', repositoryNumber: 999 }, 42);
      assert.equal(result.ok, true);
      assert.equal(result.reason, CONFIG_WRITE_REASON.WRITTEN);
      const after = JSON.parse(fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8'));
      assert.equal(after.github_sync.target.repository_number, 999);
      assert.equal(after.github_sync.target.project_number, 42);
      const read = readSyncTarget(dir);
      assert.equal(read.available, true);
      assert.equal(read.target.repositoryNumber, 999);
      assert.equal(read.target.projectNumber, 42);
    } finally { cleanup(dir); }
  });

  test('CR-02: the router\'s own sequence end to end — resolveTarget\'s recovered target threaded into writeProjectNumber leaves a config readSyncTarget accepts', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, target: { owner: 'configured-owner', repo: 'configured-repo', repository_number: 0 } } });
      let calls = 0;
      const execGh = () => {
        calls += 1;
        return { exitCode: 0, stdout: JSON.stringify({ owner: { login: 'should-be-ignored' }, name: 'should-be-ignored', databaseId: 999 }), stderr: '', reason: 'ok' };
      };
      const result = resolveTarget(dir, { execGh });
      assert.equal(result.reason, RESOLVE_TARGET_REASON.RESOLVED);
      assert.equal(calls, 1);

      const { owner, repo, repositoryNumber } = result.target;
      const writeResult = writeProjectNumber(dir, { owner, repo, repositoryNumber }, 42);
      assert.equal(writeResult.ok, true);

      const read = readSyncTarget(dir);
      assert.equal(read.available, true);
      assert.equal(read.target.repositoryNumber, 999);
    } finally { cleanup(dir); }
  });

  test('CR-02: the unrecognized-shape refusal still fires now that the written values come from the resolved target', () => {
    const dir = tempDir();
    try {
      const original = { github_sync: { enabled: true, target: { owner: 'configured-owner', repo: 'configured-repo', repository_number: 0, mystery: 'unrecognized-fifth-key' } } };
      writeConfig(dir, original);
      const before = fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8');
      const result = writeProjectNumber(dir, { owner: 'configured-owner', repo: 'configured-repo', repositoryNumber: 999 }, 42);
      assert.equal(result.ok, false);
      assert.equal(result.reason, CONFIG_WRITE_REASON.UNRECOGNIZED_SHAPE);
      const after = fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8');
      assert.equal(after, before);
    } finally { cleanup(dir); }
  });

  test('CR-02: idempotent convergence — a follow-up resolveTarget reports configured with zero gh spawns, and a repeat write is byte-identical', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, target: { owner: 'configured-owner', repo: 'configured-repo', repository_number: 0 } } });
      const firstExecGh = () => ({ exitCode: 0, stdout: JSON.stringify({ owner: { login: 'should-be-ignored' }, name: 'should-be-ignored', databaseId: 999 }), stderr: '', reason: 'ok' });
      const firstResolve = resolveTarget(dir, { execGh: firstExecGh });
      const { owner, repo, repositoryNumber } = firstResolve.target;
      writeProjectNumber(dir, { owner, repo, repositoryNumber }, 42);
      const afterFirstWrite = fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8');

      let secondCalls = 0;
      const secondResolve = resolveTarget(dir, { execGh: () => { secondCalls += 1; return { exitCode: 1, stdout: '', stderr: '', reason: 'gh_exit_nonzero' }; } });
      assert.equal(secondResolve.reason, RESOLVE_TARGET_REASON.CONFIGURED);
      assert.equal(secondCalls, 0);

      writeProjectNumber(dir, { owner, repo, repositoryNumber }, 42);
      const afterSecondWrite = fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8');
      assert.equal(afterSecondWrite, afterFirstWrite);
    } finally { cleanup(dir); }
  });
});

// ─── readPartialSyncTarget ──────────────────────────────────────────────────

describe('readPartialSyncTarget', () => {
  test('a fully valid four-key target yields all four values and the recognized shape', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, target: FULL_TARGET } });
      const result = readPartialSyncTarget(dir);
      assert.equal(result.owner, 'octo');
      assert.equal(result.repo, 'gsd-core');
      assert.equal(result.repositoryNumber, 1234);
      assert.equal(result.projectNumber, 9);
      assert.notEqual(result.shape, 'absent');
      assert.notEqual(result.shape, 'unrecognized');
    } finally { cleanup(dir); }
  });

  test('a target missing only its project number yields owner/repo/repository-number verbatim and a null project number', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, target: { owner: 'octo', repo: 'gsd-core', repository_number: 1234 } } });
      const result = readPartialSyncTarget(dir);
      assert.equal(result.owner, 'octo');
      assert.equal(result.repo, 'gsd-core');
      assert.equal(result.repositoryNumber, 1234);
      assert.equal(result.projectNumber, null);
    } finally { cleanup(dir); }
  });

  test('a target whose owner is present but empty yields a null owner and preserves the other valid values', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, target: { ...FULL_TARGET, owner: '' } } });
      const result = readPartialSyncTarget(dir);
      assert.equal(result.owner, null);
      assert.equal(result.repo, 'gsd-core');
      assert.equal(result.repositoryNumber, 1234);
      assert.equal(result.projectNumber, 9);
    } finally { cleanup(dir); }
  });

  test('a config with no github_sync key yields all-null values and the absent shape', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { unrelated: true });
      const result = readPartialSyncTarget(dir);
      assert.deepEqual([result.owner, result.repo, result.repositoryNumber, result.projectNumber], [null, null, null, null]);
      assert.equal(result.shape, 'absent');
    } finally { cleanup(dir); }
  });

  test('a target carrying an unknown fifth key yields the unrecognized shape, and writeProjectNumber refuses that same config', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, target: { ...FULL_TARGET, mystery: 1 } } });
      const result = readPartialSyncTarget(dir);
      assert.equal(result.shape, 'unrecognized');
      const writeResult = writeProjectNumber(dir, { owner: 'octo', repo: 'gsd-core', repositoryNumber: 1234 }, 1);
      assert.equal(writeResult.ok, false);
      assert.equal(writeResult.reason, CONFIG_WRITE_REASON.UNRECOGNIZED_SHAPE);
    } finally { cleanup(dir); }
  });

  // ── differential test: predicate parity with the real readSyncTarget ──
  test('predicate parity: for every case where readSyncTarget reports available, readPartialSyncTarget returns the same four values; per-field validity agrees on every case', () => {
    const cases = [
      { name: 'valid', target: FULL_TARGET },
      { name: 'owner-invalid-empty', target: { ...FULL_TARGET, owner: '' } },
      { name: 'owner-invalid-wrong-type', target: { ...FULL_TARGET, owner: 42 } },
      { name: 'repo-invalid-empty', target: { ...FULL_TARGET, repo: '' } },
      { name: 'repo-invalid-wrong-type', target: { ...FULL_TARGET, repo: null } },
      { name: 'repository-number-zero', target: { ...FULL_TARGET, repository_number: 0 } },
      { name: 'repository-number-negative', target: { ...FULL_TARGET, repository_number: -5 } },
      { name: 'repository-number-fractional', target: { ...FULL_TARGET, repository_number: 1.5 } },
      { name: 'project-number-zero', target: { ...FULL_TARGET, project_number: 0 } },
      { name: 'project-number-negative', target: { ...FULL_TARGET, project_number: -1 } },
      { name: 'project-number-wrong-type', target: { ...FULL_TARGET, project_number: '9' } },
      { name: 'extra-key', target: { ...FULL_TARGET, extra: true } },
    ];
    assert.ok(cases.length >= 12, 'the shared candidate table must carry at least 12 cases');

    for (const { name, target } of cases) {
      const dir = tempDir();
      try {
        writeConfig(dir, { github_sync: { enabled: true, target } });
        const strict = readSyncTarget(dir);
        const partial = readPartialSyncTarget(dir);

        if (strict.available) {
          assert.deepEqual(
            [partial.owner, partial.repo, partial.repositoryNumber, partial.projectNumber],
            [strict.target.owner, strict.target.repo, strict.target.repositoryNumber, strict.target.projectNumber],
            `case ${name}: readPartialSyncTarget must match readSyncTarget's available values`,
          );
        }

        // Per-field validity agreement: when readSyncTarget names a specific
        // failing leaf field, that same field must also be null on the
        // partial reader. Skipped for the extra-key case, whose key-set
        // rejection is a shape-level disagreement by design — the partial
        // reader still surfaces null for every field, matching readSyncTarget's
        // own "no single leaf field" verdict, so there is no single leaf
        // field to compare.
        if (name !== 'extra-key' && !strict.available && strict.field && strict.field !== 'config' && strict.field !== 'target') {
          const partialFieldMap = { owner: partial.owner, repo: partial.repo, repository_number: partial.repositoryNumber, project_number: partial.projectNumber };
          assert.equal(partialFieldMap[strict.field], null, `case ${name}: readSyncTarget's failing field ${strict.field} must also be null on the partial reader`);
        }
      } finally { cleanup(dir); }
    }
  });
});

// ─── readProjectTitle ───────────────────────────────────────────────────────

describe('readProjectTitle', () => {
  test('a config carrying a non-empty title string returns it verbatim, including internal spaces and non-ASCII characters', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, project_title: 'GSD Rœadmap 项目' } });
      assert.equal(readProjectTitle(dir), 'GSD Rœadmap 项目');
    } finally { cleanup(dir); }
  });

  test('a config with no such key, an empty string, or a non-string value returns null', () => {
    for (const githubSync of [{ enabled: true }, { enabled: true, project_title: '' }, { enabled: true, project_title: 42 }]) {
      const dir = tempDir();
      try {
        writeConfig(dir, { github_sync: githubSync });
        assert.equal(readProjectTitle(dir), null);
      } finally { cleanup(dir); }
    }
  });
});

// ─── readViewLayout ─────────────────────────────────────────────────────────

describe('readViewLayout', () => {
  const BOARD_LAYOUT = VIEW_LAYOUT_CONFIG[DEFAULT_VIEW_LAYOUT_CONFIG];

  function writeViewLayoutConfig(dir, layoutValue) {
    writeConfig(dir, { github_sync: { enabled: true, view: { layout: layoutValue } } });
  }

  // One row per line of the <feature> table.
  const TABLE = [
    { name: 'board', value: 'board', expected: 'BOARD_LAYOUT' },
    { name: 'table', value: 'table', expected: 'TABLE_LAYOUT' },
    { name: 'roadmap', value: 'roadmap', expected: 'ROADMAP_LAYOUT' },
    { name: 'empty string', value: '', expected: 'BOARD_LAYOUT' },
    { name: 'wrong case', value: 'Board', expected: 'BOARD_LAYOUT' },
    { name: 'the GraphQL member, not the config spelling', value: 'BOARD_LAYOUT', expected: 'BOARD_LAYOUT' },
    { name: 'unrecognized value', value: 'kanban', expected: 'BOARD_LAYOUT' },
    { name: 'number', value: 42, expected: 'BOARD_LAYOUT' },
    { name: 'null', value: null, expected: 'BOARD_LAYOUT' },
    { name: 'boolean', value: true, expected: 'BOARD_LAYOUT' },
    { name: 'object', value: {}, expected: 'BOARD_LAYOUT' },
    { name: 'array', value: [], expected: 'BOARD_LAYOUT' },
    { name: 'trailing space', value: 'board ', expected: 'BOARD_LAYOUT' },
  ];

  for (const { name, value, expected } of TABLE) {
    test(`github_sync.view.layout = ${JSON.stringify(value)} (${name}) returns ${expected}`, () => {
      const dir = tempDir();
      try {
        writeViewLayoutConfig(dir, value);
        assert.equal(readViewLayout(dir), expected);
      } finally { cleanup(dir); }
    });
  }

  test('an absent view.layout key, an absent github_sync block, and an absent config file all return the board default', () => {
    // Absent view.layout key.
    const dirNoKey = tempDir();
    try {
      writeConfig(dirNoKey, { github_sync: { enabled: true, view: {} } });
      assert.equal(readViewLayout(dirNoKey), BOARD_LAYOUT);
    } finally { cleanup(dirNoKey); }

    // Absent github_sync block entirely.
    const dirNoBlock = tempDir();
    try {
      writeConfig(dirNoBlock, { unrelated: true });
      assert.equal(readViewLayout(dirNoBlock), BOARD_LAYOUT);
    } finally { cleanup(dirNoBlock); }

    // Absent/unreadable config file.
    const dirNoConfig = tempDir();
    cleanup(dirNoConfig); // never create .planning at all
    assert.equal(readViewLayout(dirNoConfig), BOARD_LAYOUT);
  });

  test('every value in the table belongs to the three-member GraphQL enum, never a fourth value', () => {
    const validMembers = new Set(Object.values(VIEW_LAYOUT_CONFIG));
    assert.equal(validMembers.size, 3, 'the closed map must carry exactly three GraphQL enum members');
    for (const { value } of TABLE) {
      const dir = tempDir();
      try {
        writeViewLayoutConfig(dir, value);
        assert.ok(validMembers.has(readViewLayout(dir)), `value ${JSON.stringify(value)} must map to one of the three GraphQL enum members`);
      } finally { cleanup(dir); }
    }
  });

  test('does not throw when .planning/config.json is a directory, is empty, contains null, or contains a JSON array', () => {
    const dirIsDirectory = tempDir();
    try {
      fs.mkdirSync(path.join(dirIsDirectory, '.planning', 'config.json'), { recursive: true });
      let result;
      assert.doesNotThrow(() => { result = readViewLayout(dirIsDirectory); });
      assert.equal(result, BOARD_LAYOUT);
    } finally { cleanup(dirIsDirectory); }

    const dirEmpty = tempDir();
    try {
      fs.mkdirSync(path.join(dirEmpty, '.planning'), { recursive: true });
      fs.writeFileSync(path.join(dirEmpty, '.planning', 'config.json'), '');
      let result;
      assert.doesNotThrow(() => { result = readViewLayout(dirEmpty); });
      assert.equal(result, BOARD_LAYOUT);
    } finally { cleanup(dirEmpty); }

    const dirNull = tempDir();
    try {
      fs.mkdirSync(path.join(dirNull, '.planning'), { recursive: true });
      fs.writeFileSync(path.join(dirNull, '.planning', 'config.json'), 'null');
      let result;
      assert.doesNotThrow(() => { result = readViewLayout(dirNull); });
      assert.equal(result, BOARD_LAYOUT);
    } finally { cleanup(dirNull); }

    const dirArray = tempDir();
    try {
      fs.mkdirSync(path.join(dirArray, '.planning'), { recursive: true });
      fs.writeFileSync(path.join(dirArray, '.planning', 'config.json'), '[]');
      let result;
      assert.doesNotThrow(() => { result = readViewLayout(dirArray); });
      assert.equal(result, BOARD_LAYOUT);
    } finally { cleanup(dirArray); }
  });

  test('a github_sync.view that is a string rather than an object returns the board default (the nested-key guard)', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, view: 'board' } });
      assert.equal(readViewLayout(dir), BOARD_LAYOUT);
    } finally { cleanup(dir); }
  });
});

// ─── resolveTarget ──────────────────────────────────────────────────────────

describe('resolveTarget', () => {
  test('readSyncTarget available → returns the configured target unchanged, and the injected execGh spy records zero calls', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, target: FULL_TARGET } });
      let calls = 0;
      const result = resolveTarget(dir, { execGh: () => { calls += 1; return { exitCode: 1, stdout: '', stderr: '', reason: 'gh_exit_nonzero' }; } });
      assert.equal(result.reason, RESOLVE_TARGET_REASON.CONFIGURED);
      assert.deepEqual(result.target, { owner: 'octo', repo: 'gsd-core', repositoryNumber: 1234, projectNumber: 9 });
      assert.equal(calls, 0);
    } finally { cleanup(dir); }
  });

  test('the whole github_sync block is missing → invokes gh repo view once and returns owner/repo/repositoryNumber from it, with a null project number', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { unrelated: true });
      let calls = 0;
      const execGh = () => {
        calls += 1;
        return { exitCode: 0, stdout: JSON.stringify({ owner: { login: 'from-gh' }, name: 'repo-from-gh', databaseId: 555 }), stderr: '', reason: 'ok' };
      };
      const result = resolveTarget(dir, { execGh });
      assert.equal(calls, 1);
      assert.equal(result.reason, RESOLVE_TARGET_REASON.RESOLVED);
      assert.equal(result.target.owner, 'from-gh');
      assert.equal(result.target.repo, 'repo-from-gh');
      assert.equal(result.target.repositoryNumber, 555);
      assert.equal(result.target.projectNumber, null);
    } finally { cleanup(dir); }
  });

  test('only the project number is missing → configured values kept byte-identical, gh repo view NOT invoked, and the map recovery branch runs', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, target: { owner: 'octo', repo: 'gsd-core', repository_number: 1234 } } });
      let calls = 0;
      const result = resolveTarget(dir, { execGh: () => { calls += 1; return { exitCode: 1, stdout: '', stderr: '', reason: 'gh_exit_nonzero' }; } });
      assert.equal(calls, 0);
      assert.equal(result.target.owner, 'octo');
      assert.equal(result.target.repo, 'gsd-core');
      assert.equal(result.target.repositoryNumber, 1234);
      assert.equal(result.target.projectNumber, null);
    } finally { cleanup(dir); }
  });

  test('owner configured but repository number missing → gh repo view invoked once, fills only the repository number, and the configured owner is kept byte-identical', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, target: { owner: 'configured-owner', repo: 'configured-repo', repository_number: 0 } } });
      let calls = 0;
      const execGh = () => {
        calls += 1;
        return { exitCode: 0, stdout: JSON.stringify({ owner: { login: 'should-be-ignored' }, name: 'should-be-ignored', databaseId: 999 }), stderr: '', reason: 'ok' };
      };
      const result = resolveTarget(dir, { execGh });
      assert.equal(calls, 1);
      assert.equal(result.target.owner, 'configured-owner');
      assert.equal(result.target.repo, 'configured-repo');
      assert.equal(result.target.repositoryNumber, 999);
    } finally { cleanup(dir); }
  });

  test('a gh repo view response whose owner is a bare string rather than an object yields an unresolvable result', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { unrelated: true });
      const execGh = () => ({ exitCode: 0, stdout: JSON.stringify({ owner: 'bare-string-owner', name: 'repo', databaseId: 1 }), stderr: '', reason: 'ok' });
      const result = resolveTarget(dir, { execGh });
      assert.equal(result.reason, RESOLVE_TARGET_REASON.UNRESOLVABLE);
      assert.equal(result.target, null);
    } finally { cleanup(dir); }
  });

  test('a missing login, missing/non-positive database id also yield unresolvable', () => {
    const dir = tempDir();
    const cases = [
      { owner: {}, name: 'repo', databaseId: 1 },
      { owner: { login: 'o' }, name: 'repo', databaseId: 0 },
      { owner: { login: 'o' }, name: 'repo' },
      { owner: { login: 'o' }, name: '', databaseId: 1 },
    ];
    try {
      writeConfig(dir, { unrelated: true });
      for (const body of cases) {
        const result = resolveTarget(dir, { execGh: () => ({ exitCode: 0, stdout: JSON.stringify(body), stderr: '', reason: 'ok' }) });
        assert.equal(result.reason, RESOLVE_TARGET_REASON.UNRESOLVABLE);
      }
    } finally { cleanup(dir); }
  });

  test('gh repo view exits non-zero, times out, or returns unparseable JSON → unresolvable, throws nothing', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { unrelated: true });
      for (const ghResult of [
        { exitCode: 1, stdout: '', stderr: 'error', reason: 'gh_exit_nonzero' },
        { exitCode: 124, stdout: '', stderr: '', reason: 'gh_timed_out' },
        { exitCode: 0, stdout: 'not json', stderr: '', reason: 'ok' },
      ]) {
        let result;
        assert.doesNotThrow(() => { result = resolveTarget(dir, { execGh: () => ghResult }); });
        assert.equal(result.reason, RESOLVE_TARGET_REASON.UNRESOLVABLE);
      }
    } finally { cleanup(dir); }
  });

  test('the owner and repo returned by gh repo view are passed through assertPathSafeTarget before being returned', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { unrelated: true });
      const execGh = () => ({ exitCode: 0, stdout: JSON.stringify({ owner: { login: '{owner}' }, name: 'repo', databaseId: 1 }), stderr: '', reason: 'ok' });
      const result = resolveTarget(dir, { execGh });
      assert.equal(result.reason, RESOLVE_TARGET_REASON.UNRESOLVABLE);
    } finally { cleanup(dir); }
  });

  test('crash recovery: config carries owner/repo/repository-number but no valid project number, and the map holds a matching project completion → resolveTarget returns that number', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, target: { owner: 'octo', repo: 'gsd-core', repository_number: 1234 } } });
      const map = realMap.recordCompletion(null, {
        logicalKey: 'project', nodeId: 'PVT_recovered', issueNumber: 77, completedAt: '2026-01-01T00:00:00.000Z',
        owner: 'octo', repo: 'gsd-core', repositoryNumber: 1234,
      });
      realMap.writeSyncMapAtomically(dir, map);
      const result = resolveTarget(dir, {});
      assert.equal(result.target.projectNumber, 77);
    } finally { cleanup(dir); }
  });

  test('crash recovery, the reachable case: config entirely absent, identity from gh repo view, and the map read happens AFTER it — execGh invoked exactly once, project number still recovered', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { unrelated: true });
      const map = realMap.recordCompletion(null, {
        logicalKey: 'project', nodeId: 'PVT_recovered2', issueNumber: 88, completedAt: '2026-01-01T00:00:00.000Z',
        owner: 'gh-owner', repo: 'gh-repo', repositoryNumber: 4242,
      });
      realMap.writeSyncMapAtomically(dir, map);
      let calls = 0;
      const execGh = () => {
        calls += 1;
        return { exitCode: 0, stdout: JSON.stringify({ owner: { login: 'gh-owner' }, name: 'gh-repo', databaseId: 4242 }), stderr: '', reason: 'ok' };
      };
      const result = resolveTarget(dir, { execGh });
      assert.equal(calls, 1);
      assert.equal(result.target.projectNumber, 88);
    } finally { cleanup(dir); }
  });

  test('a project completion bound to a different repository is ignored, and a project completion with no remote number is ignored', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, target: { owner: 'octo', repo: 'gsd-core', repository_number: 1234 } } });
      const foreignMap = realMap.recordCompletion(null, {
        logicalKey: 'project', nodeId: 'PVT_foreign', issueNumber: 999, completedAt: '2026-01-01T00:00:00.000Z',
        owner: 'someone-else', repo: 'other-repo', repositoryNumber: 1,
      });
      realMap.writeSyncMapAtomically(dir, foreignMap);
      const foreignResult = resolveTarget(dir, {});
      assert.equal(foreignResult.target.projectNumber, null);

      cleanup(dir);
      const dir2 = tempDir();
      writeConfig(dir2, { github_sync: { enabled: true, target: { owner: 'octo', repo: 'gsd-core', repository_number: 1234 } } });
      const noNumberMap = realMap.recordCompletion(null, {
        logicalKey: 'project', nodeId: 'PVT_no_number', completedAt: '2026-01-01T00:00:00.000Z',
        owner: 'octo', repo: 'gsd-core', repositoryNumber: 1234,
      });
      realMap.writeSyncMapAtomically(dir2, noNumberMap);
      const noNumberResult = resolveTarget(dir2, {});
      assert.equal(noNumberResult.target.projectNumber, null);
      cleanup(dir2);
    } finally { /* both cleaned up inline above */ }
  });

  test('the returned result carries the strict-map read it performed', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, target: FULL_TARGET } });
      const result = resolveTarget(dir, {});
      assert.ok(result.strictMapRead);
      assert.equal(result.strictMapRead.kind, 'absent');
    } finally { cleanup(dir); }
  });
});

// ─── resolveTarget: plan 07-10 Task 3 (D-01 option-d) — sync-map project ────
// recovery tier, gated on an explicit caller-reported verdict ───────────────

describe('resolveTarget: option-d sync-map project-number recovery tier', () => {
  test('configuredProjectNumberConfirmedAbsent true, and the map holds a DIFFERENT valid project completion number, overrides — the original configured number rides back on configuredProjectNumber', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, target: FULL_TARGET } });
      const map = realMap.recordCompletion(null, {
        logicalKey: 'project', nodeId: 'PVT_NEW', issueNumber: 42, completedAt: '2026-01-01T00:00:00.000Z',
        owner: FULL_TARGET.owner, repo: FULL_TARGET.repo, repositoryNumber: FULL_TARGET.repository_number,
      });
      realMap.writeSyncMapAtomically(dir, map);
      const result = resolveTarget(dir, { configuredProjectNumberConfirmedAbsent: true });
      assert.equal(result.target.projectNumber, 42);
      assert.equal(result.configuredProjectNumber, FULL_TARGET.project_number);
      assert.equal(result.reason, RESOLVE_TARGET_REASON.CONFIGURED);
      // Every other member of the target is untouched.
      assert.equal(result.target.owner, FULL_TARGET.owner);
      assert.equal(result.target.repo, FULL_TARGET.repo);
      assert.equal(result.target.repositoryNumber, FULL_TARGET.repository_number);
    } finally { cleanup(dir); }
  });

  test('configuredProjectNumberConfirmedAbsent true, but the map\'s project number EQUALS the configured one — no override, no configuredProjectNumber field', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, target: FULL_TARGET } });
      const map = realMap.recordCompletion(null, {
        logicalKey: 'project', nodeId: 'PVT_SAME', issueNumber: FULL_TARGET.project_number, completedAt: '2026-01-01T00:00:00.000Z',
        owner: FULL_TARGET.owner, repo: FULL_TARGET.repo, repositoryNumber: FULL_TARGET.repository_number,
      });
      realMap.writeSyncMapAtomically(dir, map);
      const result = resolveTarget(dir, { configuredProjectNumberConfirmedAbsent: true });
      assert.equal(result.target.projectNumber, FULL_TARGET.project_number);
      assert.equal(result.configuredProjectNumber, undefined);
    } finally { cleanup(dir); }
  });

  test('configuredProjectNumberConfirmedAbsent absent (or false) — a configured project number wins even when the map carries a different one (D-01 config-first ordering unchanged for every other case)', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, target: FULL_TARGET } });
      const map = realMap.recordCompletion(null, {
        logicalKey: 'project', nodeId: 'PVT_UNRELATED', issueNumber: 999, completedAt: '2026-01-01T00:00:00.000Z',
        owner: FULL_TARGET.owner, repo: FULL_TARGET.repo, repositoryNumber: FULL_TARGET.repository_number,
      });
      realMap.writeSyncMapAtomically(dir, map);

      const withoutFlag = resolveTarget(dir, {});
      assert.equal(withoutFlag.target.projectNumber, FULL_TARGET.project_number);
      assert.equal(withoutFlag.configuredProjectNumber, undefined);

      const withFalseFlag = resolveTarget(dir, { configuredProjectNumberConfirmedAbsent: false });
      assert.equal(withFalseFlag.target.projectNumber, FULL_TARGET.project_number);
      assert.equal(withFalseFlag.configuredProjectNumber, undefined);
    } finally { cleanup(dir); }
  });

  test('configuredProjectNumberConfirmedAbsent true, but the map has no project completion at all — falls back to the configured number unchanged', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, target: FULL_TARGET } });
      const result = resolveTarget(dir, { configuredProjectNumberConfirmedAbsent: true });
      assert.equal(result.target.projectNumber, FULL_TARGET.project_number);
      assert.equal(result.configuredProjectNumber, undefined);
    } finally { cleanup(dir); }
  });

  test('resolveTarget performs no execGh call to decide the override — the verdict is entirely the caller-supplied boolean plus the already-local strict-map read', () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { github_sync: { enabled: true, target: FULL_TARGET } });
      const map = realMap.recordCompletion(null, {
        logicalKey: 'project', nodeId: 'PVT_NEW', issueNumber: 42, completedAt: '2026-01-01T00:00:00.000Z',
        owner: FULL_TARGET.owner, repo: FULL_TARGET.repo, repositoryNumber: FULL_TARGET.repository_number,
      });
      realMap.writeSyncMapAtomically(dir, map);
      let calls = 0;
      const execGh = () => { calls += 1; return { exitCode: 1, stdout: '', stderr: '', reason: 'gh_exit_nonzero' }; };
      const result = resolveTarget(dir, { execGh, configuredProjectNumberConfirmedAbsent: true });
      assert.equal(calls, 0, 'the CONFIGURED path never needs gh repo view, override or not');
      assert.equal(result.target.projectNumber, 42);
    } finally { cleanup(dir); }
  });
});
