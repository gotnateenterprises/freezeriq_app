-- Temporarily drop the foreign key constraint for testing
ALTER TABLE "tenant_branding" DROP CONSTRAINT IF EXISTS "tenant_branding_user_id_fkey";
