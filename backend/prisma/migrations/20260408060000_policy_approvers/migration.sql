-- AlterTable: approver routing on access policies
ALTER TABLE "access_policies" ADD COLUMN "approver_group_id" TEXT;
ALTER TABLE "access_policies" ADD COLUMN "approver_roles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "access_policies" ADD COLUMN "approver_user_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- CreateTable: eligible approvers per access request (any one may act)
CREATE TABLE "access_request_approvers" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_request_approvers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "access_request_approvers_request_id_user_id_key" ON "access_request_approvers"("request_id", "user_id");
CREATE INDEX "access_request_approvers_user_id_idx" ON "access_request_approvers"("user_id");

-- AddForeignKey
ALTER TABLE "access_request_approvers" ADD CONSTRAINT "access_request_approvers_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "access_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "access_request_approvers" ADD CONSTRAINT "access_request_approvers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
