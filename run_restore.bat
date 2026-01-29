@echo off
setlocal EnableDelayedExpansion

echo ==========================================
echo       FreezerIQ App: Restore Database
echo ==========================================
echo.
echo WARNING: This will DELETE your current database and
echo restore the LATEST backup file found in the 'backups' folder.
echo.
echo Are you sure you want to continue?
echo.
set /p "Choice=Type 'yes' to restore (or anything else to cancel): "

if /i not "%Choice%"=="yes" (
    echo Restore cancelled.
    pause
    exit /b 0
)

echo.
echo Starting Restore Process...
echo.

pushd "C:\Users\nate4\OneDrive\Documents\AntiGravity Files\freezeriq_app" || (
    echo Error: Could not find project directory.
    pause
    exit /b 1
)

call npm run db:restore
if errorlevel 1 (
    echo Restore Failed!
) else (
    echo Restore Completed Successfully.
)

popd
pause
