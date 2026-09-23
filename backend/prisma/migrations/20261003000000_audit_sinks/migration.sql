-- Audit sinks: where an organization's audit log is copied to.

CREATE TABLE "audit_sinks" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config_encrypted" TEXT,
    "filters" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "batch_size" INTEGER NOT NULL DEFAULT 500,
    "cursor_created_at" TIMESTAMP(3),
    "cursor_id" TEXT,
    "last_run_at" TIMESTAMP(3),
    "last_ok_at" TIMESTAMP(3),
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

    CONSTRAINT "audit_sinks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "audit_sink_deliveries" (
    "id" TEXT NOT NULL,
    "sink_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "from_created_at" TIMESTAMP(3) NOT NULL,
    "to_created_at" TIMESTAMP(3) NOT NULL,
    "first_log_id" TEXT NOT NULL,
    "last_log_id" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "object_key" TEXT,
    "error" TEXT,
    "duration_ms" INTEGER,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "audit_sink_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_sinks_org_id_idx" ON "audit_sinks"("org_id");
CREATE INDEX "audit_sinks_is_active_backoff_until_idx" ON "audit_sinks"("is_active", "backoff_until");
CREATE INDEX "audit_sink_deliveries_sink_id_started_at_idx" ON "audit_sink_deliveries"("sink_id", "started_at");
CREATE INDEX "audit_sink_deliveries_org_id_started_at_idx" ON "audit_sink_deliveries"("org_id", "started_at");

ALTER TABLE "audit_sinks" ADD CONSTRAINT "audit_sinks_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "audit_sink_deliveries" ADD CONSTRAINT "audit_sink_deliveries_sink_id_fkey" FOREIGN KEY ("sink_id") REFERENCES "audit_sinks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
