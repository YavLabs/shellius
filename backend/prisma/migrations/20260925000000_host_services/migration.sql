-- HostService: what is installed on the host and whether it is running.
--
-- HostListener only sees open sockets, so a stopped container or a failed
-- unit is invisible there while its firewall rule survives. This table is
-- the other half, and like host_listeners it is replaced wholesale on every
-- ingest — current state, never history.

CREATE TABLE "host_services" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ref" TEXT,
    "state" TEXT NOT NULL,
    "running" BOOLEAN NOT NULL DEFAULT false,
    "status_text" TEXT,
    "detail" TEXT,
    "source_path" TEXT,
    "ports" JSONB NOT NULL DEFAULT '[]',
    "exit_code" INTEGER,
    "since" TIMESTAMP(3),

    CONSTRAINT "host_services_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "host_services_org_id_server_id_idx" ON "host_services"("org_id", "server_id");
CREATE INDEX "host_services_org_id_running_idx" ON "host_services"("org_id", "running");
CREATE INDEX "host_services_snapshot_id_idx" ON "host_services"("snapshot_id");

ALTER TABLE "host_services" ADD CONSTRAINT "host_services_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "host_services" ADD CONSTRAINT "host_services_server_id_fkey"
  FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "host_services" ADD CONSTRAINT "host_services_snapshot_id_fkey"
  FOREIGN KEY ("snapshot_id") REFERENCES "host_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
