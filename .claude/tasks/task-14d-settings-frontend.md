# Task 14D: Settings Frontend Wiring

**Agent:** frontend
**Status:** [x] Done
**Blocks:** 14L
**Blocked By:** 14A, 14B, 14C

## Objective
Wire the Settings page tabs to the new endpoints from 14A/14B/14C and
remove every TODO/placeholder banner currently rendered there.

## Deliverables

### Org tab
- New `frontend/src/services/orgService.js` with `getOrg()` / `updateOrg()`
- `OrgTab` in `pages/Settings.jsx`:
  - On mount: `getOrg()` → set form state from response
  - Save: `updateOrg(payload)` → toast on success, surface API errors
  - Drop the "TODO: /api/org endpoint not yet implemented" banner

### SSO tab
- New `frontend/src/services/ssoConfigService.js` with `getSsoConfig()`,
  `saveSsoConfig()`, `testSsoConnection()`
- `SsoTab`:
  - On mount: `getSsoConfig()` → populate form (mask the secret if
    `hasSecret: true`)
  - Save button: stop being hard-disabled; calls `saveSsoConfig`
  - Test button: calls `testSsoConnection`, renders a result card with
    `providerName`, `scopesSupported` on success or an error block on
    failure
  - Drop the pending banner

### Notifications tab
- New `frontend/src/services/userPreferencesService.js`
- `NotificationsTab`:
  - On mount: `getMyPreferences()` → set toggles
  - Save: `updateMyPreferences({ emailNotifications })`
  - Drop the localStorage TODO

### Cloud tab
- Keep the placeholder until Task 14K decides; if Task 14K opts to hide
  it, remove the tab entry from the tabs array.

## Acceptance
- All three tabs read/write to the real backend.
- No `localStorage`-only writes outside of UI ephemera (theme, sidebar
  collapse).
- No "TODO" or "Coming soon" banners on the persisted tabs.
