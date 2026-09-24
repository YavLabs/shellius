-- Bring back `mode: 'digest'` on posture alert rules, this time with the job
-- that actually sends it (backend/src/jobs/postureDigest.js).
--
-- 20261008000000_posture_alert_drop_digest moved every digest rule to
-- 'immediate' because the batching job had never been written, so those rules
-- were delivering nothing. That migration is NOT reversed here: rules already
-- moved to 'immediate' keep working as they are now. Anyone who wants
-- batching back chooses it again, on a screen that now explains what it does.
--
-- Columns are all nullable with no backfill. A NULL cadence is read through
-- normalizeSchedule() in services/digestSchedule.js, which defaults to daily
-- at 08:00 UTC — note it rejects NULL explicitly rather than coercing, since
-- Number(NULL) is 0 and would otherwise mean midnight.
ALTER TABLE "posture_alert_rules"
  ADD COLUMN "digest_schedule"    TEXT,
  ADD COLUMN "digest_hour"        INTEGER,
  ADD COLUMN "digest_day_of_week" INTEGER,
  ADD COLUMN "last_digest_at"     TIMESTAMP(3);

-- The digest job scans every organization for due rules, so its filter is
-- (is_active, mode) and not org-scoped like the existing index.
CREATE INDEX "posture_alert_rules_is_active_mode_idx"
  ON "posture_alert_rules" ("is_active", "mode");
