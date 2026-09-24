-- Instance self-update, phase three (docs/instance-updates.md).
--
-- These tables let the application record an INTENT to upgrade. They do not
-- give it the ability to do so: a container cannot reliably replace itself,
-- and the alternatives (the Docker socket, or a shell on the host) would hand
-- the web app root on the machine holding the SSH CA. A small systemd unit the
-- operator installs deliberately polls for the intent and runs the existing
-- update-shellius.sh.
--
-- With no helper installed, rows here sit unclaimed and the UI shows the
-- command to run by hand. That is the default and it is a fine end state.

CREATE TABLE "instance_update_requests" (
  "id"              TEXT NOT NULL,
  "target_version"  TEXT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'requested',
  "detail"          TEXT,
  "requested_by_id" TEXT,
  "requested_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimed_at"      TIMESTAMP(3),
  "finished_at"     TIMESTAMP(3),
  "from_version"    TEXT,
  CONSTRAINT "instance_update_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "instance_update_requests_status_requested_at_idx"
  ON "instance_update_requests"("status", "requested_at");

CREATE TABLE "instance_update_helpers" (
  "id"             TEXT NOT NULL,
  "scope"          TEXT NOT NULL DEFAULT 'global',
  "helper_version" TEXT,
  "last_seen_at"   TIMESTAMP(3),
  "hostname"       TEXT,
  CONSTRAINT "instance_update_helpers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "instance_update_helpers_scope_key" ON "instance_update_helpers"("scope");
