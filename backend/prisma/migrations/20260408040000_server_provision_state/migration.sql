-- AlterTable: track server onboarding / provisioning lifecycle
ALTER TABLE "servers" ADD COLUMN "provision_status" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "servers" ADD COLUMN "provision_error" TEXT;
ALTER TABLE "servers" ADD COLUMN "provisioned_at" TIMESTAMP(3);
ALTER TABLE "servers" ADD COLUMN "last_provision_at" TIMESTAMP(3);

-- Backfill: servers that have already checked in via heartbeat are effectively provisioned.
UPDATE "servers" SET "provision_status" = 'provisioned', "provisioned_at" = "agent_last_seen"
WHERE "agent_last_seen" IS NOT NULL;

-- Index for filtering by onboarding state (UI + bulk-import idempotency checks).
CREATE INDEX "servers_org_id_provision_status_idx" ON "servers"("org_id", "provision_status");
