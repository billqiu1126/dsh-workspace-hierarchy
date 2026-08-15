# dsh-workspace-hierarchy — one-click installer (Windows / PowerShell)
#
# Usage:
#   .\install.ps1                                  # install from npm registry
#   .\install.ps1 -Package ./pkg-0.1.0.tgz         # install a local tarball
#   .\install.ps1 -Profile tui                     # target a different profile
#
# This does BOTH steps for you:
#   1) installs the plugin package into the profile (via `dsh plugin add`);
#   2) writes the required entries into the profile's cordis.patch.yml.
# If you prefer to do it by hand instead, follow the "Manual install" section
# in README.md — the two are alternatives, pick one.

param(
    [string]$Package = "@billqiu/dsh-workspace-hierarchy",
    [string]$Profile = "web",
    [string]$DshHome = ""
)

$ErrorActionPreference = "Stop"

# --- Resolve the dsh home directory -----------------------------------------
if ($DshHome -eq "") {
    if ($env:DSH_HOME) {
        $DshHome = $env:DSH_HOME
    } else {
        $DshHome = Join-Path $HOME ".dsh"
    }
}

$profileDir = Join-Path $DshHome "profiles\$Profile"
$patchFile  = Join-Path $profileDir "cordis.patch.yml"

Write-Host ""
Write-Host "dsh-workspace-hierarchy installer" -ForegroundColor Cyan
Write-Host "  profile dir : $profileDir" -ForegroundColor DarkGray
Write-Host "  package     : $Package" -ForegroundColor DarkGray
Write-Host ""

# --- 1) Install the plugin package into the profile -------------------------
if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
    throw "`dsh` CLI not found on PATH. Install DeepSeek Harness first: npm i -g @deepseek-ai/dsh"
}

Write-Host "==> Installing package into profile..." -ForegroundColor Cyan
dsh plugin --profile $Profile add $Package
if ($LASTEXITCODE -ne 0) {
    throw "`dsh plugin add` failed (exit $LASTEXITCODE)."
}

# --- 2) Update cordis.patch.yml (idempotent) --------------------------------
if (-not (Test-Path -LiteralPath $patchFile)) {
    Write-Host "==> cordis.patch.yml not found; creating a fresh one." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
    Set-Content -LiteralPath $patchFile -Value "[]`n" -Encoding UTF8
}

$content = Get-Content -Raw -LiteralPath $patchFile
$marker  = "@billqiu/dsh-workspace-hierarchy"

if ($content.Contains($marker)) {
    Write-Host "==> cordis.patch.yml already contains the plugin entries — skipping." -ForegroundColor Green
} else {
    $entries = @"
# Disable the built-in workspace browser (replaced by this plugin).
- id: ui-workspace
  disabled: true

# Mount the hierarchical workspace browser.
- insert:
    - id: ui-workspace-hierarchy
      name: '$Package'
"@

    if ($content -match '(?ms)\[\s*\]\s*$') {
        # Fresh/empty array: replace the trailing [] with the entries.
        $content = $content -replace '(?ms)\[\s*\]\s*$', $entries
        Set-Content -LiteralPath $patchFile -Value $content -Encoding UTF8
        Write-Host "==> Updated $patchFile" -ForegroundColor Green
    } else {
        # Non-empty patch: don't clobber the user's edits; print the snippet.
        Write-Warning "cordis.patch.yml already has custom entries. Add this manually:"
        Write-Host ""
        Write-Host $entries -ForegroundColor Yellow
        Write-Host ""
    }
}

Write-Host ""
Write-Host "Done. Restart `dsh web` (or the desktop app) and refresh the browser." -ForegroundColor Green
Write-Host ""
