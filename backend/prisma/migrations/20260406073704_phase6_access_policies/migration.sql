-- CreateEnum
CREATE TYPE "PolicyEffect" AS ENUM ('ALLOW', 'DENY');

-- CreateEnum
CREATE TYPE "SubjectType" AS ENUM ('USER', 'GROUP');

-- CreateTable
CREATE TABLE "access_policies" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "effect" "PolicyEffect" NOT NULL,
    "target_environments" TEXT[],
    "target_labels" JSONB NOT NULL DEFAULT '{}',
    "target_server_ids" TEXT[],
    "allowed_principals" TEXT[],
    "max_session_duration" INTEGER NOT NULL,
    "require_approval" BOOLEAN NOT NULL DEFAULT false,
    "auto_approve" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_subjects" (
    "id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "subject_type" "SubjectType" NOT NULL,
    "subject_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "access_policies_org_id_is_active_idx" ON "access_policies"("org_id", "is_active");

-- CreateIndex
CREATE INDEX "access_policies_customer_id_idx" ON "access_policies"("customer_id");

-- CreateIndex
CREATE INDEX "access_policies_effect_priority_idx" ON "access_policies"("effect", "priority");

-- CreateIndex
CREATE INDEX "policy_subjects_subject_type_subject_id_idx" ON "policy_subjects"("subject_type", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "policy_subjects_policy_id_subject_type_subject_id_key" ON "policy_subjects"("policy_id", "subject_type", "subject_id");

-- AddForeignKey
ALTER TABLE "access_policies" ADD CONSTRAINT "access_policies_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_policies" ADD CONSTRAINT "access_policies_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_subjects" ADD CONSTRAINT "policy_subjects_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "access_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
