-- `mode: 'digest'` on a posture alert rule suppressed the per-event email and
-- deferred to a digest job. That job was never written, so any rule set to
-- digest with only the `email` channel delivered nothing at all, silently,
-- for as long as it had been configured.
--
-- Rather than leave those rules quietly broken, move them to 'immediate' so
-- they start sending the mail their authors believed they were batching. The
-- per-rule `throttleMinutes` still applies, so this is not a flood.
UPDATE "posture_alert_rules" SET "mode" = 'immediate' WHERE "mode" <> 'immediate';
