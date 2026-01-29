@echo off
cd /d "%~dp0"
call npx tsx scripts/simulate_qbo_invoice.ts
pause
