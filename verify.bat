@echo off
set "PATH=%PATH%;C:\Program Files\nodejs"
call npm exec tsx verify_order_db.ts
pause
