@echo off
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 LTS is required.
  pause
  exit /b 1
)
node "%~dp0scripts\launcher.mjs" stop
pause
