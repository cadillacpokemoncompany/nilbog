$ErrorActionPreference = "Continue"

$userData = Join-Path $env:APPDATA "NilbogLite"
$sourceLog = Join-Path $userData "nilbog-debug.log"
$watchLog = Join-Path $userData "krakenhits-uuid-watch.log"
$pidFile = Join-Path $userData "krakenhits-uuid-watch.pid"

New-Item -ItemType Directory -Path $userData -Force | Out-Null
Set-Content -LiteralPath $pidFile -Value $PID -Encoding UTF8

function Write-Watch {
  param([string]$Message)
  Add-Content -LiteralPath $watchLog -Value ("[{0}] {1}" -f (Get-Date).ToString("o"), $Message) -Encoding UTF8
}

Write-Watch "watcher started pid=$PID source=$sourceLog"

$lastUuid = $null
$lastOnlineAt = $null
$missCount = 0

while (-not (Test-Path -LiteralPath $sourceLog)) {
  Write-Watch "waiting for Nilbog debug log"
  Start-Sleep -Seconds 5
}

Get-Content -LiteralPath $sourceLog -Wait -Tail 200 | ForEach-Object {
  $line = [string]$_

  if ($line -match "feed matched ONLINE KrakenHits -> https://www\.whatnot\.com/live/([0-9a-fA-F-]+)") {
    $uuid = $Matches[1].ToLowerInvariant()
    $lastOnlineAt = Get-Date
    $missCount = 0

    if (-not $lastUuid) {
      Write-Watch "KrakenHits ONLINE uuid=$uuid"
    } elseif ($uuid -ne $lastUuid) {
      Write-Watch "KrakenHits UUID CHANGED old=$lastUuid new=$uuid"
    } else {
      Write-Watch "KrakenHits still online uuid=$uuid"
    }

    $lastUuid = $uuid
    return
  }

  if ($line -match "feed did not match KrakenHits") {
    $missCount += 1
    $displayUuid = if ($lastUuid) { $lastUuid } else { "none" }
    Write-Watch "KrakenHits not matched miss_count=$missCount last_uuid=$displayUuid"
    return
  }

  if ($line -match "card:send-to-devices slot=\d+ streamer=KrakenHits url=https://www\.whatnot\.com/live/([0-9a-fA-F-]+)") {
    $sentUuid = $Matches[1].ToLowerInvariant()
    $freshness = if ($lastUuid -and $sentUuid -eq $lastUuid) { "matches_latest" } elseif ($lastUuid) { "STALE expected=$lastUuid" } else { "no_latest_seen" }
    Write-Watch "KrakenHits SEND uuid=$sentUuid $freshness"
    return
  }
}
