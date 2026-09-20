-- CreateTable
CREATE TABLE "host_snapshots" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "collected_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agent_version" TEXT,
    "collector_ok" BOOLEAN NOT NULL DEFAULT true,
    "degraded_reason" TEXT,
    "firewall" JSONB NOT NULL DEFAULT '{}',
    "raw" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "host_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "host_listeners" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "proto" TEXT NOT NULL,
    "bind" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "container_port" INTEGER,
    "bind_class" TEXT NOT NULL,
    "reachability" TEXT NOT NULL,
    "service" TEXT,
    "owner_kind" TEXT NOT NULL,
    "owner_name" TEXT NOT NULL,
    "owner_detail" TEXT,
    "owner_ref" TEXT,
    "owner_user" TEXT,
    "source_path" TEXT,
    "pid" INTEGER,

    CONSTRAINT "host_listeners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exposure_findings" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "proto" TEXT,
    "port" INTEGER,
    "service" TEXT,
    "owner_label" TEXT,
    "message" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "first_seen_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "muted_until" TIMESTAMP(3),
    "muted_reason" TEXT,
    "muted_by_id" TEXT,
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_by_id" TEXT,

    CONSTRAINT "exposure_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "host_metric_samples" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "cpu_pct" DOUBLE PRECISION,
    "mem_pct" DOUBLE PRECISION,
    "disk_pct" DOUBLE PRECISION,
    "load_1" DOUBLE PRECISION,

    CONSTRAINT "host_metric_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posture_alert_rules" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "severities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customer_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "environments" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recipient_roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recipient_group_id" TEXT,
    "recipient_user_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "channels" TEXT[] DEFAULT ARRAY['inapp']::TEXT[],
    "mode" TEXT NOT NULL DEFAULT 'immediate',
    "notify_on_resolve" BOOLEAN NOT NULL DEFAULT false,
    "throttle_minutes" INTEGER NOT NULL DEFAULT 0,
    "escalate_after_hours" INTEGER,
    "escalate_to_group_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "posture_alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posture_settings" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "collect_interval_seconds" INTEGER NOT NULL DEFAULT 300,
    "snapshot_retention_days" INTEGER NOT NULL DEFAULT 7,
    "metric_retention_hours" INTEGER NOT NULL DEFAULT 24,
    "finding_retention_days" INTEGER NOT NULL DEFAULT 90,
    "expected_public_ports" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "posture_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "host_snapshots_org_id_server_id_collected_at_idx" ON "host_snapshots"("org_id", "server_id", "collected_at");

-- CreateIndex
CREATE INDEX "host_snapshots_org_id_received_at_idx" ON "host_snapshots"("org_id", "received_at");

-- CreateIndex
CREATE INDEX "host_listeners_org_id_server_id_idx" ON "host_listeners"("org_id", "server_id");

-- CreateIndex
CREATE INDEX "host_listeners_org_id_reachability_idx" ON "host_listeners"("org_id", "reachability");

-- CreateIndex
CREATE INDEX "host_listeners_snapshot_id_idx" ON "host_listeners"("snapshot_id");

-- CreateIndex
CREATE INDEX "exposure_findings_org_id_severity_resolved_at_idx" ON "exposure_findings"("org_id", "severity", "resolved_at");

-- CreateIndex
CREATE INDEX "exposure_findings_org_id_server_id_idx" ON "exposure_findings"("org_id", "server_id");

-- CreateIndex
CREATE UNIQUE INDEX "exposure_findings_org_id_server_id_code_proto_port_key" ON "exposure_findings"("org_id", "server_id", "code", "proto", "port");

-- CreateIndex
CREATE INDEX "host_metric_samples_org_id_server_id_at_idx" ON "host_metric_samples"("org_id", "server_id", "at");

-- CreateIndex
CREATE INDEX "posture_alert_rules_org_id_is_active_idx" ON "posture_alert_rules"("org_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "posture_alert_rules_org_id_name_key" ON "posture_alert_rules"("org_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "posture_settings_org_id_key" ON "posture_settings"("org_id");

-- AddForeignKey
ALTER TABLE "host_snapshots" ADD CONSTRAINT "host_snapshots_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "host_snapshots" ADD CONSTRAINT "host_snapshots_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "host_listeners" ADD CONSTRAINT "host_listeners_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "host_listeners" ADD CONSTRAINT "host_listeners_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "host_listeners" ADD CONSTRAINT "host_listeners_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "host_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exposure_findings" ADD CONSTRAINT "exposure_findings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exposure_findings" ADD CONSTRAINT "exposure_findings_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "host_metric_samples" ADD CONSTRAINT "host_metric_samples_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "host_metric_samples" ADD CONSTRAINT "host_metric_samples_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posture_alert_rules" ADD CONSTRAINT "posture_alert_rules_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posture_settings" ADD CONSTRAINT "posture_settings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
