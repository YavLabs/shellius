# Task 2A: Authentication Service and Routes

**Agent:** backend
**Status:** [ ] Pending
**Blocks:** 2B, 2C, 2D
**Blocked By:** none

## Objective
Implement the core authentication system: credential-based login, JWT access/refresh token issuance, token refresh flow, logout with token revocation, and a /me endpoint for the authenticated user profile.

## Deliverables

### Auth Service
- `/backend/src/services/authService.js` — core auth logic:
  - `login(email, password)` — validate credentials against User table (bcrypt compare), check UserStatus is active, generate access token (15min) + refresh token (7d), store refresh token hash in RefreshToken table, update last_login_at, return token pair + user profile
  - `refresh(refreshToken)` — validate refresh token hash exists and is not revoked/expired, issue new access token, optionally rotate refresh token (revoke old, issue new)
  - `logout(refreshToken)` — revoke the refresh token record, optionally revoke all tokens for the user
  - `getProfile(userId)` — return user with org details, excluding password_hash

### Token Utilities
- `/backend/src/utils/jwt.js` — generateAccessToken(payload), generateRefreshToken(payload), verifyAccessToken(token), verifyRefreshToken(token). Access tokens contain: userId, orgId, role, email. Refresh tokens contain: userId, tokenId.

### Routes
- `/backend/src/routes/auth.js`:
  - `POST /api/auth/login` — body: { email, password }. Returns: { accessToken, refreshToken, user }
  - `POST /api/auth/refresh` — body: { refreshToken }. Returns: { accessToken, refreshToken }
  - `POST /api/auth/logout` — body: { refreshToken }. Authenticated. Returns: 204
  - `GET /api/auth/me` — Authenticated. Returns: { user } with org info

### Validation
- Input validation using express-validator or manual checks for email format, password presence, token presence

## Acceptance Criteria
- Valid email/password returns 200 with access token (15min expiry) and refresh token (7d expiry)
- Invalid credentials return 401 with generic "Invalid email or password" message (no enumeration)
- Locked or inactive user accounts return 403 even with correct credentials
- Refresh endpoint issues a new access token and rotates the refresh token
- Using a revoked refresh token returns 401 and revokes all tokens for that user (token theft detection)
- Logout revokes the specific refresh token and returns 204
- GET /me returns the authenticated user profile without password_hash
- All auth actions are recorded in AuditLog via the audit middleware
- Refresh tokens are stored as SHA-256 hashes, never in plaintext
