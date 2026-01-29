@echo off
cd /d "%~dp0"
echo ==========================================
echo   REPAIRING DATABASE & APP ENVIRONMENT
echo ==========================================

echo 1. Installing Dependencies...
call npm install

echo 2. Generating Database Client...
call npm exec prisma generate

echo 3. Applying Database Schema Changes...
call npm exec prisma migrate dev --name fix_bundle_schema

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Migration Failed. Please check the logs above.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [SUCCESS] Environment Repaired!
echo You can now restart the server with: npm run dev
echo.
pause
