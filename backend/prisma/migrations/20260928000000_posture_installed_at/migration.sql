-- When Shellius last installed the posture collector on this server, so a
-- report from the replaced collector is not shown as the current state.
ALTER TABLE "servers" ADD COLUMN "posture_installed_at" TIMESTAMP(3);
