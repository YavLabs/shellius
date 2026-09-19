-- Multi-provider email delivery (docs/email-delivery.md).
--
-- Adds email_providers: an org can define several outbound email providers
-- (SMTP, Gmail API, Microsoft Graph, SendGrid, Mailgun, Postmark, Resend);
-- at most one is active per org.
--
-- Carry-over of existing SMTP settings: every smtp_configs row is copied
-- into an 'smtp' provider named "SMTP" (active if the old row was active).
-- The new row's settings live in one encrypted JSON blob, which SQL cannot
-- produce (the SMTP password is AES-256-GCM encrypted with the server key),
-- so the copied row starts with config_encrypted NULL and
-- legacy_smtp_config_id pointing at its source. On boot (and on first use)
-- emailProviderService.importLegacySmtpConfigs() reads the smtp_configs row,
-- decrypts its password and writes the encrypted blob. That step is
-- idempotent (it only touches rows whose config_encrypted is still NULL).
--
-- smtp_configs is NOT dropped or modified, so rolling back to a release that
-- reads it keeps working.
--
-- Additive, transaction-safe, re-runnable (IF NOT EXISTS / NOT EXISTS guards).

CREATE TABLE IF NOT EXISTS "email_providers" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "from_address" TEXT,
    "from_name" TEXT,
    "config_encrypted" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "last_test_at" TIMESTAMP(3),
    "last_test_ok" BOOLEAN,
    "last_test_error" TEXT,
    "legacy_smtp_config_id" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "email_providers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "email_providers_org_id_idx" ON "email_providers"("org_id");

-- Exactly one active provider per org. Partial index — not expressible in
-- schema.prisma, so it lives only here (see the EmailProvider model comment).
CREATE UNIQUE INDEX IF NOT EXISTS "email_providers_one_active_per_org"
    ON "email_providers"("org_id") WHERE "is_active";

DO $$ BEGIN
  ALTER TABLE "email_providers" ADD CONSTRAINT "email_providers_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Copy existing per-org SMTP settings (password stays in smtp_configs until
-- the boot-time import encrypts it into config_encrypted — see above).
INSERT INTO "email_providers"
    ("id", "org_id", "name", "type", "from_address", "config_encrypted",
     "is_active", "legacy_smtp_config_id", "created_at", "updated_at")
SELECT gen_random_uuid()::text, s."org_id", 'SMTP', 'smtp', NULLIF(s."from_address", ''), NULL,
       s."is_active" AND NOT EXISTS (
           SELECT 1 FROM "email_providers" a WHERE a."org_id" = s."org_id" AND a."is_active"
       ), s."id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "smtp_configs" s
WHERE NOT EXISTS (
    SELECT 1 FROM "email_providers" e WHERE e."legacy_smtp_config_id" = s."id"
);
