@echo off
cd /d "%~dp0"
call npm exec tsx scripts/verify_import.ts
pause
