-- CreateEnum
CREATE TYPE "AccessScope" AS ENUM ('ALL', 'CUSTOMERS');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "access_scope" "AccessScope" NOT NULL DEFAULT 'ALL';

-- CreateTable
CREATE TABLE "user_customer_scopes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_customer_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_customer_scopes" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_customer_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_customer_scopes_user_id_idx" ON "user_customer_scopes"("user_id");

-- CreateIndex
CREATE INDEX "user_customer_scopes_customer_id_idx" ON "user_customer_scopes"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_customer_scopes_user_id_customer_id_key" ON "user_customer_scopes"("user_id", "customer_id");

-- CreateIndex
CREATE INDEX "group_customer_scopes_group_id_idx" ON "group_customer_scopes"("group_id");

-- CreateIndex
CREATE INDEX "group_customer_scopes_customer_id_idx" ON "group_customer_scopes"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_customer_scopes_group_id_customer_id_key" ON "group_customer_scopes"("group_id", "customer_id");

-- AddForeignKey
ALTER TABLE "user_customer_scopes" ADD CONSTRAINT "user_customer_scopes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_customer_scopes" ADD CONSTRAINT "user_customer_scopes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_customer_scopes" ADD CONSTRAINT "group_customer_scopes_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_customer_scopes" ADD CONSTRAINT "group_customer_scopes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
