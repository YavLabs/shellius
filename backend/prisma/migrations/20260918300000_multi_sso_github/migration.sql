-- Multiple SSO providers per org (incl. GitHub) and per-provider linked identities.

-- SsoConfig: drop one-per-org constraint, add label/order/GitHub org allow-list.
DROP INDEX IF EXISTS "sso_configs_org_id_key";
ALTER TABLE "sso_configs" ADD COLUMN "name" TEXT NOT NULL DEFAULT 'Single Sign-On';
ALTER TABLE "sso_configs" ADD COLUMN "display_order" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "sso_configs" ADD COLUMN "allowed_orgs" TEXT[] DEFAULT ARRAY[]::TEXT[];
CREATE INDEX "sso_configs_org_id_idx" ON "sso_configs"("org_id");

-- Give existing rows a sensible label from their preset.
UPDATE "sso_configs" SET "name" = CASE "preset_id"
  WHEN 'google' THEN 'Google'
  WHEN 'entra' THEN 'Microsoft'
  WHEN 'okta' THEN 'Okta'
  WHEN 'auth0' THEN 'Auth0'
  ELSE 'Single Sign-On' END;

-- CreateTable
CREATE TABLE "user_identities" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "sso_config_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_identities_sso_config_id_subject_key" ON "user_identities"("sso_config_id", "subject");
CREATE INDEX "user_identities_user_id_idx" ON "user_identities"("user_id");
CREATE INDEX "user_identities_org_id_idx" ON "user_identities"("org_id");
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_sso_config_id_fkey" FOREIGN KEY ("sso_config_id") REFERENCES "sso_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: existing single-provider links become identities on the org's config.
INSERT INTO "user_identities" ("id", "org_id", "user_id", "sso_config_id", "provider", "subject", "email", "last_login_at", "created_at")
SELECT 'uid_' || u."id", u."org_id", u."id", c."id", COALESCE(u."sso_provider", c."provider"), u."sso_sub", u."email", u."last_login_at", CURRENT_TIMESTAMP
FROM "users" u
JOIN "sso_configs" c ON c."org_id" = u."org_id"
WHERE u."sso_sub" IS NOT NULL
ON CONFLICT DO NOTHING;
