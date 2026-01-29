
@echo off
cd /d "%~dp0"
echo Running Duplicate Ingredient Fixer...
call npm exec tsx scripts/fix_duplicates.ts
echo.
echo Process Complete.
pause
