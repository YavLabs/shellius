# Task 4C: Cloud Sync Service and Jobs

**Agent:** backend
**Status:** [ ] Pending
**Blocks:** 4E
**Blocked By:** 4B

## Objective
Build the cloud synchronization engine that uses provider adapters to discover instances, diffs them against existing servers in the database, and applies create/update/remove operations. Expose connector CRUD routes and schedule sync jobs via BullMQ.

## Deliverables

### Cloud Sync Service
- `/backend/src/services/cloudSyncService.js`:
  - `syncConnector(connectorId)` — main sync orchestrator:
    1. Load connector with decrypted credentials
    2. Set connector status to "syncing", create SyncHistory record with status "running"
    3. Call provider.fetchInstances() to get cloud instances
    4. Load existing servers linked to this connector (matched by cloud_instance_id + cloud_provider)
    5. Run diff algorithm:
       - **New**: cloud instances not in DB → create Server records (auto-assign customer_id from connector if set)
       - **Updated**: cloud instances matching existing servers with changed fields (IP, hostname, state, labels) → update Server records
       - **Removed**: DB servers whose cloud_instance_id is no longer in the cloud response → mark as inactive (soft-remove, don't delete)
    6. Update SyncHistory with counts (found, created, updated, removed) and status "completed"
    7. Update connector: last_sync_at, last_sync_status, servers_discovered, servers_managed
    8. On error: set SyncHistory status to "failed" with error_message, set connector status to "error"
  - `diffInstances(cloudInstances, dbServers)` — pure function returning { toCreate, toUpdate, toRemove } arrays
  - `decryptCredentials(encryptedJson)` — AES-256-GCM decrypt connector credentials
  - `encryptCredentials(jsonObject)` — AES-256-GCM encrypt connector credentials

### Connector Service
- `/backend/src/services/connectorService.js`:
  - `listConnectors(orgId)` — all connectors with last sync info
  - `getConnector(orgId, connectorId)` — detail with recent sync history
  - `createConnector(orgId, data)` — create connector, encrypt credentials, test connection before saving
  - `updateConnector(orgId, connectorId, data)` — update config, re-encrypt if credentials changed
  - `deleteConnector(orgId, connectorId)` — delete connector and all sync history (servers remain but lose cloud linkage)
  - `testConnector(orgId, connectorId)` — test connection with stored credentials
  - `getSyncHistory(orgId, connectorId, limit)` — paginated sync history for a connector
  - `triggerSync(orgId, connectorId)` — enqueue an immediate sync job

### Routes
- `/backend/src/routes/connectors.js`:
  - `GET /api/connectors` — list (admin+)
  - `GET /api/connectors/:id` — detail with sync history (admin+)
  - `POST /api/connectors` — create (super_admin)
  - `PUT /api/connectors/:id` — update (super_admin)
  - `DELETE /api/connectors/:id` — delete (super_admin)
  - `POST /api/connectors/:id/test` — test connection (admin+)
  - `POST /api/connectors/:id/sync` — trigger manual sync (admin+)
  - `GET /api/connectors/:id/history` — sync history (admin+)

### BullMQ Sync Jobs
- `/backend/src/jobs/cloudSync.js`:
  - Repeatable job per connector based on its sync_interval_minutes
  - Job processor: calls syncConnector(connectorId)
  - On connector create: add repeatable job
  - On connector update: update repeatable job interval
  - On connector delete: remove repeatable job
  - Manual sync: enqueue a one-time immediate job (deduplicated by connectorId)

## Acceptance Criteria
- Sync correctly identifies new, updated, and removed instances via the diff algorithm
- New cloud instances are created as Server records with all cloud fields populated
- Updated instances have their changed fields (IP, hostname, labels) updated in the database
- Removed instances are soft-deactivated (is_active=false), not hard-deleted
- Connector credentials are encrypted at rest and decrypted only during sync
- Test connection validates credentials before saving a new connector
- SyncHistory accurately tracks counts for each sync run
- Failed syncs record the error message and set connector status to "error"
- BullMQ repeatable jobs respect the configured interval per connector
- Manual sync trigger is deduplicated (can't queue multiple syncs for the same connector)
- Sync is tenant-isolated: connectors only create servers within their org
- Diff algorithm is a pure function with unit tests covering all edge cases
