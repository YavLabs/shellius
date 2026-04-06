# Shellius — Task Tracker

## Execution Order

Tasks are organized by phase. Each task has a designated agent, status, and blocking relationships. Execute tasks in order — blocked tasks cannot start until their blockers are complete.

**Status legend:** `[ ]` Pending | `[~]` In Progress | `[x]` Completed

---

## Phase 1: Foundation & .claude/ Setup
- [ ] [Task 1A: Project Scaffolding](task-1a-scaffolding.md) — **Agent:** devops — **Blocks:** 1B, 1C, 1D
- [ ] [Task 1B: Database Schema Init](task-1b-database.md) — **Agent:** db — **Blocked by:** 1A
- [ ] [Task 1C: Backend Core](task-1c-backend-core.md) — **Agent:** backend — **Blocked by:** 1A
- [ ] [Task 1D: Frontend Shell](task-1d-frontend-shell.md) — **Agent:** frontend — **Blocked by:** 1A

## Phase 2: Identity & Auth
- [ ] [Task 2A: Auth System](task-2a-auth-system.md) — **Agent:** backend — **Blocks:** 2B, 2C, 2D
- [ ] [Task 2B: SSO & Device Auth](task-2b-sso-device-auth.md) — **Agent:** backend — **Blocked by:** 2A
- [ ] [Task 2C: User & Group Management](task-2c-user-group-mgmt.md) — **Agent:** backend — **Blocked by:** 2A
- [ ] [Task 2D: Auth Frontend](task-2d-auth-frontend.md) — **Agent:** frontend — **Blocked by:** 2A

## Phase 3: Customer & Server Management
- [ ] [Task 3A: Customer CRUD](task-3a-customer-crud.md) — **Agent:** backend + db — **Blocks:** 3B, 3D
- [ ] [Task 3B: Server Model & CRUD](task-3b-server-crud.md) — **Agent:** backend + db — **Blocked by:** 3A — **Blocks:** 3C
- [ ] [Task 3C: Health Checks](task-3c-health-checks.md) — **Agent:** backend — **Blocked by:** 3B
- [ ] [Task 3D: Customer & Server Frontend](task-3d-customer-server-frontend.md) — **Agent:** frontend — **Blocked by:** 3A, 3B

## Phase 4: Cloud Connectors & Host Discovery
- [ ] [Task 4A: Cloud Connector Models](task-4a-connector-models.md) — **Agent:** db — **Blocks:** 4B, 4C, 4D
- [ ] [Task 4B: Cloud Provider Adapters](task-4b-cloud-providers.md) — **Agent:** backend — **Blocked by:** 4A — **Blocks:** 4C
- [ ] [Task 4C: Cloud Sync Service](task-4c-cloud-sync.md) — **Agent:** backend — **Blocked by:** 4B — **Blocks:** 4E
- [ ] [Task 4D: On-Prem Agent System](task-4d-onprem-agent.md) — **Agent:** backend + devops — **Blocked by:** 4A
- [ ] [Task 4E: Cloud Connectors Frontend](task-4e-connectors-frontend.md) — **Agent:** frontend — **Blocked by:** 4C

## Phase 5: SSH Certificate Authority
- [ ] [Task 5A: CA Models](task-5a-ca-models.md) — **Agent:** db — **Blocks:** 5B
- [ ] [Task 5B: CA Service](task-5b-ca-service.md) — **Agent:** backend — **Blocked by:** 5A — **Blocks:** 5C
- [ ] [Task 5C: Certificate Service & Routes](task-5c-cert-service.md) — **Agent:** backend — **Blocked by:** 5B — **Blocks:** 5D
- [ ] [Task 5D: CA Frontend](task-5d-ca-frontend.md) — **Agent:** frontend — **Blocked by:** 5C

## Phase 6: Access Policies
- [ ] [Task 6A: Policy Models](task-6a-policy-models.md) — **Agent:** db — **Blocks:** 6B
- [ ] [Task 6B: Policy Service](task-6b-policy-service.md) — **Agent:** backend — **Blocked by:** 6A — **Blocks:** 6C
- [ ] [Task 6C: Policy Frontend](task-6c-policy-frontend.md) — **Agent:** frontend — **Blocked by:** 6B

## Phase 7: Access Request & Approval Flow
- [ ] [Task 7A: Access Request Models](task-7a-request-models.md) — **Agent:** db — **Blocks:** 7B
- [ ] [Task 7B: Access Request Service](task-7b-request-service.md) — **Agent:** backend — **Blocked by:** 7A — **Blocks:** 7C, 7D, 7E
- [ ] [Task 7C: Access Request Routes](task-7c-request-routes.md) — **Agent:** backend — **Blocked by:** 7B — **Blocks:** 7E
- [ ] [Task 7D: Expiry Jobs](task-7d-expiry-jobs.md) — **Agent:** backend — **Blocked by:** 7B
- [ ] [Task 7E: Access Request Frontend](task-7e-request-frontend.md) — **Agent:** frontend — **Blocked by:** 7C

## Phase 8: Web Terminal
- [ ] [Task 8A: WebSocket SSH Proxy](task-8a-websocket-proxy.md) — **Agent:** backend — **Blocks:** 8B, 8C
- [ ] [Task 8B: Session Tracking](task-8b-session-tracking.md) — **Agent:** backend — **Blocked by:** 8A
- [ ] [Task 8C: Web Terminal Frontend](task-8c-terminal-frontend.md) — **Agent:** frontend — **Blocked by:** 8A

## Phase 9: TUI Client
- [ ] [Task 9A: Go Project Setup](task-9a-tui-setup.md) — **Agent:** tui — **Blocks:** 9B
- [ ] [Task 9B: Auth & API Client](task-9b-tui-auth-api.md) — **Agent:** tui — **Blocked by:** 9A — **Blocks:** 9C
- [ ] [Task 9C: TUI Views](task-9c-tui-views.md) — **Agent:** tui — **Blocked by:** 9B — **Blocks:** 9D
- [ ] [Task 9D: SSH Connection](task-9d-tui-ssh.md) — **Agent:** tui — **Blocked by:** 9C

## Phase 10: Audit & Session Recording
- [ ] [Task 10A: Audit Service Enhancement](task-10a-audit-service.md) — **Agent:** backend — **Blocks:** 10B, 10C
- [ ] [Task 10B: Session Recording](task-10b-session-recording.md) — **Agent:** backend — **Blocked by:** 10A — **Blocks:** 10C
- [ ] [Task 10C: Audit & Sessions Frontend](task-10c-audit-frontend.md) — **Agent:** frontend — **Blocked by:** 10A, 10B

## Phase 11: RDP Support
- [ ] [Task 11A: Guacamole Integration](task-11a-guacamole.md) — **Agent:** devops + backend — **Blocks:** 11B, 11C, 11D
- [ ] [Task 11B: RDP WebSocket Proxy](task-11b-rdp-proxy.md) — **Agent:** backend — **Blocked by:** 11A
- [ ] [Task 11C: RDP File Generation](task-11c-rdp-file.md) — **Agent:** backend — **Blocked by:** 11A
- [ ] [Task 11D: RDP Frontend](task-11d-rdp-frontend.md) — **Agent:** frontend — **Blocked by:** 11B

## Phase 12: Polish & Deployment
- [ ] [Task 12A: Dashboard](task-12a-dashboard.md) — **Agent:** frontend
- [ ] [Task 12B: Settings Page](task-12b-settings.md) — **Agent:** frontend
- [ ] [Task 12C: Production Docker](task-12c-prod-docker.md) — **Agent:** devops
- [ ] [Task 12D: Documentation](task-12d-docs.md) — **Agent:** devops + planner
- [ ] [Task 12E: Final Polish](task-12e-polish.md) — **Agent:** frontend

---

## Summary

| Phase | Tasks | Status |
|-------|-------|--------|
| 1. Foundation | 4 | Pending |
| 2. Auth | 4 | Pending |
| 3. Customer/Server | 4 | Pending |
| 4. Cloud Connectors | 5 | Pending |
| 5. SSH CA | 4 | Pending |
| 6. Policies | 3 | Pending |
| 7. Access Requests | 5 | Pending |
| 8. Web Terminal | 3 | Pending |
| 9. TUI Client | 4 | Pending |
| 10. Audit/Recording | 3 | Pending |
| 11. RDP | 4 | Pending |
| 12. Polish | 5 | Pending |
| **Total** | **48** | |
