
@echo off
cd /d "%~dp0"
echo Starting FreezerIQ App...
call npm run dev
if errorlevel 1 (
    echo.
    echo Server crashed.
    pause
)
