-- Keystore (identities + stored keys), key deployments, Quick Connect sessions,
-- server auth mode / host key pinning, and auth hardening (lockout, token
-- families, session revocation, pending TOTP, SSO domain restriction).

-- CreateEnum
CREATE TYPE "ServerAuthMode" AS ENUM ('certificate', 'credential');

-- Users: auth hardening
ALTER TABLE "users" ADD COLUMN "mfa_totp_pending_enc" TEXT;
ALTER TABLE "users" ADD COLUMN "failed_login_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "last_failed_login_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "locked_until" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "sessions_valid_from" TIMESTAMP(3);

-- Refresh token families
ALTER TABLE "refresh_tokens" ADD COLUMN "family_id" TEXT;
ALTER TABLE "refresh_tokens" ADD COLUMN "session_started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "refresh_tokens" ADD COLUMN "last_used_at" TIMESTAMP(3);
ALTER TABLE "refresh_tokens" ADD COLUMN "revoked_at" TIMESTAMP(3);
ALTER TABLE "refresh_tokens" ADD COLUMN "replaced_by_id" TEXT;
UPDATE "refresh_tokens" SET "family_id" = "id", "session_started_at" = "created_at" WHERE "family_id" IS NULL;
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- SSO config
ALTER TABLE "sso_configs" ADD COLUMN "allowed_domains" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "sso_configs" ADD COLUMN "require_verified_email" BOOLEAN NOT NULL DEFAULT true;

-- Servers: auth mode + host key pin
ALTER TABLE "servers" ADD COLUMN "auth_mode" "ServerAuthMode" NOT NULL DEFAULT 'certificate';
ALTER TABLE "servers" ADD COLUMN "credential_id" TEXT;
ALTER TABLE "servers" ADD COLUMN "host_key_fingerprint" TEXT;
ALTER TABLE "servers" ADD COLUMN "host_key_algorithm" TEXT;
ALTER TABLE "servers" ADD COLUMN "host_key_pinned_at" TIMESTAMP(3);
CREATE INDEX "servers_credential_id_idx" ON "servers"("credential_id");

-- Sessions: Quick Connect (no saved server)
ALTER TABLE "sessions" ALTER COLUMN "server_id" DROP NOT NULL;
ALTER TABLE "sessions" ADD COLUMN "auth_method" TEXT NOT NULL DEFAULT 'certificate';
ALTER TABLE "sessions" ADD COLUMN "target_host" TEXT;
ALTER TABLE "sessions" ADD COLUMN "target_port" INTEGER;
ALTER TABLE "sessions" ADD COLUMN "target_user" TEXT;

-- CreateTable
CREATE TABLE "ssh_keys" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "key_type" TEXT NOT NULL,
    "bits" INTEGER,
    "public_key" TEXT NOT NULL,
    "private_key_encrypted" TEXT NOT NULL,
    "passphrase_encrypted" TEXT,
    "fingerprint" TEXT NOT NULL,
    "comment" TEXT,
    "source" TEXT NOT NULL DEFAULT 'generated',
    "created_by_id" TEXT,
    "last_exported_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ssh_keys_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "credentials" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "username" TEXT NOT NULL,
    "auth_type" TEXT NOT NULL,
    "password_encrypted" TEXT,
    "ssh_key_id" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by_id" TEXT,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "credentials_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "key_deployments" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "ssh_key_id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "action" TEXT NOT NULL DEFAULT 'deploy',
    "target_user" TEXT NOT NULL,
    "auth_mode" TEXT NOT NULL,
    "auth_credential_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "output" TEXT,
    "deployed_by_id" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "key_deployments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ssh_keys_org_id_name_key" ON "ssh_keys"("org_id", "name");
CREATE INDEX "ssh_keys_org_id_idx" ON "ssh_keys"("org_id");
CREATE INDEX "ssh_keys_org_id_fingerprint_idx" ON "ssh_keys"("org_id", "fingerprint");
CREATE UNIQUE INDEX "credentials_org_id_name_key" ON "credentials"("org_id", "name");
CREATE INDEX "credentials_org_id_idx" ON "credentials"("org_id");
CREATE INDEX "credentials_ssh_key_id_idx" ON "credentials"("ssh_key_id");
CREATE INDEX "key_deployments_org_id_batch_id_idx" ON "key_deployments"("org_id", "batch_id");
CREATE INDEX "key_deployments_ssh_key_id_idx" ON "key_deployments"("ssh_key_id");
CREATE INDEX "key_deployments_server_id_idx" ON "key_deployments"("server_id");

-- AddForeignKey
ALTER TABLE "servers" ADD CONSTRAINT "servers_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ssh_keys" ADD CONSTRAINT "ssh_keys_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_ssh_key_id_fkey" FOREIGN KEY ("ssh_key_id") REFERENCES "ssh_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "key_deployments" ADD CONSTRAINT "key_deployments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "key_deployments" ADD CONSTRAINT "key_deployments_ssh_key_id_fkey" FOREIGN KEY ("ssh_key_id") REFERENCES "ssh_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "key_deployments" ADD CONSTRAINT "key_deployments_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
