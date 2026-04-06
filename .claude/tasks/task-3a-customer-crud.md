# Task 3A: Customer Model and CRUD

**Agent:** backend + db
**Status:** [ ] Pending
**Blocks:** 3B, 3D
**Blocked By:** none

## Objective
Implement the Customer entity as the second tier of the Org > Customer > Server hierarchy. Customers represent client organizations or business units whose servers are managed through Shellius. All customer data is scoped by org_id for tenant isolation.

## Deliverables

### Customer Service
- `/backend/src/services/customerService.js`:
  - `listCustomers(orgId, filters)` — paginated list with filters: search (name/code), is_active. Include server count aggregate.
  - `getCustomer(orgId, customerId)` — single customer with server count and recent servers summary
  - `createCustomer(orgId, data)` — create customer, validate code uniqueness within org, generate slug-style code if not provided
  - `updateCustomer(orgId, customerId, data)` — update name, description, is_active. Code is immutable after creation.
  - `deleteCustomer(orgId, customerId)` — soft-delete (set is_active false) if servers exist, hard-delete if no servers. Return error if active servers reference this customer.
  - `getCustomerStats(orgId, customerId)` — server count by environment, server count by status

### Routes
- `/backend/src/routes/customers.js`:
  - `GET /api/customers` — list (operator+)
  - `GET /api/customers/:id` — detail (operator+)
  - `POST /api/customers` — create (admin+)
  - `PUT /api/customers/:id` — update (admin+)
  - `DELETE /api/customers/:id` — delete (super_admin)
  - `GET /api/customers/:id/stats` — stats (operator+)

### Validation
- Customer code: alphanumeric + hyphens, 3-30 chars, lowercase
- Customer name: 2-100 chars, trimmed
- Unique constraint on [org_id, code] enforced at both application and database level

## Acceptance Criteria
- Customer CRUD is fully scoped to the authenticated user's org_id
- Customer code is unique per organization and immutable after creation
- Attempting to delete a customer with active servers returns 409 with descriptive error
- Deactivating a customer (is_active=false) does not affect its servers' status
- List endpoint returns server count per customer without N+1 queries (use _count or aggregate)
- Stats endpoint returns server breakdown by environment (demo/dev/staging/prod) and health status
- All mutations logged to AuditLog with before/after state
- Pagination supports both offset and cursor-based approaches
