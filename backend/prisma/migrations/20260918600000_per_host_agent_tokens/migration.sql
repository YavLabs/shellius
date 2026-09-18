-- Per-host agent credentials (hashed) replacing the single global agent secret.
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "agent_token_hash" TEXT;
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "agent_token_issued_at" TIMESTAMP(3);
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "agent_token_last_used_at" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "servers_agent_token_hash_key" ON "servers"("agent_token_hash");
