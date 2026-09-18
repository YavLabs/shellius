-- Final reconciliation migration.
--
-- Brings any database (fresh, or one that already has every migration up to
-- this point applied) into exact alignment with prisma/schema.prisma.
--
-- Currently fixes:
--   - smtp_configs_org_id_fkey was originally created via an inline
--     `REFERENCES ... ON DELETE CASCADE` column constraint (see migration
--     20260407020000_add_smtp_config), which defaults ON UPDATE to NO ACTION.
--     Prisma's schema expects ON UPDATE CASCADE (its default for relations),
--     so `prisma migrate diff` reports this FK as different from schema.prisma
--     even though no application behavior actually depends on ON UPDATE
--     semantics for a cuid primary key. Recreate it with the correct action
--     so `migrate diff` against schema.prisma is empty.
--
-- Idempotent: safe to run whether or not the old FK still has its original
-- definition.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'smtp_configs_org_id_fkey'
  ) THEN
    ALTER TABLE "smtp_configs" DROP CONSTRAINT "smtp_configs_org_id_fkey";
  END IF;

  ALTER TABLE "smtp_configs"
    ADD CONSTRAINT "smtp_configs_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
END $$;
