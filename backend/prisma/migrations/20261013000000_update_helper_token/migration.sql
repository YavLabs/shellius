-- Give the self-update helper its own credential.
--
-- The helper was documented as authenticating with a service-account API
-- token holding `settings.updates`. That could never have worked:
-- `settings.updates` is non-delegable, and middleware/apiTokenAuth's
-- effectivePermissions() strips every non-delegable permission from every API
-- token, service accounts included and by design. The helper would have
-- received 403 on every call, forever, and nothing in the test suite would
-- have noticed because the service-layer tests never drive a token through
-- the route stack.
--
-- Carving an exception into that stripping was the wrong fix: it would
-- reopen the "no API token ever holds a non-delegable permission" guarantee
-- that settings.storage, settings.email, audit.sinks and service account
-- management all depend on. A purpose-built credential that reaches exactly
-- three endpoints, and nothing else in the product, is narrower.
--
-- Only the SHA-256 hash is stored, as with Server.agent_token_hash.
ALTER TABLE "instance_update_helpers"
  ADD COLUMN "token_hash"      TEXT,
  ADD COLUMN "token_issued_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "instance_update_helpers_token_hash_key"
  ON "instance_update_helpers"("token_hash");
