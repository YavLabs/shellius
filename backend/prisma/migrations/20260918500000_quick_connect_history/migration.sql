-- Per-user Quick Connect history (7-day retention, no secrets).
CREATE TABLE "quick_connect_history" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "username" TEXT NOT NULL,
    "auth_type" TEXT NOT NULL,
    "credential_id" TEXT,
    "server_id" TEXT,
    "last_session_id" TEXT,
    "last_status" TEXT NOT NULL DEFAULT 'connected',
    "last_error" TEXT,
    "connect_count" INTEGER NOT NULL DEFAULT 1,
    "last_connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "quick_connect_history_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "quick_connect_history_user_id_host_port_username_key" ON "quick_connect_history"("user_id", "host", "port", "username");
CREATE INDEX "quick_connect_history_org_id_user_id_last_connected_at_idx" ON "quick_connect_history"("org_id", "user_id", "last_connected_at");
CREATE INDEX "quick_connect_history_last_connected_at_idx" ON "quick_connect_history"("last_connected_at");
