-- A saved sudo password per server (a Keystore identity), so reinstalling
-- over a short-lived certificate does not have to ask for it every time.
ALTER TABLE "servers"
  ADD COLUMN "sudo_credential_id" TEXT,
  ADD COLUMN "posture_rejected_at" TIMESTAMP(3),
  ADD COLUMN "posture_reject_reason" TEXT;

CREATE INDEX "servers_sudo_credential_id_idx" ON "servers"("sudo_credential_id");

ALTER TABLE "servers"
  ADD CONSTRAINT "servers_sudo_credential_id_fkey"
  FOREIGN KEY ("sudo_credential_id") REFERENCES "credentials"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
