-- CreateTable
CREATE TABLE "tenant_branding" (
    "id" SERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "business_name" TEXT NOT NULL DEFAULT 'Freezer Chef',
    "logo_url" TEXT,
    "primary_color" TEXT NOT NULL DEFAULT '#10b981',
    "secondary_color" TEXT NOT NULL DEFAULT '#6366f1',
    "accent_color" TEXT NOT NULL DEFAULT '#f59e0b',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_branding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_branding_user_id_key" ON "tenant_branding"("user_id");

-- AddForeignKey
ALTER TABLE "tenant_branding" ADD CONSTRAINT "tenant_branding_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
