-- Phase 5G-1: Add missing canonical values to OrderStatus enum
-- This is an additive enum change that does not affect existing rows.
-- Precedent: 20260503180000_add_fundraiser_hold_status/migration.sql
--
-- in_production: canonical lowercase replacement for legacy IN_PRODUCTION.
-- ready_to_ship: new lifecycle stage displayed as "Ready for Delivery."
--
-- IF NOT EXISTS (Postgres 9.3+) makes the migration idempotent.

ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'in_production';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'ready_to_ship';
