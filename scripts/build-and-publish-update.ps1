param(
  [string]$UpdateDir = "C:\NilbogUpdates",
  [string]$DesktopDir = "C:\Users\curti\OneDrive\Desktop"
)

$ErrorActionPreference = "Stop"

$repoDir = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $repoDir
try {
  npm run package:win

  $packageJson = Get-Content -LiteralPath (Join-Path $repoDir "package.json") -Raw | ConvertFrom-Json
  $version = [string]$packageJson.version
  $installerName = "NilbogLite Setup $version.exe"
  $sourceInstaller = Join-Path "C:\outputs\NilbogLite" $installerName
  if (-not (Test-Path -LiteralPath $sourceInstaller)) {
    throw "Installer not found: $sourceInstaller"
  }

  New-Item -ItemType Directory -Force -Path $DesktopDir | Out-Null
  Copy-Item -LiteralPath $sourceInstaller -Destination (Join-Path $DesktopDir "NilbogLite Setup $version UPDATED.exe") -Force
  Copy-Item -LiteralPath $sourceInstaller -Destination (Join-Path $DesktopDir "NilbogLite Setup 0.1.0 UPDATED.exe") -Force

  & (Join-Path $PSScriptRoot "publish-update.ps1") -UpdateDir $UpdateDir
} finally {
  Pop-Location
}
