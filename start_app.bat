@echo off
setlocal EnableExtensions EnableDelayedExpansion

echo === start_app.bat: Safe Startup ===

pushd "C:\Users\nate4\OneDrive\Documents\AntiGravity Files\freezeriq_app" || (
  echo Project directory not found.
  exit /b 1
)

echo Installing dependencies (fast check)...
call npm install
if errorlevel 1 (
  echo npm install failed && popd && exit /b %ERRORLEVEL%
)

echo Generating Prisma client...
call npx prisma generate

echo Starting Next.js Dev Server...
call npm run dev

popd
endlocal
