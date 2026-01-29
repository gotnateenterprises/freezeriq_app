
@echo off
cd /d "%~dp0"
echo Running Category Migration...
call npx tsx scripts/migrate_categories.ts
echo.
echo Migration Complete!
pause
