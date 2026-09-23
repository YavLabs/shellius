-- The id a user has in their provider's DIRECTORY API, which is not always the
-- value we already store in `subject`.
--
-- This column exists because of one trap. Microsoft Entra issues a PAIRWISE
-- `sub` claim: it is unique per application, so the `sub` Shellius stored at
-- sign-in is a value that appears nowhere in Microsoft Graph. Joining an Entra
-- directory listing on `subject` matches zero rows — and in a deprovisioning
-- job, "matched nothing" reads as "everyone has left the company".
--
-- So the backfill below is deliberately partial. We copy `subject` only where
-- it is provably the directory id as well:
--
--   github  — `subject` is the numeric user id, which is what
--             GET /orgs/{org}/members returns as `id`.
--   google  — the OIDC `sub` is the immutable directory user id, which is what
--             the Admin SDK returns as `users.id`.
--
-- Entra, Okta and generic OIDC configs are left NULL on purpose. Entra's real
-- directory id is the `oid` claim, which we did not previously record and
-- CANNOT reconstruct from stored data; Okta's `sub` is the user id on an org
-- authorization server but is configurable (and defaults to the login) on a
-- custom one, so it is not safe to assume. Those rows fill in on each user's
-- next sign-in.
--
-- NULL is the safe state: directory sync never counts a NULL external id as
-- absent from the directory.

ALTER TABLE "user_identities" ADD COLUMN "external_id" TEXT;

UPDATE "user_identities" ui
SET "external_id" = ui."subject"
FROM "sso_configs" sc
WHERE sc."id" = ui."sso_config_id"
  AND (sc."provider" = 'github' OR sc."preset_id" = 'google');

CREATE INDEX "user_identities_sso_config_id_external_id_idx"
  ON "user_identities" ("sso_config_id", "external_id");
