-- CreateEnum
CREATE TYPE "Environment" AS ENUM ('demo', 'dev', 'staging', 'prod');

-- CreateEnum
CREATE TYPE "ServerProtocol" AS ENUM ('ssh', 'rdp', 'both');

-- CreateEnum
CREATE TYPE "HealthStatus" AS ENUM ('healthy', 'unhealthy', 'unknown', 'maintenance');

-- CreateTable
CREATE TABLE "servers" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "display_name" TEXT,
    "description" TEXT,
    "ip_address" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "protocol" "ServerProtocol" NOT NULL DEFAULT 'ssh',
    "environment" "Environment" NOT NULL DEFAULT 'dev',
    "labels" JSONB NOT NULL DEFAULT '[]',
    "os_type" TEXT,
    "os_version" TEXT,
    "cloud_provider" TEXT,
    "cloud_instance_id" TEXT,
    "cloud_region" TEXT,
    "cloud_account_id" TEXT,
    "agent_id" TEXT,
    "agent_version" TEXT,
    "agent_last_seen" TIMESTAMP(3),
    "health_status" "HealthStatus" NOT NULL DEFAULT 'unknown',
    "last_health_check" TIMESTAMP(3),
    "health_message" TEXT,
    "ssh_user" TEXT NOT NULL DEFAULT 'root',
    "ssh_key_path" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "servers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "servers_cloud_instance_id_key" ON "servers"("cloud_instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "servers_agent_id_key" ON "servers"("agent_id");

-- CreateIndex
CREATE INDEX "servers_org_id_customer_id_idx" ON "servers"("org_id", "customer_id");

-- CreateIndex
CREATE INDEX "servers_org_id_environment_idx" ON "servers"("org_id", "environment");

-- CreateIndex
CREATE INDEX "servers_health_status_idx" ON "servers"("health_status");

-- CreateIndex
CREATE INDEX "servers_agent_id_idx" ON "servers"("agent_id");

-- AddForeignKey
ALTER TABLE "servers" ADD CONSTRAINT "servers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "servers" ADD CONSTRAINT "servers_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
