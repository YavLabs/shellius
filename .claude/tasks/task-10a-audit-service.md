# Task 10A: Enhanced Audit Service

**Agent:** backend
**Status:** [ ] Pending
**Blocks:** 10B, 10C
**Blocked By:** None

## Objective
Define a comprehensive audit action taxonomy and enhance the existing auditService with advanced filtering, search, and export capabilities.

## Deliverables
- `src/constants/auditActions.js` — audit action taxonomy:
  - AUTH: login, logout, login_failed, token_refresh, mfa_verified
  - USER: created, updated, deleted, role_changed, group_changed
  - SERVER: created, updated, deleted, synced, health_changed
  - CA: keypair_generated, keypair_rotated, cert_signed, cert_revoked
  - POLICY: created, updated, deleted, evaluated
  - REQUEST: submitted, approved, denied, expired, revoked, credentials_generated
  - SESSION: started, ended, terminated, recorded
  - SYSTEM: settings_changed, backup_created, import_completed
- Enhanced `src/services/auditService.js`:
  - `log({ action, actorId, targetType, targetId, metadata, ipAddress })` — structured audit entry
  - `query({ actions[], actorId, targetType, targetId, dateRange, search, page, limit })` — advanced filtering
  - `export({ filters, format })` — export to CSV or JSON
  - `getTimeline(targetType, targetId)` — chronological event timeline for a specific resource
  - `getStats(dateRange)` — aggregated audit statistics (events by type, top actors, etc.)
- Enhanced `src/routes/auditRoutes.js`:
  - GET /audit — advanced filtered listing
  - GET /audit/export — CSV/JSON export download
  - GET /audit/timeline/:targetType/:targetId — resource timeline
  - GET /audit/stats — aggregated statistics

## Acceptance Criteria
- All existing audit logging calls updated to use new taxonomy
- Query supports combining multiple filters (AND logic)
- Full-text search works across action, actor name, and metadata
- CSV export generates valid downloadable file with all fields
- Timeline returns chronological events for any resource type
- Stats endpoint returns meaningful aggregations for dashboard use
- Audit routes restricted to admin role (except own-activity view)
