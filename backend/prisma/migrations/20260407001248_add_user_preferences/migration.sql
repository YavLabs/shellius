-- Add preferences column to users table
ALTER TABLE "users" ADD COLUMN "preferences" JSONB NOT NULL DEFAULT '{}'::jsonb;
