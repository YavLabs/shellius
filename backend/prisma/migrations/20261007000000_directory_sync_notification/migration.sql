-- Directory sync needs somewhere to say "these five people are no longer in
-- Okta". Its own notification type, separate from the migration that creates
-- the tables, because adding an enum value cannot share a transaction with
-- inserts that use it.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DIRECTORY_SYNC';
