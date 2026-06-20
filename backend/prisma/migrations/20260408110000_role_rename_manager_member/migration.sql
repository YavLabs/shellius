-- Rename OrgRole enum values: operator -> manager, viewer -> member.
-- ALTER TYPE ... RENAME VALUE atomically updates all existing rows.
ALTER TYPE "OrgRole" RENAME VALUE 'operator' TO 'manager';
ALTER TYPE "OrgRole" RENAME VALUE 'viewer' TO 'member';
