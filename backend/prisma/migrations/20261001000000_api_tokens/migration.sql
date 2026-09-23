-- API tokens: long-lived bearer credentials for non-interactive callers.
--
-- Service accounts are real user rows (kind = 'service') rather than a
-- synthetic id, because audit_logs.actor_id is a foreign key to users — a
-- machine action has to be attributable to something that exists, and roles,
-- customer scope and policy subjects all hang off a user row too.

-- CreateEnum
CREATE TYPE "UserKind" AS ENUM ('human', 'service');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "kind" "UserKind" NOT NULL DEFAULT 'human';
ALTER TABLE "users" ADD COLUMN "description" TEXT;

-- Every existing row is a person.
CREATE INDEX "users_org_id_kind_idx" ON "users" ("org_id", "kind");

-- CreateTable
CREATE TABLE "api_tokens" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "token_hash" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "last_used_ip" TEXT,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_id" TEXT,
    "revoked_reason" TEXT,
    "rotated_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_tokens_token_hash_key" ON "api_tokens"("token_hash");
CREATE INDEX "api_tokens_org_id_kind_idx" ON "api_tokens"("org_id", "kind");
CREATE INDEX "api_tokens_user_id_idx" ON "api_tokens"("user_id");
CREATE INDEX "api_tokens_expires_at_idx" ON "api_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
