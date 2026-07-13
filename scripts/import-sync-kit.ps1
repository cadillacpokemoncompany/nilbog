param(
  [string]$SyncDir = $PSScriptRoot,
  [switch]$IncludeBrowserProfile,
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$syncRoot = Resolve-Path -LiteralPath $SyncDir
$appDataSource = Join-Path $syncRoot "appdata"
$targetAppData = Join-Path $env:APPDATA "NilbogLite"
$backupDir = Join-Path $targetAppData ("sync-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))

Write-Host "NilbogLite sync import"
Write-Host "Source: $syncRoot"
Write-Host "Target: $targetAppData"

Get-Process -Name "NilbogLite", "electron" -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like "*NilbogLite*" -or $_.MainWindowTitle -like "*Nilbog*" } |
  Stop-Process -Force -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force -Path $targetAppData | Out-Null
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

if (-not $SkipInstall) {
  $installer = Get-ChildItem -LiteralPath $syncRoot -Filter "NilbogLite Setup *.exe" -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($installer) {
    Write-Host "Installing $($installer.Name)..."
    Start-Process -FilePath $installer.FullName -ArgumentList "/S" -Wait
  } else {
    Write-Host "No installer found in sync folder; skipping install."
  }
}

$files = @(
  "nilbog-config.json",
  "locked-streamers.json",
  "keyword-scoring.json",
  "nilbog-discord-webhook.txt"
)

foreach ($file in $files) {
  $source = Join-Path $appDataSource $file
  $target = Join-Path $targetAppData $file
  if (-not (Test-Path -LiteralPath $source)) {
    Write-Host "Missing optional file: $file"
    continue
  }
  if (Test-Path -LiteralPath $target) {
    Copy-Item -LiteralPath $target -Destination (Join-Path $backupDir $file) -Force
  }
  Copy-Item -LiteralPath $source -Destination $target -Force
  Write-Host "Imported $file"
}

$profileSource = Join-Path $appDataSource "chromium-profile"
if ($IncludeBrowserProfile -and (Test-Path -LiteralPath $profileSource)) {
  $profileTarget = Join-Path $targetAppData "chromium-profile"
  Write-Host "Importing Chromium profile. If auth fails, sign in on this PC once."
  if (Test-Path -LiteralPath $profileTarget) {
    robocopy $profileTarget (Join-Path $backupDir "chromium-profile") /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  }
  robocopy $profileSource $profileTarget /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
}

Write-Host ""
Write-Host "NilbogLite sync import complete."
Write-Host "Backup saved at: $backupDir"
