@echo off
cd /d "%~dp0"
echo Sorting Recipes into Categories...
call npm exec -y tsx scripts/sort_recipes.ts
if errorlevel 1 (
    echo.
    echo Sorting Failed.
    pause
) else (
    echo.
    echo Sorting Complete!
    pause
)
