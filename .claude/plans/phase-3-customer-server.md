# Phase 3: Customer & Server Management

## Goal
Implement the Customer-Server hierarchy with environment tagging, labels, manual server registration, and health checks.

## Duration Estimate
1-2 weeks

## Dependencies
Phase 2 complete

## Tasks

### Task 3A: Customer CRUD [Agent: backend + db]
**Status:** [ ] Pending

- Add Customer model to Prisma if not already present (org_id, name, slug, description, metadata, is_active)
- Implement customerService.js: CRUD scoped by org_id
- Implement routes/customers.js:
  - GET /api/customers (all roles)
  - GET /api/customers/:id (all roles)
  - POST /api/customers (admin+)
  - PUT /api/customers/:id (admin+)
  - DELETE /api/customers/:id (admin+ -- soft delete)
  - GET /api/customers/:id/servers (all roles -- filtered by policy)

### Task 3B: Server Model & CRUD [Agent: backend + db]
**Status:** [ ] Pending
**Blocked By:** 3A

- Add Server model with all fields:
  - Core: hostname, display_name, ip_address, public_ip, port, protocol (ssh/rdp/both), os_type, os_version
  - Hierarchy: customer_id FK
  - Environment: environment enum (demo/dev/staging/prod)
  - Status: status enum (running/stopped/terminated/offline/unknown)
  - Labels: JSON key-value tags
  - Cloud: cloud_provider, cloud_instance_id, cloud_region, cloud_vpc_id, cloud_connector_id
  - Agent: agent_id (unique), last_heartbeat
- Add enums: EnvironmentTag, ServerStatus, ServerProtocol
- Implement serverService.js: CRUD, label filtering, status tracking
- Implement routes/servers.js:
  - GET /api/servers (all -- filtered by user's policy access)
  - GET /api/servers/:id (all -- policy filtered)
  - POST /api/customers/:customerId/servers (admin+)
  - PUT /api/servers/:id (admin+)
  - DELETE /api/servers/:id (admin+ -- mark terminated, never hard delete)
  - POST /api/servers/:id/check (operator+ -- trigger health check)
  - GET /api/servers/labels (all -- unique label keys/values)

### Task 3C: Health Checks [Agent: backend]
**Status:** [ ] Pending
**Blocked By:** 3B

- Implement healthCheckService.js: TCP connect check for SSH (port 22) and RDP (port 3389)
- Implement jobs/hostHealthCheck.js: BullMQ repeatable job (every 5 min)
- Update server status based on health check results

### Task 3D: Customer & Server Frontend [Agent: frontend]
**Status:** [ ] Pending
**Blocked By:** 3A, 3B

- Build Customers page: data table with server count column, create/edit dialog
- Build CustomerDetail page: customer info + server list
- Build Servers page: data table with environment badges (color-coded), status indicators (Lucide Server/Monitor icons), label pills
- Build ServerDetail page: connection info, labels editor, health history
- Build ServerForm dialog: register new server (hostname, port, type, customer, environment, labels)
- Build EnvironmentBadge component: prod=red, staging=yellow, dev=green, demo=blue
- Build ServerStatusBadge: green/red/yellow dot with Lucide icons

## Acceptance Criteria
- Create customer, see it in list
- Register server under customer with environment=prod tag
- Server appears in customer detail page
- Health check runs and updates server status
- Environment badges render with correct colors
- Label filtering works on server list
