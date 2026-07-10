param(
  [int]$Minutes = 60,
  [int]$IntervalSeconds = 15
)

$ErrorActionPreference = "SilentlyContinue"
$userData = Join-Path $env:APPDATA "NilbogLite"
$configPath = Join-Path $userData "nilbog-config.json"
$debugPath = Join-Path $userData "nilbog-debug.log"
$notesPath = Join-Path $userData "nilbog-watch-notes.log"
$statePath = Join-Path $userData "nilbog-watch-state.json"
$startedAt = Get-Date
$stopAt = $startedAt.AddMinutes($Minutes)

function Write-Note {
  param([string]$Message)
  $line = "[{0:O}] {1}" -f (Get-Date), $Message
  Add-Content -Path $notesPath -Value $line -Encoding UTF8
}

function ShortUrl {
  param($Url)
  if (-not $Url) { return "" }
  $value = [string]$Url
  if ($value.Length -le 96) { return $value }
  return $value.Substring(0, 96)
}

if (Test-Path $statePath) {
  Remove-Item -LiteralPath $statePath -Force
}

Write-Note "watch started minutes=$Minutes intervalSeconds=$IntervalSeconds"

$previous = $null
$lastDebugPosition = 0
if (Test-Path $debugPath) {
  $lastDebugPosition = (Get-Item $debugPath).Length
}

while ((Get-Date) -lt $stopAt) {
  try {
    if (Test-Path $configPath) {
      $snapshot = Get-Content $configPath -Raw | ConvertFrom-Json
      $clicker = $snapshot.autoClicker
      $cards = @($snapshot.cards)
      $liveCards = @($cards | Where-Object { $_.status -eq "live" })
      $targetCard = $null
      if ($null -ne $clicker.activeSlot) {
        $targetCard = $cards | Where-Object { $_.slot -eq $clicker.activeSlot } | Select-Object -First 1
      }
      $current = [ordered]@{
        runtimeState = [string]$clicker.runtimeState
        runtimeDetail = [string]$clicker.runtimeDetail
        lastAction = [string]$clicker.lastAction
        activeSlot = if ($null -eq $clicker.activeSlot) { "" } else { [string]$clicker.activeSlot }
        targetStreamer = if ($targetCard) { [string]$targetCard.streamer } else { "" }
        targetUrl = if ($targetCard) { [string]$targetCard.resolvedUrl } else { "" }
        targetUuid = if ($targetCard) { [string]$targetCard.streamUuid } else { "" }
        matchedScore = if ($null -eq $clicker.matchedScore) { "" } else { [string]$clicker.matchedScore }
        lastTapAt = [string]$clicker.adbHealth.lastTapAt
        lastTapDevice = [string]$clicker.adbHealth.lastTapDevice
        lastError = [string]$clicker.adbHealth.lastError
        selectedConnected = [string]$clicker.adbHealth.selectedConnected
        connected = [string]$clicker.adbHealth.connected
        intervalMs = [string]$clicker.intervalMs
        jitterMs = [string]$clicker.jitterMs
        liveSummary = (($liveCards | ForEach-Object { "{0}:{1}:{2}:{3}" -f $_.streamer,$_.streamUuid,$_.status,$_.giveawayName }) -join " | ")
      }

      if ($null -eq $previous) {
        Write-Note ("initial state={0} detail={1} active={2} url={3} devices={4}/{5} intervalMs={6} jitterMs={7}" -f $current.runtimeState,$current.runtimeDetail,$current.targetStreamer,(ShortUrl $current.targetUrl),$current.selectedConnected,$current.connected,$current.intervalMs,$current.jitterMs)
      } else {
        foreach ($key in @("runtimeState","runtimeDetail","lastAction","activeSlot","targetUrl","targetUuid","matchedScore","lastTapAt","lastError","liveSummary")) {
          if ([string]$previous[$key] -ne [string]$current[$key]) {
            if ($key -eq "lastTapAt" -and $previous.lastTapAt -and $current.lastTapAt) {
              $gap = ([datetime]$current.lastTapAt - [datetime]$previous.lastTapAt).TotalSeconds
              Write-Note ("tap changed gapSeconds={0:N1} device={1} active={2} detail={3}" -f $gap,$current.lastTapDevice,$current.targetStreamer,$current.runtimeDetail)
            } elseif ($key -eq "targetUrl") {
              Write-Note ("target url changed active={0} url={1}" -f $current.targetStreamer,(ShortUrl $current.targetUrl))
            } elseif ($key -eq "liveSummary") {
              Write-Note ("live summary changed {0}" -f $current.liveSummary)
            } else {
              Write-Note ("{0} changed old='{1}' new='{2}'" -f $key,$previous[$key],$current[$key])
            }
          }
        }
      }

      $previous = $current
      $current | ConvertTo-Json -Depth 5 | Set-Content -Path $statePath -Encoding UTF8
    } else {
      Write-Note "config missing: $configPath"
    }

    if (Test-Path $debugPath) {
      $item = Get-Item $debugPath
      if ($item.Length -lt $lastDebugPosition) {
        $lastDebugPosition = 0
      }
      if ($item.Length -gt $lastDebugPosition) {
        $stream = [System.IO.File]::Open($debugPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
          $stream.Seek($lastDebugPosition, [System.IO.SeekOrigin]::Begin) | Out-Null
          $reader = New-Object System.IO.StreamReader($stream)
          $newText = $reader.ReadToEnd()
          foreach ($line in ($newText -split "`r?`n")) {
            if ($line -match "Sent devices|Parked |autoclicker coord tap|coord tapped|feed capture browser unavailable|profile|auth|stream tab ready|giveaway WS|giveaway GraphQL|feed matched ONLINE|feed did not match|opened to FOLLOWING_FEED") {
              Write-Note ("debug {0}" -f $line)
            }
          }
        } finally {
          $stream.Close()
        }
        $lastDebugPosition = $item.Length
      }
    }
  } catch {
    Write-Note ("watch error {0}" -f $_.Exception.Message)
  }

  Start-Sleep -Seconds $IntervalSeconds
}

Write-Note "watch finished"
