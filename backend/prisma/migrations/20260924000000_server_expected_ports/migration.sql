-- Per-server expected-public ports. The org-wide list on posture_settings is
-- too blunt on its own: "8080 is fine" everywhere silences 8080 on a database
-- host too. Either list matching downgrades a finding to EXPECTED_PUBLIC.
CREATE TABLE "server_expected_ports" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "proto" TEXT NOT NULL DEFAULT 'any',
    "note" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_expected_ports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "server_expected_ports_server_id_port_proto_key"
    ON "server_expected_ports"("server_id", "port", "proto");
CREATE INDEX "server_expected_ports_org_id_server_id_idx"
    ON "server_expected_ports"("org_id", "server_id");

ALTER TABLE "server_expected_ports"
    ADD CONSTRAINT "server_expected_ports_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "server_expected_ports"
    ADD CONSTRAINT "server_expected_ports_server_id_fkey"
    FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
