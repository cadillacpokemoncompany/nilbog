$currentPid = $PID
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$nilbogElectron = Join-Path $repoRoot "node_modules\electron\dist\electron.exe"
$nilbogAdb = Join-Path $repoRoot "adb.exe"

if (Test-Path $nilbogAdb) {
  & $nilbogAdb kill-server 2>$null | Out-Null
}

$processes = Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne $currentPid -and (
    ($_.ExecutablePath -and $_.ExecutablePath -ieq $nilbogElectron) -or
    ($_.ExecutablePath -and $_.ExecutablePath -ieq $nilbogAdb) -or
    $_.CommandLine -match "vite --host 127\.0\.0\.1 --port 5187" -or
    $_.CommandLine -match "wait-on tcp:5187" -or
    $_.CommandLine -match "concurrently.*5187" -or
    $_.CommandLine -match "electron \."
  )
}

$processes | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

$listeners = Get-NetTCPConnection -LocalPort 5187 -ErrorAction SilentlyContinue |
  Where-Object { $_.OwningProcess -ne 0 } |
  Select-Object -ExpandProperty OwningProcess -Unique

$listeners | ForEach-Object {
  Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
}
