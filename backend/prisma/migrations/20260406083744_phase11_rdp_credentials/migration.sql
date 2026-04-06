-- AlterTable
ALTER TABLE "servers" ADD COLUMN     "rdp_password_encrypted" TEXT,
ADD COLUMN     "rdp_password_iv" TEXT,
ADD COLUMN     "rdp_password_tag" TEXT,
ADD COLUMN     "rdp_username" TEXT;
