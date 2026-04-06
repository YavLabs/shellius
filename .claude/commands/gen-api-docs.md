# /gen-api-docs

Generate API reference documentation from route files.

## Steps

1. **Scan all route files**
   ```bash
   ls backend/src/routes/*.js
   ```

2. **For each route file**, extract:
   - HTTP method (GET, POST, PUT, PATCH, DELETE)
   - Path pattern
   - Middleware (auth requirements, RBAC roles)
   - Request body schema (from Joi validation)
   - Response shape

3. **Generate `docs/api-reference.md`** with sections:
   - Table of contents
   - Authentication (JWT, how to get tokens)
   - Response envelope format
   - Error codes
   - Endpoints grouped by resource:
     - Auth
     - Users
     - Groups
     - Customers
     - Servers
     - Policies
     - Access Requests
     - Certificates
     - CA
     - Cloud Connectors
     - Agents
     - Sessions
     - Terminal (WebSocket)
     - Notifications
     - Audit
     - Organization
     - Health

4. **Report** — total endpoint count, any undocumented routes.
