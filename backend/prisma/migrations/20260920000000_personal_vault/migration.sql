-- Personal vault (docs/personal-vault.md): identities and SSH keys get an
-- optional owner (NULL = organization Keystore, set = private to that user),
-- and users get a private list of SSH targets ("My hosts").

ALTER TABLE "ssh_keys" ADD COLUMN IF NOT EXISTS "owner_id" TEXT;
ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "owner_id" TEXT;

-- Names were unique per org; now per (org, owner). Org-scope uniqueness
-- (owner NULL) is enforced in keystoreService.
DROP INDEX IF EXISTS "ssh_keys_org_id_name_key";
DROP INDEX IF EXISTS "credentials_org_id_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "ssh_keys_org_id_owner_id_name_key" ON "ssh_keys"("org_id", "owner_id", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "credentials_org_id_owner_id_name_key" ON "credentials"("org_id", "owner_id", "name");
CREATE INDEX IF NOT EXISTS "ssh_keys_owner_id_idx" ON "ssh_keys"("owner_id");
CREATE INDEX IF NOT EXISTS "credentials_owner_id_idx" ON "credentials"("owner_id");

DO $$ BEGIN
  ALTER TABLE "ssh_keys" ADD CONSTRAINT "ssh_keys_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "credentials" ADD CONSTRAINT "credentials_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "personal_hosts" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "username" TEXT,
    "credential_id" TEXT,
    "description" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "host_key_fingerprint" TEXT,
    "host_key_algorithm" TEXT,
    "host_key_pinned_at" TIMESTAMP(3),
    "last_connected_at" TIMESTAMP(3),
    "last_status" TEXT,
    "last_error" TEXT,
    "connect_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "personal_hosts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "personal_hosts_owner_id_name_key" ON "personal_hosts"("owner_id", "name");
CREATE INDEX IF NOT EXISTS "personal_hosts_org_id_owner_id_idx" ON "personal_hosts"("org_id", "owner_id");
CREATE INDEX IF NOT EXISTS "personal_hosts_credential_id_idx" ON "personal_hosts"("credential_id");

DO $$ BEGIN
  ALTER TABLE "personal_hosts" ADD CONSTRAINT "personal_hosts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "personal_hosts" ADD CONSTRAINT "personal_hosts_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "personal_hosts" ADD CONSTRAINT "personal_hosts_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
