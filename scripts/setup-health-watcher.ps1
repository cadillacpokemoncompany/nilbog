param(
  [switch]$Discord
)

$ErrorActionPreference = "Stop"
$userData = Join-Path $env:APPDATA "NilbogLite"
$watcherDir = Join-Path $userData "watcher"
$watcherPath = Join-Path $watcherDir "nilbog-health-watcher.ps1"
$desktop = [Environment]::GetFolderPath("Desktop")
$startup = [Environment]::GetFolderPath("Startup")
$cmdPath = Join-Path $desktop "Start NilbogLite Watcher.cmd"
$startupCmdPath = Join-Path $startup "Start NilbogLite Watcher.cmd"
$taskName = "NilbogLite Health Watcher"

if (-not (Test-Path -LiteralPath $watcherPath)) {
  $localWatcher = Join-Path $PSScriptRoot "nilbog-health-watcher.ps1"
  New-Item -ItemType Directory -Force -Path $watcherDir | Out-Null
  Copy-Item -LiteralPath $localWatcher -Destination $watcherPath -Force
}

$discordArg = if ($Discord) { " -Discord" } else { "" }
Set-Content -LiteralPath $cmdPath -Encoding ASCII -Value @"
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "$watcherPath"$discordArg
"@

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$watcherPath`"$discordArg"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
$registeredTask = $false
try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "Writes NilbogLite health reports for Codex review." -Force | Out-Null
  $registeredTask = $true
} catch {
  Copy-Item -LiteralPath $cmdPath -Destination $startupCmdPath -Force
}

Write-Host "NilbogLite watcher installed."
Write-Host "Desktop launcher: $cmdPath"
if ($registeredTask) {
  Write-Host "Task Scheduler: $taskName"
} else {
  Write-Host "Startup launcher: $startupCmdPath"
}
Write-Host "Reports:"
Write-Host "  $(Join-Path $userData 'nilbog-health-report.json')"
Write-Host "  $(Join-Path $userData 'nilbog-health-summary.txt')"
