@echo off
cd /d "%~dp0"
call npm exec tsx scripts/simulate_square_order.ts
pause
