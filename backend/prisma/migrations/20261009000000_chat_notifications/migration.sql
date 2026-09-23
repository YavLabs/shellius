-- CreateTable
CREATE TABLE "chat_destinations" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'webhook',
    "config_encrypted" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "environments" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customer_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "min_severity" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_delivered_at" TIMESTAMP(3),
    "last_error" TEXT,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "backoff_until" TIMESTAMP(3),
    "disabled_reason" TEXT,
    "last_test_at" TIMESTAMP(3),
    "last_test_ok" BOOLEAN,
    "last_test_error" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_destinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_deliveries" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "destination_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "channel" TEXT,
    "message_ts" TEXT,
    "error" TEXT,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),

    CONSTRAINT "chat_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_identities" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "external_user_id" TEXT NOT NULL,
    "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "linked_via" TEXT NOT NULL DEFAULT 'confirmed',
    "linked_by_ip" TEXT,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "chat_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_destinations_org_id_is_active_idx" ON "chat_destinations"("org_id", "is_active");

-- CreateIndex
CREATE INDEX "chat_deliveries_destination_id_created_at_idx" ON "chat_deliveries"("destination_id", "created_at");

-- CreateIndex
CREATE INDEX "chat_deliveries_org_id_idx" ON "chat_deliveries"("org_id");

-- CreateIndex
CREATE INDEX "chat_identities_user_id_idx" ON "chat_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_identities_org_id_platform_workspace_id_external_user__key" ON "chat_identities"("org_id", "platform", "workspace_id", "external_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_identities_org_id_user_id_platform_workspace_id_key" ON "chat_identities"("org_id", "user_id", "platform", "workspace_id");

-- AddForeignKey
ALTER TABLE "chat_destinations" ADD CONSTRAINT "chat_destinations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_deliveries" ADD CONSTRAINT "chat_deliveries_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "chat_destinations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_identities" ADD CONSTRAINT "chat_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
