CREATE TABLE "smtp_configs" (
  "id" TEXT PRIMARY KEY,
  "org_id" TEXT NOT NULL UNIQUE REFERENCES "organizations"("id") ON DELETE CASCADE,
  "host" TEXT NOT NULL,
  "port" INTEGER NOT NULL DEFAULT 587,
  "username" TEXT,
  "password_encrypted" TEXT,
  "from_address" TEXT,
  "use_tls" BOOLEAN NOT NULL DEFAULT true,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);
