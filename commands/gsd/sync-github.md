---
name: gsd:sync-github
description: "Mirror .planning/ phase and plan state into a GitHub Project v2 board (one-way, disk to GitHub)"
argument-hint: "[preflight]"
allowed-tools:
  - Read
  - Bash
---

**STOP -- DO NOT READ THIS FILE. You are already reading it. This prompt was injected into your context by Claude Code's command system. Using the Read tool on this file wastes tokens. Begin executing Step 0 immediately.**

## Step 0 -- Banner

**Before ANY tool calls**, display this banner:

```
GSD > GITHUB-SYNC
```

Then proceed to Step 1.

## Step 1 -- Config Gate

Check if github-sync is enabled by reading `.planning/config.json` directly using the Read tool.

**DO NOT use the gsd-tools config get-value command** -- it hard-exits on missing keys.

1. Read `.planning/config.json` using the Read tool
2. If the file does not exist: display the disabled message below and **STOP**
3. Parse the JSON content. Check if `config.github_sync && config.github_sync.enabled === true`
4. If `github_sync.enabled` is NOT explicitly `true`: display the disabled message below and **STOP**
5. If `github_sync.enabled` is `true`: proceed to Step 2

**Disabled message:**

```
GSD > GITHUB-SYNC

The GitHub Project mirror is disabled. To activate:

  node <runtime-home>/gsd-core/bin/gsd-tools.cjs config-set github_sync.enabled true

Then run /gsd:sync-github preflight to verify GitHub access before syncing.
```

---

## Step 2 -- Parse Argument

Parse `$ARGUMENTS` to determine the operation mode:

| Argument | Action |
|----------|--------|
| `preflight` | Run inline preflight check (Step 3) |
| No argument or unknown | Show usage message |

**No other subcommand is registered yet.** `init`, `sync`, and `status` are added by the phases
that implement them -- do not attempt to run them.

**Usage message** (shown when no argument or unrecognized argument):

```
GSD > GITHUB-SYNC

Usage: /gsd:sync-github <mode>

Modes:
  preflight       Verify gh CLI, auth, and Projects v2 access before syncing

No other subcommand exists yet.
```

---

## Step 3 -- Preflight (Inline)

Before running the preflight command, tell the user what it checks:

- The `gh` CLI is installed and on PATH
- `gh` is authenticated
- The authenticated token has the `project` scope required by Projects v2 -- a token that merely
  exists but cannot reach Projects v2 is not sufficient. Get it with:

  ```
  gh auth refresh -s project
  ```

  Or, for a classic personal access token, grant the `project` scope when creating it.

- **In CI**, the default `GITHUB_TOKEN` provided by the runner is repo-scoped only and cannot
  reach Projects v2 regardless of the workflow's `permissions:` block. A classic PAT with the
  `project` scope must be exported as the `GH_TOKEN` environment variable instead.

**Never print or echo a token value** -- not the user's, not a fixture's, not a partial one.

Run:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "$HOME/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="$HOME/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi
gsd_run github-sync preflight
```

Parse the JSON output on stdout:
- `{"ok": true, "reason": "ok", ...}` -- preflight passed, GitHub access is ready
- `{"ok": false, "reason": "missing_gh", ...}` -- the `gh` CLI is not installed; display the
  actionable stderr message
- `{"ok": false, "reason": "no_token", ...}` -- no valid GitHub credentials were found
- `gh` ran but the probe failed for another reason: `reason` is one of `wrong_scope`
  (token exists but lacks the `project` scope), `outage` (transient GitHub failure),
  `rate_limited` (this token is being throttled), or `sso_or_null_payload` (the response needs SSO
  authorization or returned no usable data). Do not branch on which of these five it is -- display
  the `message` field verbatim; the remedy differences between them are already encoded there.

Display the stderr message verbatim if present -- it is already written to be actionable and
never embeds raw `gh` output.

**STOP** after displaying the preflight result. Do not spawn an agent.
