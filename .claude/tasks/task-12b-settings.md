# Task 12B: Settings Page

**Agent:** frontend
**Status:** [ ] Pending
**Blocks:** None
**Blocked By:** None

## Objective
Build the Settings page with sections for organization configuration, CA management, SSO configuration, cloud connector links, and notification preferences.

## Deliverables
- `client/src/pages/Settings.jsx` with tabbed or sectioned layout:
  - **Organization** section:
    - Org name, logo upload, default session duration, max session duration
    - Password policy settings (if local auth)
    - Save button with validation
  - **Certificate Authority** section:
    - Active CA fingerprint and public key (copyable)
    - CA rotation button with confirmation dialog
    - Last rotation date
    - Certificate default validity period
    - Link to Certificates page
  - **SSO / Authentication** section:
    - OIDC provider configuration (issuer URL, client ID, client secret)
    - SAML configuration option
    - Enable/disable local auth
    - MFA enforcement toggle
  - **Cloud Connectors** section:
    - Links to configured cloud connectors (AWS, Azure, GCP)
    - Sync status and last sync time for each
    - Manual sync trigger button
  - **Notifications** section:
    - Email notification preferences (request submitted, approved, denied, expiring)
    - In-app notification toggles
    - Notification email address override
- `client/src/hooks/useSettings.js` — React Query hooks for settings CRUD

## Acceptance Criteria
- Settings page loads with current values from backend
- Each section saves independently with loading/success/error states
- CA rotation shows confirmation dialog with clear warning
- SSO configuration validates issuer URL format
- Cloud connector sync triggers refresh of server list
- Notification preferences persist and affect actual notification delivery
- Settings restricted to admin role (redirect non-admins)
- Form validation prevents saving invalid values
