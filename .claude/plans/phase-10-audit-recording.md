# Phase 10: Audit & Session Recording

## Goal
Implement structured audit logging with action taxonomy, searchable/filterable UI, CSV/JSON export, session recording in asciinema format, and playback in the web UI.

## Duration Estimate
1-2 weeks

## Dependencies
Phase 8 complete (Web Terminal with session tracking)

## Tasks

### Task 10A: Audit Service Enhancement [Agent: backend]
- Define action taxonomy:
  - auth.login, auth.logout, auth.sso, auth.device_approve
  - user.create, user.update, user.delete
  - group.create, group.update, group.delete
  - customer.create, customer.update, customer.delete
  - server.create, server.update, server.delete, server.health_check
  - policy.create, policy.update, policy.delete
  - access_request.submit, access_request.approve, access_request.deny, access_request.expire, access_request.revoke
  - cert.issue, cert.revoke
  - session.start, session.end, session.terminate
  - ca.generate, ca.rotate
  - connector.create, connector.sync
  - org.update
- Enhance auditService.js: structured events with consistent fields
- Enhance routes/audit.js:
  - GET /api/audit (admin+) -- pagination, filters: action, actor, resource_type, date range, search
  - GET /api/audit/export (super_admin) -- CSV or JSON download

### Task 10B: Session Recording [Agent: backend]
Blocked by: 10A
- Enhance terminalService.js: tee SSH I/O to asciinema .cast file
  - .cast format: JSON header + timestamped event lines
  - Store files at configurable path (default: /data/recordings/)
  - Update Session record with recording_path
- Implement GET /api/sessions/:id/recording -- stream .cast file
- Implement jobs/sessionCleanup.js: clean stale sessions, archive old recordings (configurable retention)
- Implement jobs/auditArchive.js: optional -- compress old audit logs

### Task 10C: Audit & Sessions Frontend [Agent: frontend]
Blocked by: 10A, 10B
- Build AuditLog page: searchable data table with:
  - Action badge (color-coded by category)
  - Actor name (linked to user)
  - Resource type + ID
  - Timestamp
  - Metadata expandable row
  - Filters: action type, actor, resource, date range
  - Export button (CSV/JSON)
- Build Sessions page: two sections:
  - Active sessions: server, user, duration (live), terminate button
  - Historical sessions: sortable table with duration, recording icon
- Build SessionPlayer component: asciinema-player integration for recorded session playback
  - Play/pause, speed control, search in output
  - Linked from session detail

## Acceptance Criteria
- Audit log captures all actions with correct taxonomy
- AuditLog page renders with filters, search, pagination
- Export produces valid CSV/JSON with all fields
- Session recording creates .cast file during web terminal session
- SessionPlayer plays back recording with correct timing
- Session cleanup job removes recordings older than retention period
