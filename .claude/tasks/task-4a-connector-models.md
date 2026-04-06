# Task 4A: Cloud Connector and Agent Prisma Models

**Agent:** db
**Status:** [ ] Pending
**Blocks:** 4B, 4C, 4D
**Blocked By:** none

## Objective
Define the database models for cloud connector integrations (AWS/Azure/GCP), sync history tracking, and on-premise agent registration. These models enable both cloud auto-discovery and agent-based server management.

## Deliverables

### Database Models (add to Prisma schema)

#### Enums
- `CloudProvider` — `aws`, `azure`, `gcp`
- `ConnectorStatus` — `active`, `inactive`, `error`, `syncing`
- `SyncStatus` — `pending`, `running`, `completed`, `failed`
- `AgentStatus` — `registered`, `active`, `stale`, `decommissioned`

#### CloudConnector
- id (uuid), org_id (FK Organization), customer_id (FK Customer, nullable — auto-assign discovered servers)
- name, provider (CloudProvider), status (ConnectorStatus, default active)
- credentials_encrypted (text — encrypted JSON: AWS keys, Azure service principal, GCP service account)
- regions (JSON array — list of regions to scan), filters (JSON — tag filters, instance state filters)
- sync_interval_minutes (int, default 60), last_sync_at (datetime, nullable), last_sync_status (SyncStatus, nullable)
- servers_discovered (int, default 0), servers_managed (int, default 0)
- created_at, updated_at
- Indexes: [org_id], [org_id, provider]

#### SyncHistory
- id (uuid), connector_id (FK CloudConnector)
- status (SyncStatus), started_at, completed_at (nullable)
- servers_found (int, default 0), servers_created (int, default 0), servers_updated (int, default 0), servers_removed (int, default 0)
- error_message (text, nullable), details (JSON, nullable — per-instance sync results)
- created_at
- Index: [connector_id, created_at]

#### AgentRegistration
- id (uuid), org_id (FK Organization), server_id (FK Server, nullable — linked after registration approval)
- agent_id (string, unique — generated during bootstrap), agent_token_hash (string)
- hostname, ip_address, os_type, os_version
- agent_version, status (AgentStatus, default registered)
- last_heartbeat (datetime, nullable), heartbeat_interval (int, default 60)
- metadata (JSON, nullable — additional system info: CPU, RAM, disk)
- approved_by (FK User, nullable), approved_at (datetime, nullable)
- created_at, updated_at
- Indexes: [org_id], [agent_id], [status]

### Migration
- Run `npx prisma migrate dev --name add_connectors_agents` to create migration

### Seed Updates
- Add sample CloudConnector record (AWS, us-east-1, inactive) to seed script
- Add sample AgentRegistration record to seed script

## Acceptance Criteria
- `npx prisma validate` passes with all new models
- Migration applies cleanly on top of existing schema
- CloudConnector credentials field stores encrypted JSON (encryption handled at application layer, DB stores ciphertext)
- SyncHistory has cascading delete when its parent CloudConnector is deleted
- AgentRegistration.agent_id is globally unique for agent identification
- AgentRegistration can exist without a linked server (pre-approval state)
- All new models include org_id for tenant isolation where applicable
- Seed script remains idempotent with new sample records
