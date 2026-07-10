param(
  [string]$UpdateDir = "C:\NilbogUpdates"
)

$ErrorActionPreference = "Stop"

$packagePath = Join-Path $PSScriptRoot "..\package.json"
$packageJson = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
$version = [string]$packageJson.version
$installerName = "NilbogLite Setup $version.exe"
$sourceInstaller = Join-Path "C:\outputs\NilbogLite" $installerName

if (-not (Test-Path -LiteralPath $sourceInstaller)) {
  throw "Installer not found: $sourceInstaller"
}

New-Item -ItemType Directory -Force -Path $UpdateDir | Out-Null

$destInstaller = Join-Path $UpdateDir $installerName
Copy-Item -LiteralPath $sourceInstaller -Destination $destInstaller -Force

$hash = (Get-FileHash -LiteralPath $destInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = [ordered]@{
  version = $version
  installer = $installerName
  sha256 = $hash
  publishedAt = (Get-Date).ToUniversalTime().ToString("o")
  notes = "NilbogLite auto update package"
}

$manifestPath = Join-Path $UpdateDir "latest.json"
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

Write-Host "Published NilbogLite $version"
Write-Host "Installer: $destInstaller"
Write-Host "Manifest:  $manifestPath"
