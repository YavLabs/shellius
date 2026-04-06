# Phase 12: Polish & Deployment

## Goal
Build the Dashboard page, Settings page, production Docker configuration, documentation, and Traefik integration. Final polish pass.

## Duration Estimate
1-2 weeks

## Dependencies
All previous phases substantially complete

## Tasks

### Task 12A: Dashboard [Agent: frontend]
- Build Dashboard page with overview cards:
  - Total servers (by environment breakdown)
  - Active sessions count
  - Pending access requests (for managers)
  - Recently issued certificates
  - Cloud connector sync status
- Quick actions: "Request Access", "View My Certs", "Browse Servers"
- "My Access" panel: servers user can access with expiry countdown, grouped by customer
- Recent activity feed (last 10 audit events)

### Task 12B: Settings Page [Agent: frontend]
- Build Settings page with sections:
  - Organization: name, domain, logo
  - CA Management: current key fingerprint, public key (copyable), rotate button
  - SSO Configuration: provider, client ID, issuer URL, test connection
  - Cloud Connectors: quick links to connector management
  - Notification Preferences: email notifications toggle

### Task 12C: Production Docker [Agent: devops]
- Create docker-compose.yml (production) with:
  - All services: postgres, redis, backend, frontend, guacd, nginx
  - Resource limits (memory, CPU)
  - Restart policies (unless-stopped)
  - Named volumes for persistent data
  - No exposed ports except nginx (80/443)
  - Health checks on all services
- Add Traefik labels for reverse proxy integration
- Add Prometheus metrics endpoint /api/metrics to backend
- Create backup scripts for database and recordings

### Task 12D: Documentation [Agent: devops + planner]
- Write docs/architecture.md -- system overview, component diagram, data flow
- Write docs/ssh-ca-flow.md -- detailed SSH CA and certificate flow
- Write docs/host-setup.md -- how to configure target hosts to trust Shellius CA
- Write docs/bootstrap-guide.md -- step-by-step on-prem agent setup
- Write docs/deployment.md -- production deployment guide
- Write docs/tui-usage.md -- TUI installation and usage guide
- Write docs/api-reference.md -- generated from routes

### Task 12E: Final Polish [Agent: frontend]
- Add loading skeletons across all pages
- Add empty states with helpful messages
- Add error boundaries at page level
- Responsive design pass (tablet and narrow screens)
- Keyboard shortcuts (/ for search, g+d for dashboard, g+s for servers)
- 404 and error pages

## Acceptance Criteria
- Dashboard shows accurate overview with real data
- Settings page allows org, CA, SSO configuration
- Production docker-compose starts all services with health checks passing
- All documentation is complete and accurate
- Loading states, empty states, and errors are handled gracefully
- Traefik integration works for reverse proxy with TLS
