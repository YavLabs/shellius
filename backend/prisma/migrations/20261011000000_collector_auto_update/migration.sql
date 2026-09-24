-- Signed, staged, self-healing collector updates (docs/collector-updates.md).
--
-- Auto-update is OFF for every existing organization and every new one. That
-- default is the feature's most important line: turning it on is what makes
-- Shellius able to run new code as root on every managed host with nobody
-- pressing anything, and that is a decision an operator makes deliberately.

ALTER TABLE "posture_settings"
  ADD COLUMN "collector_auto_update"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "collector_canary_percent"  INTEGER NOT NULL DEFAULT 10;

-- One signing key per installation. The private half is encrypted with
-- SERVER_ENCRYPTION_KEY exactly like the SSH CA; the public half is baked
-- into each host's updater at install time so verification needs no network.
CREATE TABLE "release_signing_keys" (
  "id"                    TEXT NOT NULL,
  "scope"                 TEXT NOT NULL DEFAULT 'global',
  "algorithm"             TEXT NOT NULL DEFAULT 'rsa-4096',
  "public_key_pem"        TEXT NOT NULL,
  "private_key_encrypted" TEXT NOT NULL,
  "fingerprint"           TEXT NOT NULL,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rotated_at"            TIMESTAMP(3),
  CONSTRAINT "release_signing_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "release_signing_keys_scope_key" ON "release_signing_keys"("scope");

CREATE TABLE "collector_rollouts" (
  "id"             TEXT NOT NULL,
  "org_id"         TEXT NOT NULL,
  "target_version" TEXT NOT NULL,
  "status"         TEXT NOT NULL DEFAULT 'rolling',
  "percent"        INTEGER NOT NULL DEFAULT 0,
  "started_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_step_at"   TIMESTAMP(3),
  "completed_at"   TIMESTAMP(3),
  "halted_reason"  TEXT,
  "created_by_id"  TEXT,
  CONSTRAINT "collector_rollouts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "collector_rollouts_org_id_target_version_key"
  ON "collector_rollouts"("org_id", "target_version");
CREATE INDEX "collector_rollouts_org_id_status_idx"
  ON "collector_rollouts"("org_id", "status");
ALTER TABLE "collector_rollouts"
  ADD CONSTRAINT "collector_rollouts_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "collector_update_attempts" (
  "id"           TEXT NOT NULL,
  "org_id"       TEXT NOT NULL,
  "rollout_id"   TEXT NOT NULL,
  "server_id"    TEXT NOT NULL,
  "from_version" TEXT,
  "to_version"   TEXT NOT NULL,
  "status"       TEXT NOT NULL DEFAULT 'offered',
  "detail"       TEXT,
  "offered_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reported_at"  TIMESTAMP(3),
  "verified_at"  TIMESTAMP(3),
  CONSTRAINT "collector_update_attempts_pkey" PRIMARY KEY ("id")
);
-- One attempt per (rollout, host): the offer endpoint is polled every few
-- minutes by every host, so the write has to be idempotent or the table
-- becomes a poll log.
CREATE UNIQUE INDEX "collector_update_attempts_rollout_id_server_id_key"
  ON "collector_update_attempts"("rollout_id", "server_id");
CREATE INDEX "collector_update_attempts_org_id_status_idx"
  ON "collector_update_attempts"("org_id", "status");
CREATE INDEX "collector_update_attempts_server_id_offered_at_idx"
  ON "collector_update_attempts"("server_id", "offered_at");
ALTER TABLE "collector_update_attempts"
  ADD CONSTRAINT "collector_update_attempts_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "collector_update_attempts"
  ADD CONSTRAINT "collector_update_attempts_rollout_id_fkey"
  FOREIGN KEY ("rollout_id") REFERENCES "collector_rollouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "collector_update_attempts"
  ADD CONSTRAINT "collector_update_attempts_server_id_fkey"
  FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
