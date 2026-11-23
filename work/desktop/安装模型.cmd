@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-DoNote-Models.ps1" %*
set "DO_MODEL_ERR=%ERRORLEVEL%"
if not "%DO_MODEL_ERR%"=="0" (
  echo.
  echo ??????????? %DO_MODEL_ERR%?
)
echo.
echo ????????...
pause >nul
endlocal