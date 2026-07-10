-- CreateTable: application-wide object storage configuration (global singleton)
CREATE TABLE "storage_configs" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "provider" TEXT NOT NULL DEFAULT 'minio',
    "endpoint" TEXT,
    "region" TEXT,
    "bucket" TEXT,
    "access_key" TEXT,
    "secret_key_encrypted" TEXT,
    "use_ssl" BOOLEAN NOT NULL DEFAULT false,
    "force_path_style" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "storage_configs_scope_key" ON "storage_configs"("scope");
