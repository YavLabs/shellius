-- Imported key metadata: original format and an optional paired OpenSSH certificate.
ALTER TABLE "ssh_keys" ADD COLUMN "original_format" TEXT;
ALTER TABLE "ssh_keys" ADD COLUMN "certificate" TEXT;
