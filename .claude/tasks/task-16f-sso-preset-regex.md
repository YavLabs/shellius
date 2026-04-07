# Task 16F: SSO Preset Field Client-Side Regex

**Agent:** frontend + backend
**Status:** [x] Done
**Blocks:** 16Q-F, 16R-F
**Blocked By:** None
**Model:** sonnet

## Objective
Follow-up to Phase 15R-E medium: `deriveIssuerUrl` interpolates
user-typed `tenantId`/`oktaDomain`/`auth0Domain` with no client-side
guard. Backend Joi + SSRF guard stop exploits, but the UI could
present a confusing URL preview.

## Deliverables
- Frontend `Settings.jsx` SsoTab: inline regex validation per field:
  - `tenantId`: `/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/` (UUID) OR `/^[a-zA-Z0-9.-]+$/` (friendly name)
  - `oktaDomain`, `auth0Domain`: `/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i` (DNS hostname)
- Red border + inline error on invalid input
- Save button disabled while invalid
- Backend Joi tightened with the same patterns for these fields

## Acceptance
- Typing a bogus tenant ID blocks the Save button client-side.
- Same request via raw API also returns 400.
