@echo off
echo Starting Backup...
pushd "C:\Users\nate4\OneDrive\Documents\AntiGravity Files\freezeriq_app" || (
    echo Error: Could not find project directory.
    pause
    exit /b 1
)

call npm run db:backup
if errorlevel 1 (
    echo Backup Failed!
) else (
    echo Backup Completed Successfully.
)

popd
pause
