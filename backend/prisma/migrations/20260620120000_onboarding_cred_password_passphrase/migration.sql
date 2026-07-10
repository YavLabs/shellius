-- Support key + password (+ passphrase) onboarding credentials.
ALTER TABLE "onboarding_credentials" ADD COLUMN "password_encrypted" TEXT;
ALTER TABLE "onboarding_credentials" ADD COLUMN "passphrase_encrypted" TEXT;
