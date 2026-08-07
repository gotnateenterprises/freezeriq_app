-- Phase A: Add fundraiser_hold to OrderStatus enum
-- This is an additive enum change that does not affect existing rows.
-- Fundraiser orders created after this migration will use 'fundraiser_hold' instead of 'pending',
-- making them invisible to production queries that filter by 'pending' or 'production_ready'.

ALTER TYPE "OrderStatus" ADD VALUE 'fundraiser_hold';
