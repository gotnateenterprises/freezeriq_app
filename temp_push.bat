@echo off
set "PATH=%PATH%;C:\Program Files\nodejs"
"C:\Program Files\nodejs\node.exe" "C:\Program Files\nodejs\node_modules\npm\bin\npx-cli.js" prisma db push
