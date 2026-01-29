@echo off
echo Seeding Orders...
set "DATABASE_URL=postgresql://postgres:postgres@localhost:5432/freezer_iq?schema=public"
call npx tsx scripts/seed_orders.ts
