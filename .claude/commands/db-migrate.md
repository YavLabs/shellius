# /db-migrate

Create or apply Prisma database migrations.

## Arguments

`$ARGUMENTS` — Optional: migration name (e.g., `add-cloud-connectors`). If empty, applies pending migrations.

## Steps

1. **Check current migration status**
   ```bash
   cd backend && npx prisma migrate status
   ```

2. **If migration name provided** — create new migration:
   ```bash
   cd backend && npx prisma migrate dev --name $ARGUMENTS
   ```

3. **If no migration name** — apply pending migrations:
   ```bash
   cd backend && npx prisma migrate dev
   ```

4. **Regenerate Prisma client**
   ```bash
   cd backend && npx prisma generate
   ```

5. **Validate schema**
   ```bash
   cd backend && npx prisma validate
   ```

6. **Run sanity check** — verify the database is accessible:
   ```bash
   cd backend && node -e "
     import { PrismaClient } from '@prisma/client';
     const prisma = new PrismaClient();
     await prisma.\$connect();
     console.log('Database connection OK');
     await prisma.\$disconnect();
   "
   ```

7. **Report results** — migration name, tables affected, any warnings.

## Error Handling

- If migration fails due to data conflict, print the SQL and suggest a manual fix.
- If database is not running, suggest: `/docker-up` first.
