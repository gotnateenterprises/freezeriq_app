@echo off
cd /d "%~dp0"
call npx tsx scripts/restore_db_json.ts
pause
