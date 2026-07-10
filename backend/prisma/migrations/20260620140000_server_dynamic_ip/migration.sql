-- Servers whose public IP can change (no static IP).
ALTER TABLE "servers" ADD COLUMN "dynamic_ip" BOOLEAN NOT NULL DEFAULT false;
