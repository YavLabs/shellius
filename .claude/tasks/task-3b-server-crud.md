# Task 3B: Server Model and CRUD

**Agent:** backend + db
**Status:** [ ] Pending
**Blocks:** 3C
**Blocked By:** 3A

## Objective
Define the Server model with comprehensive fields covering SSH/RDP access, cloud metadata, environment classification, health status, and agent information. Implement CRUD routes nested under the customer resource to enforce the Customer > Server hierarchy.

## Deliverables

### Database Model (add to Prisma schema)
- `Environment` enum — `demo`, `dev`, `staging`, `prod`
- `ServerProtocol` enum — `ssh`, `rdp`, `both`
- `HealthStatus` enum — `healthy`, `unhealthy`, `unknown`, `maintenance`
- `Server` model:
  - id (uuid), org_id (FK Organization), customer_id (FK Customer)
  - hostname, display_name, description
  - ip_address, port (int, default 22), protocol (ServerProtocol, default ssh)
  - environment (Environment), labels (JSON, default [])
  - os_type (string, nullable: "linux", "windows", "macos"), os_version (string, nullable)
  - cloud_provider (string, nullable: "aws", "azure", "gcp", "other"), cloud_instance_id (string, nullable), cloud_region (string, nullable), cloud_account_id (string, nullable)
  - agent_id (string, nullable, unique), agent_version (string, nullable), agent_last_seen (datetime, nullable)
  - health_status (HealthStatus, default unknown), last_health_check (datetime, nullable), health_message (string, nullable)
  - ssh_user (string, default "root"), ssh_key_path (string, nullable)
  - is_active (bool, default true), created_at, updated_at
  - Indexes: [org_id, customer_id], [org_id, environment], [cloud_instance_id], [agent_id], [health_status]

### Server Service
- `/backend/src/services/serverService.js`:
  - `listServers(orgId, customerId, filters)` — paginated, filters: environment, health_status, cloud_provider, search (hostname/ip/display_name), labels (array intersection), is_active
  - `getServer(orgId, serverId)` — full server detail with customer info
  - `createServer(orgId, customerId, data)` — validate customer belongs to org, validate IP format, set initial health_status to unknown
  - `updateServer(orgId, serverId, data)` — update mutable fields, validate environment transitions if rules apply
  - `deleteServer(orgId, serverId)` — hard-delete with confirmation, audit logged
  - `bulkUpdateEnvironment(orgId, serverIds, environment)` — batch update environment for multiple servers
  - `getServersByLabel(orgId, labels)` — find servers matching any of the given labels across all customers

### Routes
- `/backend/src/routes/servers.js`:
  - `GET /api/customers/:customerId/servers` — list servers for a customer (operator+)
  - `GET /api/servers` — list all servers across customers (operator+), with customer filter
  - `GET /api/servers/:id` — server detail (operator+)
  - `POST /api/customers/:customerId/servers` — create server (admin+)
  - `PUT /api/servers/:id` — update server (admin+)
  - `DELETE /api/servers/:id` — delete server (super_admin)
  - `POST /api/servers/bulk/environment` — bulk update environment (admin+)

## Acceptance Criteria
- Server CRUD enforces org_id scoping throughout — no cross-tenant data leaks
- Creating a server under a customer that belongs to a different org returns 403
- IP address is validated (IPv4 or IPv6 format)
- Labels are stored as JSON array and queryable (filter servers by label)
- Environment badges map to distinct colors: demo=gray, dev=blue, staging=amber, prod=red
- Health status is read-only via CRUD (updated only by health check service)
- Agent fields (agent_id, agent_version, agent_last_seen) are read-only via CRUD (updated by agent heartbeat)
- Cloud fields are nullable for on-prem servers and populated by cloud sync for cloud servers
- Bulk environment update validates all server IDs belong to the same org
- Server list across all customers supports filtering by customer_id
