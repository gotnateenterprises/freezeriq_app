@echo off
cd /d "%~dp0"
echo Running Migration for Bundle Scaling...
call npx prisma migrate dev --name add_bundle_scaling_fields
if %ERRORLEVEL% NEQ 0 (
    echo Migration Failed.
    pause
    exit /b %ERRORLEVEL%
)
echo Migration Successful!
pause
