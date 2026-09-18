-- Gap-fill migration: the `ca_key_pairs` and `certificates` tables (and the
-- CertType/CertStatus enums) exist in prisma/schema.prisma and are referenced
-- by later migrations (phase7_access_requests, phase8_sessions), but no
-- earlier migration ever creates them — they were originally applied to
-- existing databases via `prisma db push` outside the migration history.
--
-- This migration is purely additive and fully idempotent so that:
--   - On a FRESH database, it creates the missing objects before phase7
--     needs them.
--   - On an EXISTING database (where these objects already exist), every
--     statement is a safe no-op.
DO $$ BEGIN
  CREATE TYPE "CertType" AS ENUM ('USER', 'HOST');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CertStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "ca_key_pairs" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'Ed25519',
    "public_key" TEXT NOT NULL,
    "encrypted_private_key" TEXT NOT NULL,
    "encryption_iv" TEXT NOT NULL,
    "encryption_tag" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotated_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "ca_key_pairs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "certificates" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "ca_key_pair_id" TEXT NOT NULL,
    "serial" BIGINT NOT NULL,
    "type" "CertType" NOT NULL,
    "key_id" TEXT NOT NULL,
    "principals" TEXT[],
    "public_key" TEXT NOT NULL,
    "signed_cert" TEXT NOT NULL,
    "valid_after" TIMESTAMP(3) NOT NULL,
    "valid_before" TIMESTAMP(3) NOT NULL,
    "extensions" JSONB,
    "critical_options" JSONB,
    "status" "CertStatus" NOT NULL DEFAULT 'ACTIVE',
    "issued_to_id" TEXT,
    "issued_for_id" TEXT,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_id" TEXT,
    "issued_via" TEXT NOT NULL DEFAULT 'web',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ca_key_pairs_fingerprint_key" ON "ca_key_pairs"("fingerprint");
CREATE INDEX IF NOT EXISTS "ca_key_pairs_org_id_is_active_idx" ON "ca_key_pairs"("org_id", "is_active");

CREATE UNIQUE INDEX IF NOT EXISTS "certificates_serial_key" ON "certificates"("serial");
CREATE INDEX IF NOT EXISTS "certificates_org_id_status_idx" ON "certificates"("org_id", "status");
CREATE INDEX IF NOT EXISTS "certificates_org_id_valid_before_idx" ON "certificates"("org_id", "valid_before");
CREATE INDEX IF NOT EXISTS "certificates_issued_to_id_idx" ON "certificates"("issued_to_id");
CREATE INDEX IF NOT EXISTS "certificates_issued_for_id_idx" ON "certificates"("issued_for_id");
CREATE INDEX IF NOT EXISTS "certificates_ca_key_pair_id_idx" ON "certificates"("ca_key_pair_id");

DO $$ BEGIN
  ALTER TABLE "ca_key_pairs" ADD CONSTRAINT "ca_key_pairs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "certificates" ADD CONSTRAINT "certificates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "certificates" ADD CONSTRAINT "certificates_ca_key_pair_id_fkey" FOREIGN KEY ("ca_key_pair_id") REFERENCES "ca_key_pairs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "certificates" ADD CONSTRAINT "certificates_issued_to_id_fkey" FOREIGN KEY ("issued_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "certificates" ADD CONSTRAINT "certificates_issued_for_id_fkey" FOREIGN KEY ("issued_for_id") REFERENCES "servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "certificates" ADD CONSTRAINT "certificates_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
