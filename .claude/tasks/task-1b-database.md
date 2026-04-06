# Task 1B: Initial Prisma Schema and Migration

**Agent:** db
**Status:** [ ] Pending
**Blocks:** none
**Blocked By:** 1A

## Objective
Define the core data models in Prisma that represent the Organization-User-Customer hierarchy, along with auth and audit infrastructure. Run the initial migration to establish the baseline database schema.

## Deliverables
- `/backend/prisma/schema.prisma` — datasource (postgresql), generator (prisma-client-js), and the following models/enums:

### Enums
- `OrgRole` — `super_admin`, `admin`, `operator`, `viewer`
- `UserStatus` — `active`, `inactive`, `locked`, `pending_approval`

### Models
- `Organization` — id (uuid), name, slug (unique), domain, sso_enabled (bool), created_at, updated_at
- `User` — id (uuid), org_id (FK Organization), email (unique), password_hash, first_name, last_name, role (OrgRole), status (UserStatus), manager_id (FK self-ref User, nullable), ssh_public_key (text, nullable), last_login_at, created_at, updated_at. Indexes on org_id, manager_id, email.
- `Customer` — id (uuid), org_id (FK Organization), name, code (unique per org), description, is_active (bool), created_at, updated_at. Unique constraint on [org_id, code].
- `RefreshToken` — id (uuid), user_id (FK User), token_hash, expires_at, revoked (bool default false), created_at. Index on token_hash.
- `AuditLog` — id (uuid), org_id (FK Organization), user_id (FK User, nullable), action (string), resource_type (string), resource_id (string, nullable), details (JSON, nullable), ip_address, created_at. Indexes on org_id+created_at, user_id.

- `/backend/prisma/seed.js` — seed script creating a default organization ("Shellius Demo") and a super_admin user (admin@shellius.local / hashed password)
- Initial migration via `npx prisma migrate dev --name init`

## Acceptance Criteria
- `npx prisma validate` passes with no errors
- `npx prisma migrate dev` creates the migration SQL and applies it to the dev database
- All foreign keys have appropriate onDelete behavior (CASCADE for org children, SET NULL for manager_id)
- Self-referential manager_id on User allows null (top-level users) and references User.id
- Seed script is idempotent (can run multiple times without duplicating data)
- `npx prisma studio` shows all tables with correct columns and relationships
