-- Audit retention and archive.
--
-- Defaults keep everything and archive nothing: deleting audit history is
-- never something that starts happening because of an upgrade.

CREATE TABLE "audit_settings" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "retention_days" INTEGER,
    "archive_enabled" BOOLEAN NOT NULL DEFAULT false,
    "archive_encrypt" BOOLEAN NOT NULL DEFAULT true,
    "archive_bucket" TEXT,
    "archive_prefix" TEXT NOT NULL DEFAULT 'audit-archive',
    "delete_without_archive" BOOLEAN NOT NULL DEFAULT false,
    "last_archive_at" TIMESTAMP(3),
    "last_archive_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "audit_archives" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "bucket" TEXT,
    "format" TEXT NOT NULL DEFAULT 'ndjson.gz',
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "range_start" TIMESTAMP(3) NOT NULL,
    "range_end" TIMESTAMP(3) NOT NULL,
    "row_count" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "deleted_rows" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_archives_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "audit_settings_org_id_key" ON "audit_settings"("org_id");
CREATE UNIQUE INDEX "audit_archives_org_id_object_key_key" ON "audit_archives"("org_id", "object_key");
CREATE INDEX "audit_archives_org_id_range_start_idx" ON "audit_archives"("org_id", "range_start");

ALTER TABLE "audit_settings" ADD CONSTRAINT "audit_settings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "audit_archives" ADD CONSTRAINT "audit_archives_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
