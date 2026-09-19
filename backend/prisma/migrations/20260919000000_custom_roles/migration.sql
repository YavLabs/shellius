-- Custom roles: named permission sets per org. System roles are created and
-- users are linked to them at boot by roleService.syncSystemRoles() (the
-- permission catalogue lives in code, so data seeding happens there).
CREATE TABLE IF NOT EXISTS "roles" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "base_role" "OrgRole" NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "catalog_version" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "roles_org_id_key_key" ON "roles"("org_id", "key");
CREATE UNIQUE INDEX IF NOT EXISTS "roles_org_id_name_key" ON "roles"("org_id", "name");
CREATE INDEX IF NOT EXISTS "roles_org_id_idx" ON "roles"("org_id");

DO $$ BEGIN
  ALTER TABLE "roles" ADD CONSTRAINT "roles_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role_id" TEXT;
CREATE INDEX IF NOT EXISTS "users_role_id_idx" ON "users"("role_id");

DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- SSO default role: 'viewer' never existed (JIT sign-up failed with it).
ALTER TABLE "sso_configs" ALTER COLUMN "default_role" SET DEFAULT 'member';
UPDATE "sso_configs" SET "default_role" = 'member' WHERE "default_role" IN ('viewer', 'operator', '');
