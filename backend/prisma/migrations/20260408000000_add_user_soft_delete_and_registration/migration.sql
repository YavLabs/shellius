-- AlterTable: add password_changed_at and deleted_at columns to users
ALTER TABLE "users" ADD COLUMN "password_changed_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "deleted_at" TIMESTAMP(3);

-- Add new enum values via ALTER TYPE (IF NOT EXISTS is PG 9.6+ safe)
ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'pending_verification';
ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'deleted';

-- AlterTable: add self_service_registration_enabled to organizations
ALTER TABLE "organizations" ADD COLUMN "self_service_registration_enabled" BOOLEAN NOT NULL DEFAULT false;
