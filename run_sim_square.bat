@echo off
set "PATH=%PATH%;C:\Program Files\nodejs"
call npm exec tsx scripts/simulate_square_order.ts
pause
