@echo off
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 LTS is required. Install it from https://nodejs.org/
  pause
  exit /b 1
)
node "%~dp0scripts\launcher.mjs" start
if errorlevel 1 pause
