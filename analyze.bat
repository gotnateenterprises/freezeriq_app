@echo off
cd /d "%~dp0"
call npm exec tsx scripts/analyze_matches.ts
pause
