param(
  [int]$IntervalSeconds = 15,
  [switch]$Discord,
  [switch]$Once
)

$ErrorActionPreference = "SilentlyContinue"
$userData = Join-Path $env:APPDATA "NilbogLite"
$configPath = Join-Path $userData "nilbog-config.json"
$debugPath = Join-Path $userData "nilbog-debug.log"
$reportPath = Join-Path $userData "nilbog-health-report.json"
$issuePath = Join-Path $userData "nilbog-health-issues.log"
$summaryPath = Join-Path $userData "nilbog-health-summary.txt"
$watcherStatePath = Join-Path $userData "nilbog-health-watcher-state.json"
$webhookPath = Join-Path $userData "nilbog-discord-webhook.txt"
$startedAt = Get-Date

New-Item -ItemType Directory -Force -Path $userData | Out-Null

function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json } catch { return $null }
}

function Write-Issue {
  param(
    [string]$Code,
    [string]$Severity,
    [string]$Message
  )
  $line = "[{0:O}] {1} {2}: {3}" -f (Get-Date), $Severity.ToUpperInvariant(), $Code, $Message
  Add-Content -LiteralPath $issuePath -Value $line -Encoding UTF8
}

function Send-Discord {
  param([string]$Message)
  if (-not $Discord) { return }
  if (-not (Test-Path -LiteralPath $webhookPath)) { return }
  $url = (Get-Content -LiteralPath $webhookPath -Raw).Trim()
  if (-not $url) { return }
  $body = @{
    username = "Nilbog Watcher"
    content = $Message
  } | ConvertTo-Json -Depth 4
  Invoke-RestMethod -Uri $url -Method Post -Body $body -ContentType "application/json" -TimeoutSec 8 | Out-Null
}

function Get-LogTail {
  param([string]$Path, [int]$Lines = 300)
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  $stream = $null
  try {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $readBytes = [Math]::Min($stream.Length, 262144)
    $stream.Seek(-1 * $readBytes, [System.IO.SeekOrigin]::End) | Out-Null
    $buffer = New-Object byte[] $readBytes
    $null = $stream.Read($buffer, 0, $readBytes)
    $text = [System.Text.Encoding]::UTF8.GetString($buffer)
    return @(($text -split "`r?`n") | Select-Object -Last $Lines)
  } catch {
    try { return @(Get-Content -LiteralPath $Path -Tail ([Math]::Min($Lines, 80))) } catch { return @() }
  } finally {
    if ($stream) { $stream.Dispose() }
  }
}

function AgeSeconds {
  param($Iso)
  if (-not $Iso) { return $null }
  try { return [math]::Round(((Get-Date) - [datetime]$Iso).TotalSeconds, 1) } catch { return $null }
}

function Short {
  param($Value, [int]$Length = 160)
  $text = [string]$Value
  if ($text.Length -le $Length) { return $text }
  return $text.Substring(0, $Length - 3) + "..."
}

function NumberOrZero {
  param($Value)
  if ($null -eq $Value) { return 0 }
  try { return [int]$Value } catch { return 0 }
}

$state = Read-JsonFile $watcherStatePath
if (-not $state) {
  $state = [pscustomobject]@{
    lastIssueKeys = @{}
    lastDebugLength = 0
  }
}
if (-not $state.lastIssueKeys) {
  $state | Add-Member -NotePropertyName lastIssueKeys -NotePropertyValue @{} -Force
}

function Add-HealthIssue {
  param(
    [System.Collections.ArrayList]$Issues,
    [string]$Code,
    [string]$Severity,
    [string]$Message,
    [int]$CooldownSeconds = 600
  )
  $now = Get-Date
  [void]$Issues.Add([pscustomobject]@{
    code = $Code
    severity = $Severity
    message = $Message
    at = $now.ToUniversalTime().ToString("O")
  })
  $lastText = $state.lastIssueKeys.$Code
  $shouldLog = $true
  if ($lastText) {
    try {
      $last = [datetime]$lastText
      if (($now - $last).TotalSeconds -lt $CooldownSeconds) { $shouldLog = $false }
    } catch {}
  }
  if ($shouldLog) {
    $state.lastIssueKeys | Add-Member -NotePropertyName $Code -NotePropertyValue $now.ToString("O") -Force
    Write-Issue -Code $Code -Severity $Severity -Message $Message
    if ($Severity -in @("critical", "warning")) {
      Send-Discord ("NILBOG WATCHER`n{0}`n{1}" -f $Severity.ToUpperInvariant(), $Message.ToUpperInvariant())
    }
  }
}

function Invoke-WatchTick {
  $issues = New-Object System.Collections.ArrayList
  $snapshot = Read-JsonFile $configPath
  $debugTail = Get-LogTail $debugPath
  $now = Get-Date
  $nilbogProcesses = @(Get-Process -Name "NilbogLite" -ErrorAction SilentlyContinue)
  $electronProcesses = @(Get-Process -Name "electron" -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*Nilbog*" -or $_.MainWindowTitle -like "*Nilbog*" })
  $isRunning = (($nilbogProcesses.Count + $electronProcesses.Count) -gt 0)

  if (-not $snapshot) {
    Add-HealthIssue $issues "CONFIG_MISSING" "critical" "Nilbog config could not be read at $configPath"
  }

  $clicker = $snapshot.autoClicker
  $browser = $snapshot.browser
  $scanner = $snapshot.scanner
  $cards = @($snapshot.cards)
  $liveCards = @($cards | Where-Object { $_.status -eq "live" })
  $connected = NumberOrZero $clicker.adbHealth.connected
  $selectedConnected = NumberOrZero $clicker.adbHealth.selectedConnected
  $lastTapAge = AgeSeconds $clicker.adbHealth.lastTapAt
  $lastScanAge = AgeSeconds $scanner.lastTickAt
  $lastFeedAge = AgeSeconds $browser.lastFeedAt
  $lastActionAge = AgeSeconds $clicker.lastActionAt
  $lastUpdateSuccessAge = AgeSeconds $clicker.updateHealth.lastSuccessAt
  $freshLiveResolveCount = 0
  foreach ($card in $liveCards) {
    $resolvedAge = AgeSeconds $card.lastResolvedAt
    if ($resolvedAge -ne $null -and $resolvedAge -le 120) {
      $freshLiveResolveCount += 1
    }
  }
  $enabled = [bool]$clicker.enabled
  $intervalMs = NumberOrZero $clicker.intervalMs
  $expectedTapMaxAge = [math]::Max(20, [math]::Ceiling(($intervalMs / 1000) * 3))

  if (-not $isRunning) {
    Add-HealthIssue $issues "APP_NOT_RUNNING" "critical" "NilbogLite process is not running"
  }
  if ($snapshot -and $lastScanAge -ne $null -and $lastScanAge -gt 90) {
    Add-HealthIssue $issues "SCANNER_STALE" "critical" "Scanner has not ticked for $lastScanAge seconds"
  }
  if ($snapshot -and $browser.launchError) {
    Add-HealthIssue $issues "BROWSER_LAUNCH_ERROR" "critical" ("Browser launch error: " + (Short $browser.launchError))
  }
  if ($snapshot -and -not [bool]$browser.authenticated) {
    Add-HealthIssue $issues "BROWSER_NOT_AUTHED" "warning" "Browser is not marked authenticated"
  }
  if ($snapshot -and $lastFeedAge -ne $null -and $lastFeedAge -gt 180 -and ($lastScanAge -eq $null -or $lastScanAge -gt 90) -and $freshLiveResolveCount -le 0) {
    Add-HealthIssue $issues "FEED_STALE" "warning" "Followed feed image/data is $lastFeedAge seconds old"
  }
  if ($snapshot -and $enabled -and $selectedConnected -le 0) {
    Add-HealthIssue $issues "NO_CONNECTED_DEVICES" "critical" "Autoplay is running with no connected selected devices"
  }
  if ($snapshot -and $enabled -and $lastTapAge -ne $null -and $lastTapAge -gt $expectedTapMaxAge) {
    Add-HealthIssue $issues "TAP_STALE" "critical" "Autoplay is running but last tap was $lastTapAge seconds ago; expected under $expectedTapMaxAge"
  }
  $adbLastError = [string]$clicker.adbHealth.lastError
  $isRetiredAccountSwitchError = $adbLastError -match "Continue with Google|sign out|account"
  if ($snapshot -and $adbLastError -and -not $isRetiredAccountSwitchError -and ($enabled -or ($lastActionAge -ne $null -and $lastActionAge -lt 600))) {
    Add-HealthIssue $issues "ADB_HEALTH_ERROR" "warning" ("ADB health error: " + (Short $adbLastError))
  }
  if ($snapshot -and $clicker.updateHealth.status -eq "error" -and ($lastUpdateSuccessAge -eq $null -or $lastUpdateSuccessAge -gt 1800)) {
    Add-HealthIssue $issues "UPDATE_ERROR" "warning" ("Update error: " + (Short $clicker.updateHealth.lastError))
  }
  if ($snapshot -and $clicker.updateHealth.status -eq "pending") {
    Add-HealthIssue $issues "UPDATE_PENDING" "info" ("Update pending: " + $clicker.updateHealth.latestVersion)
  }

  foreach ($card in $liveCards) {
    if (-not $card.giveawayName) {
      Add-HealthIssue $issues ("GIVEAWAY_MISSING_" + $card.streamer) "warning" ("Live stream has no giveaway name: " + $card.streamer)
    }
  }

  $freshDebugCutoff = (Get-Date).AddMinutes(-5)
  $recentErrors = @($debugTail | Where-Object {
    if ($_ -notmatch "^\[(.+?)\]") { return $false }
    try {
      $lineAt = [datetime]$Matches[1]
      if ($lineAt -lt $freshDebugCutoff) { return $false }
    } catch {
      return $false
    }
    $_ -match "stream signal self-heal failed|auto update .*failed|discord notification failed|browser:launch failed|feed browser self-heal|stream tab failed|hash mismatch|auth failed|security check|TAP_STALE"
  } | Select-Object -Last 20)
  if ($recentErrors.Count -gt 0) {
    Add-HealthIssue $issues "RECENT_DEBUG_ERRORS" "warning" ("Recent debug warnings/errors: " + (Short (($recentErrors | Select-Object -Last 3) -join " | ") 320))
  }

  $report = [ordered]@{
    generatedAt = $now.ToUniversalTime().ToString("O")
    machine = $env:COMPUTERNAME
    watcherStartedAt = $startedAt.ToUniversalTime().ToString("O")
    nilbogRunning = $isRunning
    configPath = $configPath
    version = $clicker.updateHealth.currentVersion
    update = $clicker.updateHealth
    browser = @{
      authenticated = [bool]$browser.authenticated
      launched = [bool]$browser.launched
      launchStatus = $browser.launchStatus
      launchError = $browser.launchError
      lastFeedAgeSeconds = $lastFeedAge
    }
    scanner = @{
      running = [bool]$scanner.running
      lastTickAt = $scanner.lastTickAt
      lastTickAgeSeconds = $lastScanAge
    }
    autopilot = @{
      enabled = $enabled
      runtimeState = $clicker.runtimeState
      runtimeDetail = $clicker.runtimeDetail
      activeSlot = $clicker.activeSlot
      intervalMs = $intervalMs
      targetX = $clicker.targetX
      targetY = $clicker.targetY
      lastTapAt = $clicker.adbHealth.lastTapAt
      lastTapAgeSeconds = $lastTapAge
      lastActionAt = $clicker.lastActionAt
      lastActionAgeSeconds = $lastActionAge
      lastTapDevice = $clicker.adbHealth.lastTapDevice
      lastTapOk = $clicker.adbHealth.lastTapOk
      lastError = $clicker.adbHealth.lastError
    }
    devices = @{
      connected = $connected
      selectedConnected = $selectedConnected
      unauthorized = NumberOrZero $clicker.adbHealth.unauthorized
      offline = NumberOrZero $clicker.adbHealth.offline
      runtime = $clicker.deviceRuntime
    }
    streams = @($cards | ForEach-Object {
      [ordered]@{
        slot = $_.slot
        streamer = $_.streamer
        status = $_.status
        uuid = $_.streamUuid
        giveawayName = $_.giveawayName
        viewerCount = $_.viewerCount
        lastResolvedAt = $_.lastResolvedAt
        url = $_.resolvedUrl
      }
    })
    issues = @($issues)
    recentDebug = @($debugTail | Select-Object -Last 40)
  }

  $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding UTF8
  $summary = @(
    "NilbogLite Health $($report.generatedAt) $($report.machine)",
    "Running: $($report.nilbogRunning)  Version: $($report.version)  Issues: $($issues.Count)",
    "Browser: auth=$($report.browser.authenticated) status=$($report.browser.launchStatus) feedAge=$($report.browser.lastFeedAgeSeconds)s",
    "Autopilot: enabled=$($report.autopilot.enabled) state=$($report.autopilot.runtimeState) detail=$($report.autopilot.runtimeDetail)",
    "Devices: connected=$connected selected=$selectedConnected lastTapAge=$lastTapAge",
    "Live: " + (($liveCards | ForEach-Object { "$($_.streamer)=[$($_.giveawayName)]" }) -join " | "),
    "Issues:",
    (($issues | ForEach-Object { "- $($_.severity.ToUpperInvariant()) $($_.code): $($_.message)" }) -join "`r`n")
  ) -join "`r`n"
  Set-Content -LiteralPath $summaryPath -Value $summary -Encoding UTF8
  $state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $watcherStatePath -Encoding UTF8
}

do {
  Invoke-WatchTick
  if ($Once) { break }
  Start-Sleep -Seconds ([math]::Max(5, $IntervalSeconds))
} while ($true)
