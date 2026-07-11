param(
  [string]$Repo = "cadillacpokemoncompany/nilbog",
  [string]$OutputDir = "C:\outputs\NilbogLite",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$repoDir = Resolve-Path (Join-Path $PSScriptRoot "..")
$packageJson = Get-Content -LiteralPath (Join-Path $repoDir "package.json") -Raw | ConvertFrom-Json
$version = [string]$packageJson.version
$tag = "v$version"
$sourceInstallerName = "NilbogLite Setup $version.exe"
$installerName = "NilbogLite.Setup.$version.exe"
$installerPath = Join-Path $OutputDir $sourceInstallerName
$uploadInstallerPath = Join-Path $OutputDir $installerName
$manifestPath = Join-Path $OutputDir "latest.json"

if (-not (Test-Path -LiteralPath $installerPath)) {
  throw "Installer not found: $installerPath. Run npm run package:win first."
}
Copy-Item -LiteralPath $installerPath -Destination $uploadInstallerPath -Force

& (Join-Path $PSScriptRoot "make-github-release-manifest.ps1") -OutputDir $OutputDir

if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "Manifest not found: $manifestPath"
}

$gh = Get-Command gh -ErrorAction SilentlyContinue
if ($gh) {
  $existing = $null
  try {
    $releaseJson = & gh release view $tag --repo $Repo --json tagName 2>$null
    if ($LASTEXITCODE -eq 0 -and $releaseJson) {
      $existing = $releaseJson | ConvertFrom-Json
    }
  } catch {
    $existing = $null
  }
  if (-not $existing) {
    if ($DryRun) {
      Write-Host "DRY RUN: gh release create $tag --repo $Repo --title $tag --notes NilbogLite $version"
    } else {
      & gh release create $tag --repo $Repo --title $tag --notes "NilbogLite $version"
    }
  }

  if ($DryRun) {
    Write-Host "DRY RUN: gh release upload $tag `"$uploadInstallerPath`" `"$manifestPath`" --repo $Repo --clobber"
  } else {
    & gh release upload $tag $uploadInstallerPath $manifestPath --repo $Repo --clobber
  }
  Write-Host "GitHub release ready: $Repo $tag"
  return
}

$token = $env:GITHUB_TOKEN
if (-not $token -and -not $DryRun) {
  throw "GitHub CLI is not installed and GITHUB_TOKEN is not set. Install gh or set a repo token before publishing."
}

$headers = @{
  Authorization = "Bearer $token"
  Accept = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
}
$apiBase = "https://api.github.com/repos/$Repo"
if ($DryRun) {
  Write-Host "DRY RUN: create/update GitHub release $Repo $tag"
  $release = [pscustomobject]@{ id = 0; upload_url = "https://uploads.github.com/repos/$Repo/releases/0/assets{?name,label}"; assets = @() }
} else {
  $release = $null
  try {
    $release = Invoke-RestMethod -Headers $headers -Uri "$apiBase/releases/tags/$tag" -Method Get
  } catch {
    $release = $null
  }
}

if (-not $release) {
  $body = @{
    tag_name = $tag
    name = $tag
    body = "NilbogLite $version"
    draft = $false
    prerelease = $false
  } | ConvertTo-Json

  if ($DryRun) {
    Write-Host "DRY RUN: create GitHub release $Repo $tag"
    $release = [pscustomobject]@{ id = 0; upload_url = "https://uploads.github.com/repos/$Repo/releases/0/assets{?name,label}"; assets = @() }
  } else {
    $release = Invoke-RestMethod -Headers $headers -Uri "$apiBase/releases" -Method Post -Body $body -ContentType "application/json"
  }
}

foreach ($asset in @($release.assets)) {
  if ($asset.name -eq $installerName -or $asset.name -eq $sourceInstallerName -or $asset.name -eq "latest.json") {
    if ($DryRun) {
      Write-Host "DRY RUN: delete existing asset $($asset.name)"
    } else {
      Invoke-RestMethod -Headers $headers -Uri "$apiBase/releases/assets/$($asset.id)" -Method Delete | Out-Null
    }
  }
}

$uploadBase = ([string]$release.upload_url).Replace("{?name,label}", "")
foreach ($file in @($uploadInstallerPath, $manifestPath)) {
  $name = [System.Uri]::EscapeDataString((Split-Path -Leaf $file))
  if ($DryRun) {
    Write-Host "DRY RUN: upload $file"
    continue
  }
  Invoke-RestMethod `
    -Headers $headers `
    -Uri "$uploadBase?name=$name" `
    -Method Post `
    -InFile $file `
    -ContentType "application/octet-stream" | Out-Null
}

Write-Host "GitHub release ready: $Repo $tag"



