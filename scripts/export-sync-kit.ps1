param(
  [string]$SyncDir,
  [switch]$IncludeBrowserProfile
)

$ErrorActionPreference = "Stop"

$repoDir = Resolve-Path (Join-Path $PSScriptRoot "..")
$packageJson = Get-Content -LiteralPath (Join-Path $repoDir "package.json") -Raw | ConvertFrom-Json
$version = [string]$packageJson.version

if (-not $SyncDir) {
  $desktop = if ($env:OneDrive -and (Test-Path -LiteralPath (Join-Path $env:OneDrive "Desktop"))) {
    Join-Path $env:OneDrive "Desktop"
  } else {
    [Environment]::GetFolderPath("Desktop")
  }
  $SyncDir = Join-Path $desktop "NilbogLite-Sync"
}

$syncRoot = New-Item -ItemType Directory -Force -Path $SyncDir
$appDataTarget = New-Item -ItemType Directory -Force -Path (Join-Path $syncRoot.FullName "appdata")
$sourceAppData = Join-Path $env:APPDATA "NilbogLite"

$installer = Join-Path "C:\outputs\NilbogLite" "NilbogLite Setup $version.exe"
if (Test-Path -LiteralPath $installer) {
  Copy-Item -LiteralPath $installer -Destination (Join-Path $syncRoot.FullName "NilbogLite Setup $version.exe") -Force
}

$manifest = Join-Path "C:\outputs\NilbogLite" "latest.json"
if (Test-Path -LiteralPath $manifest) {
  Copy-Item -LiteralPath $manifest -Destination (Join-Path $syncRoot.FullName "latest.json") -Force
}

$files = @(
  "nilbog-config.json",
  "locked-streamers.json",
  "keyword-scoring.json",
  "nilbog-discord-webhook.txt"
)

foreach ($file in $files) {
  $source = Join-Path $sourceAppData $file
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $appDataTarget.FullName $file) -Force
  }
}

if ($IncludeBrowserProfile) {
  $profileSource = Join-Path $sourceAppData "chromium-profile"
  $profileTarget = Join-Path $appDataTarget.FullName "chromium-profile"
  if (Test-Path -LiteralPath $profileSource) {
    robocopy $profileSource $profileTarget /MIR /XD "Cache" "Code Cache" "GPUCache" "DawnCache" "DawnGraphiteCache" "DawnWebGPUCache" /NFL /NDL /NJH /NJS /NP | Out-Null
  }
}

Copy-Item -LiteralPath (Join-Path $PSScriptRoot "import-sync-kit.ps1") -Destination (Join-Path $syncRoot.FullName "Import-NilbogLite-Sync.ps1") -Force

$cmdPath = Join-Path $syncRoot.FullName "INSTALL_OR_SYNC_THIS_PC.cmd"
$includeProfileArg = if ($IncludeBrowserProfile) { " -IncludeBrowserProfile" } else { "" }
Set-Content -LiteralPath $cmdPath -Encoding ASCII -Value @"
@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Import-NilbogLite-Sync.ps1"%includeProfileArg%
pause
"@.Replace("%includeProfileArg%", $includeProfileArg)

$readmePath = Join-Path $syncRoot.FullName "README.txt"
Set-Content -LiteralPath $readmePath -Encoding UTF8 -Value @"
NilbogLite sync kit

Run INSTALL_OR_SYNC_THIS_PC.cmd on another PC signed into this same OneDrive account.

This imports:
- NilbogLite installer $version
- nilbog-config.json
- locked-streamers.json
- keyword-scoring.json
- nilbog-discord-webhook.txt

Browser auth/profile is optional. If it was included and auth still fails, sign in on that PC once.
"@

Write-Host "NilbogLite sync kit ready:"
Write-Host $syncRoot.FullName
