@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required. Install Node.js 24 LTS from https://nodejs.org/en/download
  pause
  exit /b 1
)
node scripts\launcher.mjs
if errorlevel 1 pause
