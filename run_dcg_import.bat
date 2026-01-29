
@echo off
cd /d "%~dp0"
echo ==========================================
echo      DCG MENU ITEM IMPORT WIZARD
echo ==========================================
echo.
echo [1/3] Updating Database Schema (Adding dcg_id and label_text)...
call npm exec prisma db push -- --accept-data-loss
if %ERRORLEVEL% NEQ 0 (
    echo ❌ DB Push Failed!
    pause
    exit /b
)

echo.
echo [2/3] Installing CSV Parser...
call npm install csv-parse
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Install Failed!
    pause
    exit /b
)

echo.
echo [3/3] Running Import Script...
call npm exec tsx scripts/import_dcg_csv.ts

echo.
echo ==========================================
echo      IMPORT COMPLETE!
echo ==========================================
pause
