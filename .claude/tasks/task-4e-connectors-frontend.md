# Task 4E: Cloud Connectors and Agent Management Frontend

**Agent:** frontend
**Status:** [ ] Pending
**Blocks:** none
**Blocked By:** 4C

## Objective
Build the frontend for managing cloud connectors (AWS/Azure/GCP), viewing sync history, managing on-premise agent registrations, and displaying bootstrap commands for new server onboarding.

## Deliverables

### Connectors Page
- `/frontend/src/pages/Connectors.jsx`:
  - Card grid: each connector shows name, provider icon (AWS/Azure/GCP), status badge, last sync time, servers discovered/managed counts
  - Provider icons: use Lucide Cloud icon with provider name, or provider-specific SVG icons
  - Status badges: active=green, inactive=gray, error=red, syncing=blue with pulse animation
  - "Add Connector" button
  - Card actions: Edit, Sync Now, Test Connection, Delete

### Connector Form
- `/frontend/src/components/connectors/ConnectorForm.jsx`:
  - Step 1: Provider selection (AWS/Azure/GCP cards)
  - Step 2: Credentials input (dynamic fields based on provider):
    - AWS: Access Key ID, Secret Access Key, Session Token (optional)
    - Azure: Tenant ID, Client ID, Client Secret, Subscription ID
    - GCP: Project ID, Service Account Key (JSON file upload or paste)
  - Step 3: Configuration — regions multi-select (populated from provider.getRegions after test), customer assignment (optional), sync interval (15/30/60/360 min dropdown), tag/label filters
  - "Test Connection" button between step 2 and 3 that validates credentials
  - Save button disabled until connection test passes

### Sync History Panel
- `/frontend/src/components/connectors/SyncHistory.jsx`:
  - Slide-out panel or expandable section on connector detail
  - Timeline/list view of sync runs: timestamp, status badge, duration, counts (found/created/updated/removed)
  - Failed syncs show error message in red
  - Click on a sync entry to see detailed per-instance results (if available)

### Agent Registrations Page
- `/frontend/src/pages/Agents.jsx`:
  - Table: hostname, IP, OS, agent version, status badge, last heartbeat (relative time), linked server, actions
  - Status badges: registered=yellow (pending approval), active=green, stale=orange, decommissioned=gray
  - Pending approval agents highlighted with action buttons: Approve, Reject
  - Approve dialog: option to link to existing server or create new server, select customer assignment

### Bootstrap Command Display
- `/frontend/src/components/agents/BootstrapCommand.jsx`:
  - Modal/dialog showing the curl command to bootstrap a new agent:
    ```
    curl -sSL https://<shellius-url>/api/agents/bootstrap.sh | SHELLIUS_URL=https://<url> BOOTSTRAP_TOKEN=<token> bash
    ```
  - Copy-to-clipboard button
  - Generate/rotate bootstrap token button
  - Instructions text explaining the bootstrap process

### Services
- `/frontend/src/services/connectorService.js` — API calls for connector CRUD, test, sync trigger, sync history
- `/frontend/src/services/agentService.js` — API calls for agent listing, approve, reject, decommission

### Navigation Update
- Update Sidebar to include "Connectors" and "Agents" nav items with appropriate Lucide icons (Cloud and Cpu respectively)

## Acceptance Criteria
- Connector form adapts credential fields dynamically based on selected provider
- Test Connection button provides clear success/failure feedback before allowing save
- Sync Now button triggers immediate sync and shows loading state, updates connector card on completion
- Sync history displays accurate counts and timestamps for each sync run
- Failed sync entries are visually distinct and show the error message
- Agent registrations page shows all agents with correct status badges
- Pending agents have prominent Approve/Reject action buttons
- Approve flow allows linking to existing server or creating a new one
- Bootstrap command dialog shows a valid, copy-ready curl command
- Copy-to-clipboard works and shows confirmation feedback
- All pages handle loading, empty, and error states gracefully
- Relative timestamps (e.g., "2 minutes ago") update or show tooltip with absolute time
- All components use plain JavaScript, Lucide icons, shadcn/ui primitives
