# Phase 2: Identity & Authentication

## Goal
Implement user authentication (email/password + SSO), JWT token management, device auth flow for TUI, user/group CRUD with RBAC, and manager relationships.

## Duration Estimate
2-3 weeks

## Dependencies
Phase 1 complete

## Tasks

### Task 2A: Auth System [Agent: backend]
**Status:** [ ] Pending
**Blocks:** 2C, 2D

- Add SsoConfig, DeviceAuthRequest models to Prisma schema
- Install: passport, passport-local, passport-openidconnect, bcryptjs, jsonwebtoken
- Implement authService.js:
  - login(email, password) -> { accessToken, refreshToken }
  - refreshToken(token) -> { accessToken, refreshToken }
  - logout(userId, tokenHash) -> revoke refresh token
  - validateToken(token) -> decoded payload
- Implement routes/auth.js:
  - POST /api/auth/login
  - POST /api/auth/refresh
  - POST /api/auth/logout
  - GET /api/auth/me

### Task 2B: SSO & Device Auth [Agent: backend]
**Status:** [ ] Pending
**Blocked By:** 2A

- Implement SSO flow with Passport OIDC strategy
  - POST /api/auth/sso/initiate
  - GET /api/auth/sso/callback
- Implement Device Authorization Flow (RFC 8628) for TUI:
  - POST /api/auth/device/authorize -> { device_code, user_code, verification_url, expires_in }
  - GET /api/auth/device/poll -> { status: "pending" | "approved", tokens? }
  - POST /api/auth/device/approve (web UI approves device)
- DeviceAuthRequest model: device_code, user_code, user_id, org_id, status, expires_at

### Task 2C: User & Group Management [Agent: backend]
**Status:** [ ] Pending
**Blocked By:** 2A

- Implement userService.js: CRUD, SSH public key upload, manager assignment
- Implement routes/users.js with RBAC:
  - GET /api/users (admin+)
  - GET /api/users/:id (admin+ or self)
  - POST /api/users (admin+)
  - PUT /api/users/:id (admin+)
  - DELETE /api/users/:id (admin+ -- soft delete, set status=deactivated)
  - POST /api/users/:id/ssh-key (self or admin+)
- Implement groupService.js and routes/groups.js: CRUD + member management
  - GET/POST/PUT/DELETE /api/groups (admin+)
  - POST /api/groups/:id/members (admin+)
  - DELETE /api/groups/:id/members/:userId (admin+)

### Task 2D: Auth Frontend [Agent: frontend]
**Status:** [ ] Pending
**Blocked By:** 2A

- Build Login page (email/password form, SSO button, device auth approval page)
- Implement AuthContext with JWT storage, refresh logic, role awareness
- Build OrgContext for tenant-scoped state
- Build Users page (data table, invite dialog, role management, manager column)
- Build Groups page (CRUD, member management)
- Protected route wrapper (redirect to login if unauthenticated)

## Acceptance Criteria
- Login with email/password returns JWT tokens
- Token refresh works before expiry
- RBAC blocks viewer from user management endpoints (403)
- SSO redirect initiates correctly
- Device auth flow: TUI gets code -> web approves -> TUI gets tokens
- Users page shows data table with role badges and manager column
