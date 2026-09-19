# CLI (TUI) vs web UI: gaps and plan

Snapshot: 2026-09-19, CLI `tui/v1.2.0`, app `v1.2.0`.

## What the CLI does today

The CLI is a **requester-only** client. It can:
- sign in with the device flow, sign out, and show your profile (identity, role, token expiry);
- list servers with a filter and request access (SSH or RDP, reason, duration, login user when your role may choose one);
- show the request's status by polling;
- list your own requests and your approved access;
- connect over SSH with an ephemeral key and certificate. When a key download isn't possible, it opens the web terminal in a browser instead;
- show a local session list: processes started on this machine.

Permissions: since 1.2.0 the CLI stores your permission list at sign-in and uses it for one thing, the production "needs approval" label.

## Bugs and correctness gaps

| # | Gap | Impact | Fix |
|---|---|---|---|
| T1 | `ListHosts` requests `/api/servers` with no paging. The API returns 25 per page by default. | **Anyone with more than 25 servers can't see or connect to the rest.** | Page through the results, or ask for `pageSize=100` and loop. |
| T2 | Permissions are read once at sign-in and never refreshed. Refreshing the token doesn't return them. | After a role change, the CLI shows stale labels and menu items until you sign in again. | Call `/api/auth/me` on start and after a `403 PERMISSION_DENIED`. |
| T3 | The "direct / requires approval" label is only a prod check. | Non-prod servers with no matching policy, a DENY policy, or a policy requiring approval all show "direct". | Use `GET /api/access-requests/intents` (bulk, 50 at a time), the same data the web UI uses. |
| T4 | RDP: after approval, the CLI asks for **SSH** credentials. | RDP access can't be used from the CLI at all. | Download the `.rdp` file (`/rdp-credentials`) and open the OS RDP client, or fall back to the web client. |
| T5 | Identity-auth (Keystore) servers can't hand out a key, by design, so the CLI opens a browser. | No native terminal for those servers, which is awkward over SSH or on headless boxes. | A native WebSocket terminal (below). |
| T6 | The session list only shows processes on this machine. | Web-terminal sessions still running on the server aren't visible and can't be reattached. | List `GET /api/terminal/sessions` and attach over WebSocket. |

## Feature gaps, by permission

The CLI should offer an action only when your role has the permission, just as the web UI does. The API enforces it either way.

| Area | Web UI | CLI today | Permission | Suggested for CLI |
|---|---|---|---|---|
| **Native terminal** | Terminal workspace: tabs, reattach, reconnect, recovery | ssh with an ephemeral certificate only | `access.request` | **Yes.** A WebSocket client for `/api/terminal/ssh`, the same hub as the web UI. It unlocks identity-auth servers, Quick Connect, reattaching web sessions, and servers where the policy blocks key download. |
| **Quick Connect** | Ad-hoc host with password or key, optionally a stored identity | — | `quick_connect.use`, `quick_connect.use_stored_identity` | **Yes** (needs the native terminal). |
| Recent connections | Dashboard widget and `/connections` | Local list only | — | **Yes**, cheap: `/api/terminal/recent-servers` plus Quick Connect history. |
| **Approvals** | Pending reviews: approve or deny with a duration, view details | — | Being in the request's approver set | **Yes.** On-call approvers live in the terminal. `/review` list plus approve/deny, capped at the policy maximum. |
| Cancel my pending request | — (the API doesn't support it) | — | own request | **Yes.** Needs a small new API endpoint (also useful in the web UI). |
| End my access early | Revoke (approvers and admins only) | — | own request | **Yes.** Needs a self-revoke API endpoint. |
| **Break-glass** | API only (no UI yet) | — | `access.break_glass` | **Yes.** Reason (20+ characters), up to 1h, loud audit. Useful exactly when the web UI is the thing that's broken. |
| Notifications | Bell, list, mark read | — | own | Maybe: a count in the header, and "approved" pop-ups while polling. |
| All sessions / terminate | Sessions page | — | `sessions.view_all`, `sessions.terminate` | Maybe: on-call ops. |
| All requests / revoke any | Access requests → All | — | `access_requests.view_all`, `revoke_any` | Maybe. |
| Onboard host | Install / uninstall link, health check | — | `servers.onboard` | Maybe: print a one-time install command to paste on the host. |
| Audit log | Audit page | — | `audit.view` | Maybe: `shellius audit --tail`. |
| Users, roles, groups, policies, Keystore, certificates, settings, bulk import | Full pages | — | various | **No.** Keep these in the web UI. Rich forms, grids and matrices don't belong in a TUI, and keeping admin writes in one place limits risk. |

## RBAC in the CLI (applies to everything above)

1. **Permissions from the server.** Load `permissions` and `roleInfo` from `/api/auth/me` at start, on `r`efresh, and after any `403 PERMISSION_DENIED`. The value saved at sign-in is only a fallback.
2. **Gate the command palette, menus and key hints** on permissions. Never gate on role names (same rule as the web UI).
3. **Explain refusals.** Show the API message for 403s ("Your role doesn't include …") instead of a generic error.
4. **Audit context.** Every CLI action already goes through the same API routes, so it is audited as the user. Add `clientType: 'tui'` where the API records it.

## Suggested phases

| Phase | Contents | Size |
|---|---|---|
| 1. Correctness | T1 paging, T2 permission refresh, T3 intents-based status, T4 RDP file, palette gating, 403 messages, CLI release doesn't take the "Latest" badge (done) | S |
| 2. Native terminal | WebSocket terminal client (ws-ticket → `/api/terminal/ssh`), used for identity-auth servers and key-download-blocked servers; list and reattach live sessions (T5, T6) | M–L |
| 3. Requester and approver flows | Pending reviews (approve/deny), cancel pending request, end access early (plus 2 small API endpoints), break-glass, recent connections | M |
| 4. Quick Connect | Ad-hoc hosts with password/key/stored identity over the native terminal, and Quick Connect history | M |
| 5. Ops (optional) | All sessions + terminate, all requests + revoke, install-link command, audit tail | S–M |
