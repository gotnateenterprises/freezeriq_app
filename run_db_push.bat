
@echo off
cd /d "%~dp0"
echo Applying Database Schema Changes...
call npm exec prisma db push
echo.
echo Changes Applied.
pause
