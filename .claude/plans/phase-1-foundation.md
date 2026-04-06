# Phase 1: Foundation & .claude/ Setup

## Goal
Set up the monorepo structure, Docker infrastructure, initial database schema, Express API skeleton, React frontend shell, and all .claude/ configuration files.

## Duration Estimate
1-2 weeks

## Tasks

### Task 1A: Project Scaffolding [Agent: devops]
**Status:** [ ] Pending
**Blocks:** 1B, 1C, 1D

- Initialize git repo
- Create .gitignore (node_modules, dist, .env, *.pem, *.key, dump.rdb)
- Create .env.example with all env vars documented:
  - DATABASE_URL, REDIS_URL
  - JWT_SECRET, JWT_REFRESH_SECRET, JWT_EXPIRY, JWT_REFRESH_EXPIRY
  - SERVER_ENCRYPTION_KEY (for CA key encryption)
  - SSO_CLIENT_ID, SSO_CLIENT_SECRET, SSO_ISSUER_URL
  - GUACAMOLE_URL
  - AWS/Azure/GCP connector env vars (optional)
- Create docker-compose.dev.yml (postgres:16, redis:7)
- Create docker-compose.yml (production with all services)
- Create docker/Dockerfile.backend (Node.js 20 alpine, multi-stage)
- Create docker/Dockerfile.frontend (Vite build + nginx)
- Create docker/nginx.conf (reverse proxy, WebSocket upgrade, security headers)

### Task 1B: Database Schema Init [Agent: db]
**Status:** [ ] Pending
**Blocked By:** 1A

- Initialize backend/package.json with dependencies
- Create initial Prisma schema with core models:
  - Organization (id, name, slug, domain, settings, created_at, updated_at)
  - User (id, org_id, email, name, role, manager_id, status, ssh_public_key, sso_provider, sso_sub, avatar_url, last_login_at, created_at, updated_at)
  - Customer (id, org_id, name, slug, description, metadata, is_active, created_at, updated_at)
  - RefreshToken (id, user_id, token_hash, client_type, ip_address, user_agent, expires_at, created_at)
  - AuditLog (id, org_id, actor_id, action, resource_type, resource_id, metadata, ip_address, created_at)
- Create enums: OrgRole, UserStatus
- Run initial migration

### Task 1C: Backend Core [Agent: backend]
**Status:** [ ] Pending
**Blocked By:** 1A

- Create backend/src/app.js (Express setup, middleware chain, health endpoint)
- Create backend/src/config/db.js (Prisma client singleton)
- Create backend/src/config/redis.js (ioredis connection)
- Create backend/src/config/auth.js (JWT config)
- Create middleware: auth.js, rbac.js, audit.js, tenant.js, errorHandler.js, rateLimiter.js
- Create utils: validators.js, formatters.js, crypto.js
- Health endpoint: GET /api/health (check DB, Redis connectivity)
- Response envelope utility: { success, data, error, meta }

### Task 1D: Frontend Shell [Agent: frontend]
**Status:** [ ] Pending
**Blocked By:** 1A

- Initialize frontend/ with Vite + React 18
- Install: tailwindcss, shadcn/ui, lucide-react, react-router-dom, axios
- Configure Tailwind with shadcn/ui theme
- Create layout shell: Sidebar.jsx, Topbar.jsx, MainLayout.jsx
- Create AuthContext.jsx (stub -- JWT storage, user state)
- Create ThemeContext.jsx (dark mode toggle)
- Create services/api.js (Axios instance with interceptors for auth + refresh)
- Create Login.jsx page (stub)
- Create Dashboard.jsx page (stub)
- Set up React Router with layout

## Acceptance Criteria
- `docker compose -f docker-compose.dev.yml up -d` starts postgres + redis
- `cd backend && npm install && npx prisma migrate dev` succeeds
- `cd backend && node src/app.js` starts Express on port 3001
- `curl localhost:3001/api/health` returns `{ success: true, data: { db: "ok", redis: "ok" } }`
- `cd frontend && npm install && npm run dev` starts Vite on port 5173
- Frontend shows sidebar + topbar layout shell
