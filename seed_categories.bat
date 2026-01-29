@echo off
cd /d "%~dp0"
echo Seeding Categories...
call npm exec tsx scripts/seed_categories.ts
if errorlevel 1 (
    echo.
    echo Seeding Failed.
    pause
) else (
    echo.
    echo Seeding Complete!
    pause
)
