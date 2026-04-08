-- AlterTable: User JIT UID
ALTER TABLE "users" ADD COLUMN "jit_uid" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "user_org_jit_uid_unique" ON "users"("org_id", "jit_uid");

-- AlterTable: AccessPolicy — OS provisioning + feature flags
ALTER TABLE "access_policies" ADD COLUMN "os_provisioning" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "access_policies" ADD COLUMN "allow_key_download" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "access_policies" ADD COLUMN "is_break_glass" BOOLEAN NOT NULL DEFAULT false;
