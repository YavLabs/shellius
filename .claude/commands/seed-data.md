# /seed-data

Populate the database with test data for development.

## Arguments

`$ARGUMENTS` — Optional: `minimal`, `full` (default), `reset`.

## Steps

1. **Parse mode** from `$ARGUMENTS` (default: `full`)

2. **If `reset`** — clear all data first:
   ```bash
   cd backend && npx prisma migrate reset --force
   ```

3. **Run seed script**
   ```bash
   cd backend && npx prisma db seed
   ```

## Seed Data (full mode)

### Organizations (2)
- Shellius Demo Org (`shellius-demo`)
- Acme Corporation (`acme-corp`)

### Users per org (5)
- Admin: `admin@shellius.local` / `Shellius2024!` (super_admin)
- Manager: `manager@shellius.local` (admin, manages operators)
- Operator 1: `operator1@shellius.local` (operator, reports to manager)
- Operator 2: `operator2@shellius.local` (operator, reports to manager)
- Viewer: `viewer@shellius.local` (viewer)

### Customers per org (3)
- "Web Platform" (slug: `web-platform`)
- "Mobile App" (slug: `mobile-app`)
- "Data Pipeline" (slug: `data-pipeline`)

### Servers (12 per org)
- 4 per customer: 1 prod, 1 staging, 1 dev, 1 demo
- Mix of SSH and RDP servers
- Various OS types (Ubuntu 22.04, Debian 12, Windows Server 2022)
- Realistic IPs, hostnames, and labels

### Groups (3)
- "Backend Team" — operator1
- "Frontend Team" — operator2
- "DevOps" — operator1, operator2

### Access Policies (5)
- Dev/demo access for all operators (auto-approve)
- Staging access for DevOps group (require approval)
- Prod access for Backend Team on Web Platform (require approval)
- Viewer read-only (no server access)
- Deny policy for terminated servers

### Certificates (10)
- 5 active (various TTLs)
- 3 expired
- 2 revoked

### Access Requests (8)
- 2 pending (awaiting manager approval)
- 3 approved (active)
- 2 denied
- 1 expired

### Audit Log (50 entries)
- Login events, access requests, certificate issuance, server registration

### Cloud Connectors (2)
- AWS connector (us-east-1, us-west-2)
- Azure connector (eastus)

## Minimal mode
- 1 org, 2 users (admin + operator), 1 customer, 2 servers (1 prod, 1 dev), 1 policy
