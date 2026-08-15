# @billqiu1126/dsh-workspace-hierarchy

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web plugin that turns the workspace list into a **hierarchical (main / sub-workspace) tree**.

> [中文说明见 README.zh.md](./README.zh.md)

## Features

- Workspaces are nested **by directory path**: a workspace whose directory lives inside another workspace's directory is shown indented beneath it (unlimited depth).
- Only directories that are **actually added as workspaces** appear — ordinary subfolders such as `build`, `docs` are never listed.
- Each workspace's **`+` button becomes a menu** with two choices:
  - **New session** — start a session in that workspace (original behavior);
  - **Add sub-workspace** — pick a directory and register it as a sub-workspace (adds it only, without starting a session).
- Each session's **`⋯` menu now includes Delete session** — permanently remove the session and its log (with a confirmation dialog; cannot be undone).
- Each session's **`⋯` menu now includes Move to workspace** — pick a target directory, confirm, and the session's `cwd` is rewritten and re-accounted under that workspace (restart `dsh web` afterwards).

Example:

```
▼ DeepSeek-Harness                    main workspace
    ▼ DeepSeek Harness Desktop        sub-workspace
        [sessions…]
    ▼ Test Deep SeekHarness           sub-workspace
        [sessions…]
    [DeepSeek-Harness's own sessions…]
```

## How it works

This package is an enhanced build of the built-in workspace browser (`@deepseek-ai/dsh-client-ui-workspace`). It derives parent/child relationships from workspace paths in `deriveGroups`, adds a `depth` per workspace, indents the tree accordingly, and turns the workspace row's `+` into a menu. Because it changes the workspace browser's internal rendering, it **replaces** the built-in `ui-workspace` entry.

"Delete session" is implemented across both halves: the **host half** registers a `delete-session` slash command that deletes the session's persisted log and removes it from every workspace's session account (DSH has no "delete session" RPC — only archive), and the **browser half** adds the `⋯` menu item that invokes that command.

## Requirements

- `@deepseek-ai/dsh` (0.1.0-rc.x) installed globally.
- A web profile (`dsh web`, or the desktop app).

## Installation

There are **two equivalent ways** — pick **one**:

### Option A — one-click script (recommended)

```bash
# Windows (PowerShell)
.\install.ps1

# Linux / macOS
./install.sh
```

The script installs the package into your profile and writes the required `cordis.patch.yml` entries for you.

### Option B — manual

**1.** Install the package into the profile:

```bash
dsh plugin --profile web add @billqiu1126/dsh-workspace-hierarchy
```

**2.** Edit `~/.dsh/profiles/web/cordis.patch.yml` (`C:\Users\<you>\.dsh\profiles\web\cordis.patch.yml` on Windows) and add:

```yaml
# Disable the built-in workspace browser (replaced by this plugin).
- id: ui-workspace
  disabled: true

# Mount the hierarchical workspace browser.
- insert:
    - id: ui-workspace-hierarchy
      name: '@billqiu1126/dsh-workspace-hierarchy'
```

**3.** Restart `dsh web` (or the desktop app) and refresh the browser.

## Publishing to npm

```bash
npm publish --access public
```

## Repository structure

```
@billqiu1126/dsh-workspace-hierarchy/
├── package.json      # dsh.client declaration, peerDependencies, exports
├── install.ps1       # one-click installer (Windows)
├── install.sh        # one-click installer (Linux / macOS)
├── README.md         # English docs
├── README.zh.md      # Chinese docs
└── lib/
    ├── index.js      # host half: registers the delete-session command
    └── client.js     # browser half (pre-bundled client bundle)
```

## Notes

- The host half provides the `delete-session` command and the browser half provides the Delete session menu; `dsh.client` declares `platform: "web"` and its injection order.
- The hierarchy is a **read-only derivation**: workspace data is never mutated. Deleting a parent workspace simply brings its children back to the top level.
- Path comparison is case-insensitive on Windows; both `/` and `\` are accepted as separators.

## Delete session — known limitations

- DSH has no "permanently delete session" RPC (only archive), so the host half deletes the JSONL backend's per-session log artifact directly (`sessionPersistence.list()`/`locate()` then `rm`).
- A session that is still live (open in the current process) may re-materialize its log if it keeps emitting events; close / restart DSH to finalize deletion of a live session.
- Deletion is triggered by running the `delete-session` command, so the session's agent must be resolvable (the browser passes the session id through `commands.execute`).

## Move session (menu + migration tool)

Moving a session is exposed two ways: the session `⋯` menu **Move to workspace** (host `move-session` command + directory picker + confirmation), and the bundled low-level script `tools/move-session.js` that performs the actual rewrite. DSH has no "move session" feature — a session's `cwd` is immutable — so the command spawns this script to rewrite the session log's `cwd` header and re-account it under the target workspace.

```bash
# list sessions under a workspace (find the exact name)
node tools/move-session.js --list "<workspace path>"

# dry-run (validates, writes nothing)
node tools/move-session.js "<session path>" "<session name>" "<target workspace path>"

# actually move
node tools/move-session.js "<session path>" "<session name>" "<target workspace path>" --apply
```

The storage locations can be overridden with env vars when needed:

- `DSH_SESSION_ROOT` (default `~/.dsh/sessions`)
- `DSH_STORAGE_DIR` (default `~/.dsh/storages`)
- `DSH_MIGRATE_BACKUP_DIR` (backup location)

The script validates everything, writes a backup, and only mutates with `--apply`. Restart `dsh web` afterwards.
