@echo off
echo Checking Ingredients...
call npm exec tsx scripts/check_ingredients.ts
pause
