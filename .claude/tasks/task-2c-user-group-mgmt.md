# Task 2C: User and Group Management

**Agent:** backend
**Status:** [ ] Pending
**Blocks:** none
**Blocked By:** 2A

## Objective
Build complete CRUD for users (including manager hierarchy and SSH key management) and groups (including membership), enforced by RBAC. This establishes the identity layer that access policies will reference.

## Deliverables

### Database Models (add to Prisma schema)
- `Group` — id (uuid), org_id (FK Organization), name, description, created_at, updated_at. Unique constraint on [org_id, name].
- `GroupMembership` — id (uuid), group_id (FK Group), user_id (FK User), added_by (FK User), created_at. Unique constraint on [group_id, user_id].

### User Service
- `/backend/src/services/userService.js`:
  - `listUsers(orgId, filters)` — paginated list with filters: role, status, managerId, search (email/name). Include manager relation.
  - `getUser(orgId, userId)` — single user with manager and direct reports
  - `createUser(orgId, data)` — create user with hashed password, validate manager_id belongs to same org, validate role permissions (only admin+ can create admins)
  - `updateUser(orgId, userId, data)` — update fields, re-validate manager hierarchy (prevent circular refs)
  - `deleteUser(orgId, userId)` — soft-delete (set status to inactive) or hard-delete if no audit trail references
  - `uploadSshKey(orgId, userId, publicKey)` — validate SSH public key format (ssh-rsa/ssh-ed25519/ecdsa), store on user record
  - `removeSshKey(orgId, userId)` — clear SSH key from user record
  - `getDirectReports(orgId, managerId)` — list all users where manager_id matches

### Group Service
- `/backend/src/services/groupService.js`:
  - `listGroups(orgId)` — all groups with member count
  - `getGroup(orgId, groupId)` — group with full member list
  - `createGroup(orgId, data)` — create group
  - `updateGroup(orgId, groupId, data)` — update name/description
  - `deleteGroup(orgId, groupId)` — delete group and all memberships
  - `addMember(orgId, groupId, userId, addedBy)` — add user to group
  - `removeMember(orgId, groupId, userId)` — remove user from group
  - `getUserGroups(orgId, userId)` — list groups a user belongs to

### Routes
- `/backend/src/routes/users.js`:
  - `GET /api/users` — list (admin+)
  - `GET /api/users/:id` — detail (admin+ or self)
  - `POST /api/users` — create (admin+)
  - `PUT /api/users/:id` — update (admin+)
  - `DELETE /api/users/:id` — delete (super_admin)
  - `PUT /api/users/:id/ssh-key` — upload key (admin+ or self)
  - `DELETE /api/users/:id/ssh-key` — remove key (admin+ or self)
  - `GET /api/users/:id/reports` — direct reports (admin+)

- `/backend/src/routes/groups.js`:
  - `GET /api/groups` — list (operator+)
  - `GET /api/groups/:id` — detail (operator+)
  - `POST /api/groups` — create (admin+)
  - `PUT /api/groups/:id` — update (admin+)
  - `DELETE /api/groups/:id` — delete (admin+)
  - `POST /api/groups/:id/members` — add member (admin+)
  - `DELETE /api/groups/:id/members/:userId` — remove member (admin+)

## Acceptance Criteria
- User CRUD is scoped to the authenticated user's org_id (tenant isolation)
- manager_id must reference a user in the same org; circular manager chains are rejected
- SSH key upload validates format and rejects invalid keys with a descriptive error
- Only super_admin can delete users; only admin+ can create/update
- Users can update their own profile (name, SSH key) but not their role or status
- Group names are unique per organization
- Adding a duplicate member to a group returns 409 Conflict
- All mutations are recorded in AuditLog with before/after state in details JSON
- Paginated user list supports cursor or offset pagination with configurable page size
