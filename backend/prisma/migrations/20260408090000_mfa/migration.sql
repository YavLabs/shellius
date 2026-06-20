-- AlterTable: per-user MFA state
ALTER TABLE "users" ADD COLUMN "mfa_totp_secret_enc" TEXT;
ALTER TABLE "users" ADD COLUMN "mfa_totp_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "mfa_email_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "mfa_backup_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "users" ADD COLUMN "mfa_enrolled_at" TIMESTAMP(3);

-- CreateTable: per-org MFA policy
CREATE TABLE "mfa_configs" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enforced" BOOLEAN NOT NULL DEFAULT false,
    "allow_totp" BOOLEAN NOT NULL DEFAULT true,
    "allow_email_otp" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mfa_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mfa_configs_org_id_key" ON "mfa_configs"("org_id");
