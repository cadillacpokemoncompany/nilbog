@echo off
setlocal

cd /d C:\NilbogDev\NilbogLite

set "PATH=%ProgramFiles%\GitHub CLI;%PATH%"

where gh >nul 2>nul
if errorlevel 1 (
  echo GitHub CLI is not installed.
  echo Install it with:
  echo winget install --id GitHub.cli -e --source winget --accept-source-agreements --accept-package-agreements
  pause
  exit /b 1
)

gh auth status >nul 2>nul
if errorlevel 1 (
  echo GitHub login is required once on this PC.
  echo Follow the browser/device-code prompts, then this window will publish the NilbogLite update.
  gh auth login --hostname github.com --git-protocol https --web --skip-ssh-key
  if errorlevel 1 (
    echo GitHub login failed.
    pause
    exit /b 1
  )
)

npm run release:github
if errorlevel 1 (
  echo Publish failed.
  pause
  exit /b 1
)

echo.
echo NilbogLite GitHub update published successfully.
pause
