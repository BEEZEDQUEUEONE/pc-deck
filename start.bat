@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js 18.17 or newer is required.
  echo   Install it from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

if /I "%~1"=="--no-browser" goto run

start "" /min cmd /c "timeout /t 2 >nul && start http://127.0.0.1:4317"

:run
node server/index.js
