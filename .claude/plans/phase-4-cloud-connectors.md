# Phase 4: Cloud Connectors & Host Discovery

## Goal
Implement multi-cloud server auto-discovery (AWS, Azure, GCP), on-prem agent registration, bootstrap script, and periodic sync.

## Duration Estimate
2-3 weeks

## Dependencies
Phase 3 complete

## Tasks

### Task 4A: Cloud Connector Models [Agent: db]
**Status:** [ ] Pending

- Add CloudConnector model: org_id, customer_id (default), name, provider_type (aws/azure/gcp/on_prem), status, encrypted_credentials, credentials_iv, sync_interval_seconds, last_sync_at, last_sync_error, regions[], tag_filters, environment_tag_key, environment_tag_map
- Add SyncHistory model: connector_id, started_at, completed_at, status, servers_created/updated/removed, error_message, details
- Add AgentRegistration model: org_id, customer_id, agent_token (unique), server_id, is_used, expires_at
- Run migration

### Task 4B: Cloud Provider Adapters [Agent: backend]
**Status:** [ ] Pending
**Blocked By:** 4A

- Create providers/awsProvider.js:
  - Uses @aws-sdk/client-ec2, DescribeInstances
  - Maps EC2 fields to Server fields
  - Supports AssumeRole for cross-account
- Create providers/azureProvider.js:
  - Uses @azure/arm-compute, virtualMachines.listAll()
  - Maps Azure VM fields to Server fields
- Create providers/gcpProvider.js:
  - Uses @google-cloud/compute, aggregatedList()
  - Maps GCE fields to Server fields
- Each provider: fetchInstances(credentials, regions, tagFilters) -> standardized instance array

### Task 4C: Cloud Sync Service [Agent: backend]
**Status:** [ ] Pending
**Blocked By:** 4B

- Implement cloudSyncService.js:
  - sync(connectorId): fetch instances -> diff with existing -> create/update/terminate
  - Credential decryption for each provider
  - Environment tag mapping (cloud tags -> Shellius environment enum)
  - Never hard-delete: missing instances -> status=terminated
  - Record SyncHistory entry
- Implement routes/cloudConnectors.js:
  - CRUD for connectors (admin+)
  - POST /api/cloud-connectors/:id/sync (admin+ -- trigger immediate sync)
  - GET /api/cloud-connectors/:id/history (admin+)
- Implement jobs/cloudSync.js: BullMQ repeatable job per connector

### Task 4D: On-Prem Agent System [Agent: backend + devops]
**Status:** [ ] Pending
**Blocked By:** 4A

- Implement agent registration endpoints:
  - POST /api/orgs/:orgId/agent-registrations (admin+ -- generate one-time token)
  - POST /api/agents/register (agent calls with token -> gets agentId + CA public key)
  - POST /api/agents/heartbeat (agent calls every 60s -- update status, IP, OS, CA key hash)
- Implement jobs/agentHeartbeatCheck.js: every 2 min, mark servers offline if heartbeat missed >5 min
- Create scripts/bootstrap.sh:
  - Register with API, get agentId + CA public key
  - Install CA key to /etc/ssh/shellius_ca.pub
  - Configure sshd (TrustedUserCAKeys, AuthorizedPrincipalsCommand)
  - Install check-principals script
  - Set up systemd heartbeat timer
  - Restart sshd

### Task 4E: Cloud Connectors Frontend [Agent: frontend]
**Status:** [ ] Pending
**Blocked By:** 4C

- Build CloudConnectors page: connector list with provider icons, sync status, last sync time
- Build ConnectorForm dialog: provider selection, credential input, region/tag filters, environment tag mapping, default customer assignment
- Build SyncHistory panel: table of sync runs with created/updated/removed counts
- Add "Bootstrap Command" display in Settings page (shows curl command for on-prem agent setup)

## Acceptance Criteria
- Create AWS connector with credentials -> trigger sync -> EC2 instances appear as servers with correct environment tags
- Azure and GCP connectors work similarly
- Periodic sync runs automatically at configured interval
- New instances are created, changed instances updated, terminated instances marked (not deleted)
- On-prem: run bootstrap.sh on target -> server appears in UI with heartbeat
- If heartbeat stops, server status changes to offline
- SyncHistory shows accurate counts
