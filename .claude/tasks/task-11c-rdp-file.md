# Task 11C: RDP File Generation

**Agent:** backend
**Status:** [ ] Pending
**Blocks:** None
**Blocked By:** 11A

## Objective
Implement .rdp file generation with Guacamole gateway token for users who prefer native RDP clients, downloadable from an approved access request.

## Deliverables
- `src/services/rdpFileService.js`:
  - `generate(accessRequestId)` — generate .rdp file content with:
    - Guacamole gateway as the RDP gateway (host, port)
    - Gateway auth token embedded as credential
    - Target server hostname and port
    - Display settings (full screen, multi-monitor support)
    - Security settings (NLA, TLS)
    - Appropriate timeouts
  - `getDownloadHeaders(filename)` — return HTTP headers for .rdp file download
- Integration with access request routes:
  - GET /access-requests/:id/rdp-file endpoint returns the generated .rdp file
  - Endpoint validates request is APPROVED, type RDP, and not expired
- .rdp file template with configurable defaults

## Acceptance Criteria
- Generated .rdp file opens successfully in Microsoft Remote Desktop or compatible client
- Gateway token authenticates the user through Guacamole to the target server
- .rdp file contains correct server address, gateway settings, and security options
- Download endpoint enforces access request validation (approved, not expired, correct type)
- File is generated on-demand (not stored persistently)
- Content-Disposition header triggers browser download with meaningful filename
