@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0node.exe" goto bundled
where node >nul 2>nul || (
  echo Node.js is required to start this service.
  pause
  exit /b 1
)
node server.mjs
goto done

:bundled
set "ANALOG_BIND=127.0.0.1"
set "ANALOG_ADMIN_TOKEN="
set "ANALOG_ALLOWED_ORIGINS="
set "ANALOG_DESKTOP_MANAGED="
set "NODE_OPTIONS="
set "NODE_PATH="
powershell -NoProfile -Command "$root = Split-Path -Parent (Get-Location).Path; if (-not $env:ANALOG_DATA_DIR) { $location = Join-Path $root 'data-location.txt'; $data = if (Test-Path -LiteralPath $location) { (Get-Content -Raw -Encoding UTF8 -LiteralPath $location).Trim() } else { Join-Path $root 'Data' }; $env:ANALOG_DATA_DIR = Join-Path $data 'AiBridge' }; & .\node.exe .\server.mjs"

:done
pause
