# Task 21f — Gate SSH key download behind policy

**Phase:** 21A
**Plan:** `.claude/plans/phase-21-jit-user-provisioning.md`
**Agent:** backend
**Depends on:** task-21a

## Scope
Require `policy.allowKeyDownload === true` to download an SSH key/cert pair for an access request. Default-deny = web terminal only.

## Steps
1. In the existing key-download route (wherever the access request's SSH credentials are handed to the browser/TUI), check the policies that matched the originating access request:
   - If none of them set `allowKeyDownload: true`, return 403 with `KEY_DOWNLOAD_NOT_ALLOWED`.
2. Write a separate audit log entry type `KEY_DOWNLOADED` with severity HIGH whenever the download succeeds (distinct from regular access events).
3. Frontend: in the access request detail view, hide or disable the download button when the policy does not allow it, with an explainer tooltip "Key download disabled by policy; use the web terminal instead".

## Verification
- Default policies (without the flag) → download button disabled, API returns 403.
- Policy with `allowKeyDownload: true` → download works, audit event logged.
- Audit log filters on `KEY_DOWNLOADED` and surfaces prominently.
