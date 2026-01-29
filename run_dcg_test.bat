@echo off
cd /d "%~dp0"
call npm exec tsx scripts/test_dcg_api.ts
pause
