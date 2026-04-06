# Task 9B: TUI Auth & API Client

**Agent:** tui
**Status:** [ ] Pending
**Blocks:** 9C
**Blocked By:** 9A

## Objective
Implement the OAuth2 device authorization flow for CLI authentication and a reusable API client for communicating with the Shellius backend.

## Deliverables
- `tui/internal/auth/device.go`:
  - `StartDeviceAuth()` — POST to /auth/device/code, return device code + user code + verification URI
  - `PollForToken(deviceCode)` — poll /auth/device/token at specified interval until authorized, denied, or expired
  - Open browser automatically to verification URI (with fallback to manual copy)
- `tui/internal/auth/token.go`:
  - `SaveToken(token)` — store JWT + refresh token securely via go-keyring
  - `LoadToken()` — retrieve stored token from keyring
  - `RefreshToken()` — use refresh token to get new JWT
  - `ClearToken()` — remove stored credentials (logout)
  - `IsTokenValid()` — check JWT expiry without server call
- `tui/internal/api/client.go`:
  - HTTP client with base URL from config
  - Automatic Authorization header injection from stored token
  - Automatic token refresh on 401 response
  - Methods: `GetServers()`, `GetAccessRequests()`, `SubmitAccessRequest()`, `GetCredentials(requestId)`, `GetNotifications()`
  - Proper error handling and typed responses

## Acceptance Criteria
- Device auth flow works end-to-end: displays user code, opens browser, polls, stores token
- Token is stored securely in OS keyring (not plaintext on disk)
- API client automatically refreshes expired tokens
- API client returns typed Go structs for all responses
- Network errors are handled gracefully with user-friendly messages
- `shellius logout` clears stored credentials
