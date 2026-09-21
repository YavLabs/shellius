-- Bulk import can now keep the credentials it was given as a reusable
-- Keystore identity, instead of wiping them once the host is onboarded.
ALTER TABLE "onboarding_credentials"
  ADD COLUMN "store_as_identity" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "identity_name" TEXT;
