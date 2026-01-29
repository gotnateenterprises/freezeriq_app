@echo off
set "PATH=%PATH%;C:\Program Files\nodejs"
call npm exec tsx check_bundles.ts
pause
