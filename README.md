# @billqiu/dsh-workspace-hierarchy

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web plugin that turns the workspace list into a **hierarchical (main / sub-workspace) tree**.

> [中文说明见 README.zh.md](./README.zh.md)

## Features

- Workspaces are nested **by directory path**: a workspace whose directory lives inside another workspace's directory is shown indented beneath it (unlimited depth).
- Only directories that are **actually added as workspaces** appear — ordinary subfolders such as `build`, `docs` are never listed.
- Each workspace's **`+` button becomes a menu** with two choices:
  - **New session** — start a session in that workspace (original behavior);
  - **Add sub-workspace** — pick a directory and register it as a sub-workspace (adds it only, without starting a session).

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
dsh plugin --profile web add @billqiu/dsh-workspace-hierarchy
```

**2.** Edit `~/.dsh/profiles/web/cordis.patch.yml` (`C:\Users\<you>\.dsh\profiles\web\cordis.patch.yml` on Windows) and add:

```yaml
# Disable the built-in workspace browser (replaced by this plugin).
- id: ui-workspace
  disabled: true

# Mount the hierarchical workspace browser.
- insert:
    - id: ui-workspace-hierarchy
      name: '@billqiu/dsh-workspace-hierarchy'
```

**3.** Restart `dsh web` (or the desktop app) and refresh the browser.

## Publishing to npm

```bash
npm publish --access public
```

## Repository structure

```
@billqiu/dsh-workspace-hierarchy/
├── package.json      # dsh.client declaration, peerDependencies, exports
├── install.ps1       # one-click installer (Windows)
├── install.sh        # one-click installer (Linux / macOS)
├── README.md         # English docs
├── README.zh.md      # Chinese docs
└── lib/
    ├── index.js      # host half (no-op; pure UI plugin)
    └── client.js     # browser half (pre-bundled client bundle)
```

## Notes

- Pure web client plugin — no host-side logic. `dsh.client` declares `platform: "web"` and its injection order.
- The hierarchy is a **read-only derivation**: workspace data is never mutated. Deleting a parent workspace simply brings its children back to the top level.
- Path comparison is case-insensitive on Windows; both `/` and `\` are accepted as separators.
