# Task 3D: Customer and Server Management Frontend

**Agent:** frontend
**Status:** [ ] Pending
**Blocks:** none
**Blocked By:** 3A, 3B

## Objective
Build the frontend pages for managing customers and servers, including list views, detail views, forms, and environment/health status visualization. These pages form the primary operational interface of Shellius.

## Deliverables

### Customers Page
- `/frontend/src/pages/Customers.jsx`:
  - Card grid view (default) and table view toggle
  - Each card: customer name, code badge, server count, active/inactive status indicator
  - Search bar filtering by name/code
  - "Add Customer" button with slide-out form panel
  - Click-through to customer detail

### Customer Detail
- `/frontend/src/pages/CustomerDetail.jsx`:
  - Header: customer name, code, description, active status toggle
  - Stats row: total servers, healthy/unhealthy/unknown counts, servers by environment (mini bar chart or badges)
  - Servers table (embedded) for this customer with all server columns
  - "Add Server" button
  - Edit/Delete actions in header dropdown

### Customer Form
- `/frontend/src/components/customers/CustomerForm.jsx` — name, code (auto-generated slug from name, editable on create, disabled on edit), description textarea, is_active toggle

### Servers Page
- `/frontend/src/pages/Servers.jsx`:
  - Data table with columns: Hostname, IP Address, Customer, Environment, Protocol, Health Status, OS, Last Check, Actions
  - Environment badges with distinct colors: demo=gray, dev=blue, staging=amber, prod=red
  - Health status indicators: healthy=green dot, unhealthy=red dot, unknown=gray dot, maintenance=yellow dot
  - Filter bar: environment multi-select, health status multi-select, customer dropdown, search text
  - Bulk actions: select multiple servers, bulk change environment
  - "Add Server" button

### Server Detail
- `/frontend/src/pages/ServerDetail.jsx`:
  - Header: hostname, display name, health status badge, environment badge
  - Info sections: Connection (IP, port, protocol, ssh_user), Cloud (provider, instance_id, region, account), Agent (agent_id, version, last_seen), System (OS type/version)
  - Labels displayed as tag chips with add/remove capability
  - "Run Health Check" button triggering on-demand check
  - Edit/Delete actions

### Server Form
- `/frontend/src/components/servers/ServerForm.jsx`:
  - Sections: Basic Info (hostname, display_name, description), Connection (ip_address with format validation, port, protocol radio, ssh_user), Environment (select), Labels (tag input), Cloud Info (optional: provider, instance_id, region)
  - IP address validation on blur
  - Port defaults to 22 for SSH, 3389 for RDP

### Services
- `/frontend/src/services/customerService.js` — API calls for customer CRUD and stats
- `/frontend/src/services/serverService.js` — API calls for server CRUD, bulk operations, health check trigger

## Acceptance Criteria
- Customers page displays all customers for the user's org with accurate server counts
- Customer detail shows aggregated server health statistics
- Server list is filterable by environment, health status, customer, and free text
- Environment badges use consistent color coding across all views
- Health status dots animate/pulse for recently checked servers
- Server form validates IP address format and auto-sets default port based on protocol
- Bulk environment update works for multi-selected servers with confirmation dialog
- On-demand health check button shows loading state and updates status on completion
- Labels can be added/removed inline on the server detail page
- All pages handle empty states with helpful messages and action CTAs
- Navigation between customers and their servers is seamless (breadcrumbs update)
