
@echo off
cd /d "%~dp0"
echo Updating Database Schema and Client...

echo 1. Generating Prisma Client...
echo 1. Generating Prisma Client...
call npx prisma generate

echo 2. Pushing Schema to Database...
call npx prisma db push

echo.
echo Database Updated!
pause
