@echo off
setlocal
echo Running DCG API Test...
call npx -y tsx scripts/test_dcg_api.ts
endlocal
