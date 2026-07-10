-- AlterTable: SSO provisioning policy + env-backed secret optional
ALTER TABLE "sso_configs" ALTER COLUMN "client_secret_encrypted" DROP NOT NULL;
ALTER TABLE "sso_configs" ADD COLUMN "default_role" TEXT NOT NULL DEFAULT 'viewer';
ALTER TABLE "sso_configs" ADD COLUMN "default_group_id" TEXT;
ALTER TABLE "sso_configs" ADD COLUMN "auto_provision" BOOLEAN NOT NULL DEFAULT true;
