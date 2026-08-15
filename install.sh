#!/usr/bin/env bash
# dsh-workspace-hierarchy — one-click installer (Linux / macOS)
#
# Usage:
#   ./install.sh                                 # install from npm registry
#   ./install.sh ./pkg-0.1.0.tgz                 # install a local tarball
#   PROFILE=tui ./install.sh                     # target a different profile
#
# This does BOTH steps for you:
#   1) installs the plugin package into the profile (via `dsh plugin add`);
#   2) writes the required entries into the profile's cordis.patch.yml.
# If you prefer to do it by hand instead, follow the "Manual install" section
# in README.md — the two are alternatives, pick one.

set -euo pipefail

PACKAGE="${1:-@billqiu/dsh-workspace-hierarchy}"
PROFILE="${PROFILE:-web}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"

PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

echo
echo "dsh-workspace-hierarchy installer"
echo "  profile dir : $PROFILE_DIR"
echo "  package     : $PACKAGE"
echo

# --- 1) Install the plugin package into the profile -------------------------
if ! command -v dsh >/dev/null 2>&1; then
    echo "error: 'dsh' CLI not found on PATH. Install DeepSeek Harness first: npm i -g @deepseek-ai/dsh" >&2
    exit 1
fi

echo "==> Installing package into profile..."
dsh plugin --profile "$PROFILE" add "$PACKAGE"

# --- 2) Update cordis.patch.yml (idempotent) --------------------------------
if [ ! -f "$PATCH_FILE" ]; then
    echo "==> cordis.patch.yml not found; creating a fresh one."
    mkdir -p "$PROFILE_DIR"
    printf '[]\n' > "$PATCH_FILE"
fi

if grep -q "@billqiu/dsh-workspace-hierarchy" "$PATCH_FILE"; then
    echo "==> cordis.patch.yml already contains the plugin entries — skipping."
elif grep -Eq '^[[:space:]]*\[\][[:space:]]*$' "$PATCH_FILE"; then
    # Fresh/empty array: write the entries (replaces the boilerplate header).
    cat > "$PATCH_FILE" <<EOF
# dsh profile patch layer
# Disable the built-in workspace browser (replaced by this plugin).
- id: ui-workspace
  disabled: true

# Mount the hierarchical workspace browser.
- insert:
    - id: ui-workspace-hierarchy
      name: '$PACKAGE'
EOF
    echo "==> Updated $PATCH_FILE"
else
    echo "warning: cordis.patch.yml already has custom entries. Add this manually:"
    echo
    cat <<EOF
# Disable the built-in workspace browser (replaced by this plugin).
- id: ui-workspace
  disabled: true

# Mount the hierarchical workspace browser.
- insert:
    - id: ui-workspace-hierarchy
      name: '$PACKAGE'
EOF
    echo
fi

echo
echo "Done. Restart 'dsh web' (or the desktop app) and refresh the browser."
echo
