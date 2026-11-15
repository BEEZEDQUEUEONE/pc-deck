@echo off
cd /d "%~dp0"

if not exist "PC Deck.exe" (
  echo.
  echo   PC Deck.exe is not here yet.
  echo   Build it with:  cargo build --release
  echo   then copy target\release\pc-deck.exe next to this file.
  echo.
  pause
  exit /b 1
)

start "" "PC Deck.exe"
