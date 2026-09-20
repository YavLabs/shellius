-- Posture alerts route through the shared notification inbox. Without this
-- value every in-app posture alert failed the enum check at write time and
-- was swallowed by the dispatcher's per-recipient catch: rules fired, nobody
-- was told.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'POSTURE_FINDING';
