@echo off
cd /d "%~dp0"
set "DATABASE_URL=postgresql://postgres:postgres@localhost:5432/freezer_iq?schema=public"
echo ==========================================
echo   CLEANING & IMPORTING DATA
echo ==========================================
echo.
echo 1. Regenerating Database Client (Prisma)...
call npx prisma generate
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Prisma Generate Failed.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo 2. Running Import Script...
echo    Target DB: %DATABASE_URL%
call npx tsx scripts/seed_from_csv.ts

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Import Failed! See error above.
) else (
    echo.
    echo [SUCCESS] Data Imported Successfully!
)
pause
