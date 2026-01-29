@echo off
cd /d "%~dp0"
call npm exec tsx scripts/check_types.ts
pause
