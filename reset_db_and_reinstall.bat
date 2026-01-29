@echo off
setlocal EnableExtensions EnableDelayedExpansion

echo === reset_and_run.bat: starting ===
echo.
echo WARNING: This script will WIPE ALL DATA and reinstall dependencies.
echo Press Ctrl+C to cancel or wait 5 seconds to proceed...
timeout /t 5


pushd "C:\Users\nate4\OneDrive\Documents\AntiGravity Files\freezeriq_app" || (
  echo Project directory not found: C:\Users\nate4\OneDrive\Documents\AntiGravity Files\freezeriq_app
  exit /b 1
)

if exist "node_modules" (
  echo Removing node_modules...
  rd /s /q "node_modules"
) else (
  echo node_modules not present.
)

if exist "package-lock.json" (
  echo Removing package-lock.json...
  del /f /q "package-lock.json"
) else (
  echo package-lock.json not present.
)

echo Installing dependencies...
call npm install
if errorlevel 1 (
  echo npm install failed with exit code %ERRORLEVEL% && popd && exit /b %ERRORLEVEL%
)

echo Generating Prisma client...
call npx prisma generate
if errorlevel 1 (
  echo prisma generate failed with exit code %ERRORLEVEL% && popd && exit /b %ERRORLEVEL%
)

echo Pushing schema to database...
call npx prisma db push
if errorlevel 1 (
  echo prisma db push failed with exit code %ERRORLEVEL% && popd && exit /b %ERRORLEVEL%
)

echo Setting DATABASE_URL and running seed script...
set "DATABASE_URL=postgresql://postgres:postgres@localhost:5432/freezer_iq?schema=public"
call npx tsx scripts/seed_from_csv.ts
set "SEED_EXIT=%ERRORLEVEL%"

echo Seed script exited with %SEED_EXIT%.

echo === reset_and_run.bat: finished ===

popd
endlocal
exit /b %SEED_EXIT%