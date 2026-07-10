-- CreateTable: bulk-import staging
CREATE TABLE "import_jobs" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "actor_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'preview_ready',
    "source" TEXT NOT NULL DEFAULT 'csv',
    "summary" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "import_rows" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "row_index" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "resolved" JSONB NOT NULL DEFAULT '{}',
    "action" TEXT NOT NULL DEFAULT 'create',
    "decision" TEXT,
    "conflict_reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "result_id" TEXT,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "onboarding_credentials" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "server_ref" TEXT NOT NULL,
    "server_id" TEXT,
    "ssh_user" TEXT,
    "auth_method" TEXT NOT NULL,
    "secret_encrypted" TEXT,
    "sudo_password_encrypted" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_jobs_org_id_status_idx" ON "import_jobs"("org_id", "status");
CREATE INDEX "import_rows_job_id_entity_idx" ON "import_rows"("job_id", "entity");
CREATE INDEX "onboarding_credentials_job_id_idx" ON "onboarding_credentials"("job_id");
CREATE INDEX "onboarding_credentials_expires_at_idx" ON "onboarding_credentials"("expires_at");

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "onboarding_credentials" ADD CONSTRAINT "onboarding_credentials_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
