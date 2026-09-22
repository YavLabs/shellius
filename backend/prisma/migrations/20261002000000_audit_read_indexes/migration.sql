-- Indexes for reading the audit log in order rather than a page at a time.
--
-- NOTE for large installs: Prisma runs each migration file in one
-- transaction, so CREATE INDEX CONCURRENTLY cannot be used here. On a big
-- audit_logs table these three will hold a write lock for the duration. To
-- avoid that, create them by hand with CONCURRENTLY first and then mark this
-- migration applied:
--   CREATE INDEX CONCURRENTLY "audit_logs_org_id_created_at_id_idx" ON ...
--   npx prisma migrate resolve --applied 20261002000000_audit_read_indexes

-- The keyset scan: (org_id, created_at, id) is a total order, so the
-- row-value predicate walks this index instead of sorting.
CREATE INDEX "audit_logs_org_id_created_at_id_idx" ON "audit_logs" ("org_id", "created_at", "id");

-- Filtered sinks, and the existing facets() query, which scanned.
CREATE INDEX "audit_logs_org_id_action_idx" ON "audit_logs" ("org_id", "action");
CREATE INDEX "audit_logs_org_id_resource_type_idx" ON "audit_logs" ("org_id", "resource_type");
