# Task 1C: Express Backend Core Setup

**Agent:** backend
**Status:** [ ] Pending
**Blocks:** none
**Blocked By:** 1A

## Objective
Stand up the Express application with all foundational middleware, configuration modules, utility functions, and a health endpoint. This establishes the backend skeleton that all subsequent feature tasks build upon.

## Deliverables

### Application Entry
- `/backend/src/app.js` — Express app creation, middleware registration order, route mounting, global error handler attachment
- `/backend/src/server.js` — HTTP server startup, graceful shutdown (SIGTERM/SIGINT), port binding from config

### Configuration
- `/backend/src/config/db.js` — Prisma client singleton with connection logging
- `/backend/src/config/redis.js` — ioredis client with reconnect strategy, error handling
- `/backend/src/config/auth.js` — JWT secrets, expiry durations, bcrypt rounds from env vars with sensible defaults
- `/backend/src/config/index.js` — aggregated config export (port, nodeEnv, cors origins, rate limit windows)

### Middleware
- `/backend/src/middleware/auth.js` — JWT verification middleware, extracts user from token, attaches to req.user
- `/backend/src/middleware/rbac.js` — role-based access control factory: `requireRole(...roles)` returns middleware checking req.user.role against allowed roles
- `/backend/src/middleware/audit.js` — logs action, resource_type, resource_id, user_id, ip_address to AuditLog table
- `/backend/src/middleware/tenant.js` — extracts org_id from authenticated user, attaches to req.orgId for query scoping
- `/backend/src/middleware/errorHandler.js` — catches all errors, formats JSON response with status/message/stack(dev only), logs via winston
- `/backend/src/middleware/rateLimiter.js` — express-rate-limit configured per route group (auth: 10/min, api: 100/min)

### Utilities
- `/backend/src/utils/logger.js` — winston logger: console transport (dev), JSON transport (prod), request-id correlation
- `/backend/src/utils/asyncHandler.js` — wraps async route handlers to forward errors to next()
- `/backend/src/utils/ApiError.js` — custom error class with statusCode, message, isOperational flag

### Routes
- `/backend/src/routes/health.js` — GET /health returns { status: "ok", timestamp, db: "connected"|"error", redis: "connected"|"error" } after pinging both services

## Acceptance Criteria
- `GET /health` returns 200 with db and redis status when both are reachable
- `GET /health` returns 200 with degraded status fields when a dependency is down (does not crash)
- Unauthenticated requests to protected routes return 401 with JSON error body
- Requests from a `viewer` role to an `admin`-only route return 403
- Rate limiter returns 429 after exceeding configured threshold
- All unhandled errors are caught by errorHandler and return structured JSON (never HTML)
- Logger outputs structured JSON in production mode and readable format in development
- Prisma client disconnects cleanly on SIGTERM
