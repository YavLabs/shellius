-- AlterTable: bind a token to a domain object (e.g. an access request for one-click approval)
ALTER TABLE "user_tokens" ADD COLUMN "resource_id" TEXT;
