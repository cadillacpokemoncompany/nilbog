param(
  [string]$OutputDir = "C:\outputs\NilbogLite"
)

$ErrorActionPreference = "Stop"

$repoDir = Resolve-Path (Join-Path $PSScriptRoot "..")
$packageJson = Get-Content -LiteralPath (Join-Path $repoDir "package.json") -Raw | ConvertFrom-Json
$version = [string]$packageJson.version
$sourceInstallerName = "NilbogLite Setup $version.exe"
$installerName = "NilbogLite.Setup.$version.exe"
$installerPath = Join-Path $OutputDir $sourceInstallerName

if (-not (Test-Path -LiteralPath $installerPath)) {
  throw "Installer not found: $installerPath"
}

$hash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = [ordered]@{
  version = $version
  installer = $installerName
  sha256 = $hash
  publishedAt = (Get-Date).ToUniversalTime().ToString("o")
  notes = "NilbogLite GitHub release update"
}

$manifestPath = Join-Path $OutputDir "latest.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), $utf8NoBom)

Write-Host "Created GitHub release manifest:"
Write-Host "  $manifestPath"
Write-Host "Upload both files to the same GitHub release:"
Write-Host "  $installerPath as $installerName"
Write-Host "  $manifestPath"


