# Task 1A: Project Scaffolding

**Agent:** devops
**Status:** [ ] Pending
**Blocks:** 1B, 1C, 1D
**Blocked By:** none

## Objective
Set up the monorepo structure, containerization, and development environment for Shellius. Establish the foundational directory layout, Docker configurations, and shared tooling so all other Phase 1 tasks can proceed in parallel.

## Deliverables
- `/.gitignore` — comprehensive ignore rules for Node.js, Go, IDE files, .env, node_modules, dist/, build/, prisma/migrations/*.sql backups, redis dumps
- `/.env.example` — template with all required env vars: DATABASE_URL, REDIS_URL, JWT_SECRET, JWT_REFRESH_SECRET, PORT, NODE_ENV, VITE_API_URL, SSO_*, CLOUD_PROVIDER_* placeholders
- `/docker-compose.yml` — development stack: postgres:16, redis:7, backend (Node.js 20), frontend (Vite dev server), nginx reverse proxy
- `/docker-compose.prod.yml` — production overrides: multi-stage builds, restart policies, healthchecks, named volumes, resource limits
- `/backend/Dockerfile` — multi-stage: build stage with prisma generate, production stage with node:20-slim
- `/frontend/Dockerfile` — multi-stage: build with Vite, serve with nginx:alpine
- `/nginx/nginx.conf` — reverse proxy config: /api/* to backend:3001, / to frontend:5173 (dev) or frontend container (prod), WebSocket upgrade headers for future terminal support
- `/backend/package.json` — initial dependencies: express, prisma, @prisma/client, ioredis, bullmq, jsonwebtoken, bcryptjs, cors, helmet, express-rate-limit, dotenv, winston
- `/frontend/package.json` — initial dependencies: react, react-dom, react-router-dom, @tanstack/react-query, axios, tailwindcss, clsx, lucide-react
- `/tui/` — empty Go module scaffold: go.mod, main.go stub

## Acceptance Criteria
- `docker-compose up` starts postgres, redis, backend, frontend, and nginx without errors
- `.env.example` documents every variable used across all services
- Backend container can reach postgres and redis by service name
- Frontend dev server is accessible through nginx at localhost:80
- All Dockerfiles use multi-stage builds with explicit non-root users
- `/tui/go.mod` initializes with module path `github.com/shellius/tui`
- `.gitignore` prevents committing node_modules, .env, dist/, and database dumps
