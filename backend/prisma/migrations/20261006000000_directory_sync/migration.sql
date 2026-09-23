-- CreateTable
CREATE TABLE "directory_syncs" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "sso_config_id" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "config_encrypted" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "action" TEXT NOT NULL DEFAULT 'flag',
    "dry_run" BOOLEAN NOT NULL DEFAULT true,
    "interval_hours" INTEGER NOT NULL DEFAULT 6,
    "max_suspend_percent" INTEGER NOT NULL DEFAULT 10,
    "max_suspend_count" INTEGER NOT NULL DEFAULT 25,
    "grace_hours" INTEGER NOT NULL DEFAULT 24,
    "last_run_at" TIMESTAMP(3),
    "last_run_status" TEXT,
    "last_error" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "directory_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "directory_sync_runs" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "sync_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "abort_reason" TEXT,
    "dry_run" BOOLEAN NOT NULL DEFAULT true,
    "directory_count" INTEGER NOT NULL DEFAULT 0,
    "matched_by_external_id" INTEGER NOT NULL DEFAULT 0,
    "matched_by_email" INTEGER NOT NULL DEFAULT 0,
    "unknown_identities" INTEGER NOT NULL DEFAULT 0,
    "candidates" INTEGER NOT NULL DEFAULT 0,
    "flagged" INTEGER NOT NULL DEFAULT 0,
    "suspended" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "error" TEXT,

    CONSTRAINT "directory_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "directory_sync_findings" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "sync_id" TEXT NOT NULL,
    "run_id" TEXT,
    "user_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "acted_at" TIMESTAMP(3),
    "outcome" TEXT,

    CONSTRAINT "directory_sync_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "directory_syncs_sso_config_id_key" ON "directory_syncs"("sso_config_id");

-- CreateIndex
CREATE INDEX "directory_syncs_org_id_idx" ON "directory_syncs"("org_id");

-- CreateIndex
CREATE INDEX "directory_sync_runs_sync_id_started_at_idx" ON "directory_sync_runs"("sync_id", "started_at");

-- CreateIndex
CREATE INDEX "directory_sync_runs_org_id_idx" ON "directory_sync_runs"("org_id");

-- CreateIndex
CREATE INDEX "directory_sync_findings_org_id_status_idx" ON "directory_sync_findings"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "directory_sync_findings_sync_id_user_id_key" ON "directory_sync_findings"("sync_id", "user_id");

-- AddForeignKey
ALTER TABLE "directory_syncs" ADD CONSTRAINT "directory_syncs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "directory_syncs" ADD CONSTRAINT "directory_syncs_sso_config_id_fkey" FOREIGN KEY ("sso_config_id") REFERENCES "sso_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "directory_sync_runs" ADD CONSTRAINT "directory_sync_runs_sync_id_fkey" FOREIGN KEY ("sync_id") REFERENCES "directory_syncs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "directory_sync_findings" ADD CONSTRAINT "directory_sync_findings_sync_id_fkey" FOREIGN KEY ("sync_id") REFERENCES "directory_syncs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "directory_sync_findings" ADD CONSTRAINT "directory_sync_findings_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "directory_sync_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "directory_sync_findings" ADD CONSTRAINT "directory_sync_findings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
