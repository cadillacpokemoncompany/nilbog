param(
  [string]$UpdateDir = "C:\NilbogUpdates",
  [string]$ShareName = "NilbogUpdates"
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)

if (-not $isAdmin) {
  throw "Run this script from an elevated PowerShell window so Windows can create the SMB share."
}

New-Item -ItemType Directory -Force -Path $UpdateDir | Out-Null
$acl = Get-Acl -LiteralPath $UpdateDir
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
  "Everyone",
  "ReadAndExecute, ListDirectory, Read",
  "ContainerInherit, ObjectInherit",
  "None",
  "Allow"
)
$acl.SetAccessRule($rule)
Set-Acl -LiteralPath $UpdateDir -AclObject $acl

$existing = Get-SmbShare -Name $ShareName -ErrorAction SilentlyContinue
if ($existing) {
  if ($existing.Path -ne $UpdateDir) {
    throw "Share '$ShareName' already exists at '$($existing.Path)', not '$UpdateDir'."
  }
} else {
  New-SmbShare -Name $ShareName -Path $UpdateDir -ReadAccess "Everyone" -Description "NilbogLite app updates" | Out-Null
}

Write-Host "Nilbog update share is ready:"
Write-Host "\\$env:COMPUTERNAME\$ShareName"
