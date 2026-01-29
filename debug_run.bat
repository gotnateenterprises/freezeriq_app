@echo off
cd /d "%~dp0"
call npx tsx scripts/debug_production.ts
pause
