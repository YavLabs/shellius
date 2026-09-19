# Changelog

All notable changes to Shellius will be documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Tracked here as work lands on `main`; moved into a dated section on release
(`node scripts/version.mjs bump <major|minor|patch>`).

### Changed

- **Toggles instead of checkboxes in forms.** Every on/off option in a form is now a switch with its label (and a short description where useful) on the left and the switch on the right, lined up the same way as the Administration settings. This covers:
  - policies (active, approval, auto-approve, approver roles, just-in-time user options, key download, break-glass)
  - Quick Connect save options
  - server "IP may change", customer "Active", provisioning sudo
  - Keystore export options, "Clear stored password" / "Clear certificate"
  - the role matrix filter, "use for all outgoing email"
  - the terms agreement when registering or accepting an invite (its Terms and Privacy links now open the real pages).
  Selecting rows in lists (tables, cards, the server picker when exporting a key) still uses checkboxes.

### Fixed

- The Profile page no longer runs off the side of a phone screen. A long unbreakable value, such as an IPv6 address in the Sessions list, used to widen every card; the column now keeps to the screen width and the address wraps.

## [1.5.2] - 2026-09-19

### Added

- **Default two-factor method.** When both the authenticator app and email codes are set up, Profile → Two-factor authentication has a **Default at sign-in** choice. Sign-in, SSO account linking and the "verify it's you" check open on that method. Stored per user (`User.mfaPreferredMethod`, migration `20260922000000_mfa_preferred_method`; `PUT /api/mfa/preferred`, audited as `mfa.preferred_method.updated`). A preference for a method that's later turned off is ignored.
- **"More ways to verify"** on the two-factor screens replaces the Authenticator / Email tabs and the separate backup-code link: it lists the other methods you have, backup codes included.

### Changed

- **Email codes are sent first, then verified.** Choosing an email code shows where it will go and a full-width **Send code** button. After sending, the screen confirms it was sent and shows the code field and **Verify**, with "Didn't get it? Resend code" under it. Resend waits 30 seconds between sends, confirms the new code, and shows the server's message when it rate-limits. "I already have a code" skips straight to the code field. Same flow at sign-in, when linking an SSO account and in the "verify it's you" check on Profile.

### Migration notes

- One new migration, `20260922000000_mfa_preferred_method`: adds a nullable `users.mfa_preferred_method` column. No data changes; run `prisma migrate deploy` before starting the new backend.

## [1.5.1] - 2026-09-19

### Changed

- **Lists on phones are cards instead of tables.** Below 768px wide, every list (Servers, Customers, a customer's servers, Access requests, Policies, Certificates, Sessions, Notifications, My hosts, Keystore identities and keys, Users, Groups, Audit log, Bulk import) shows one card per row. Tapping a card does what clicking the row does. Cards stay short:
  - A one-line name and a one-line detail (for a server: hostname and IP), with at most two quiet details under them. No badges.
  - Status sits next to the "⋯" menu as a coloured dot and a word (Approved, Expired, Active, Locked, Allow / Deny). Counts go there too (a customer's servers, a group's members, an identity's servers). The selection checkbox is in the top-right corner.
  - A server's health is a dot on its icon, spelled out only when the server is unhealthy or in maintenance. Its environment tints the card (Dev blue, Staging amber, Prod red, Demo grey) and is written small in the bottom-left corner. Access requests, sessions and certificates for a server are tinted the same way.
  - The main action (Connect, Request access, Quick Connect) is a button in the bottom-right, under a divider. The rest are in the "⋯" menu, with the same permissions as before.
  - Every card in a list is the same height.
  - Customers are grouped under Active and Inactive headings.
- On phones, search is full width, filters open in a sheet from a "Filters" button that shows how many are set, and sorting is a "Sort" menu. There are no page numbers: the next page loads as you scroll, with a "Load more" button as a fallback, in every list including the Audit log. Selecting servers shows the bulk actions in a bar at the bottom of the screen.
- The role matrix on phones lists each permission by area with the roles that hold it. Recent connections, the Roles list and key exports have larger touch targets and no longer squeeze names on narrow screens.
- **Dialogs open as bottom sheets on phones.** Below 768px wide, every dialog (forms, confirmations, Quick Connect, the command palette, keyboard shortcuts) slides up from the bottom with rounded corners and a drag handle. Swipe it down, tap outside it or press Escape to close it, the same as closing the dialog on a computer. The body scrolls while the title and the action buttons stay in place. The buttons fill the width and stack when they don't fit. Fields are 44px tall with 16px text, so iPhones don't zoom in when you tap one. When the on-screen keyboard opens, the sheet moves up so the buttons stay visible. Side-by-side fields that got too narrow on a phone now stack (for example OS type and version on Add server). Desktop and tablet dialogs are unchanged.
- **Help opens from the bottom on phones.** The page help panel opens as a bottom sheet instead of sliding in from the right.
- **Phone layout for the app shell** (below 768px wide; tablets and desktop are unchanged):
  - There is no top bar. Each page starts with its own title, with the notch and status bar left clear.
  - The bottom navigation bar has five slots: **Home**, **Connect**, the raised **+**, **Activity** and **More** (your avatar). A tab stays highlighted on the pages it leads to. The bar is hidden on the full-screen terminal and while the keyboard is open in the Terminals workspace.
  - **Connect** (`/connect`) gathers everything about getting onto a machine: search, Quick connect, the Terminals workspace (with open and live counts), Servers, My hosts and your recent connections. Its badge counts live terminals.
  - **Activity** (`/activity`) gathers what needs your attention: requests waiting for your review, your pending requests, live sessions and unread notifications, the latest notifications, and links to Access requests, Notifications, Sessions and the Audit log. Its badge replaces the bell.
  - **More** opens a sheet with your account (to Profile), search, every other page grouped as in the sidebar, Administration, Bulk import, Install CLI, the theme switch, Sign out, and the Privacy, Terms and EULA links with the version.
  - **+** lists the current page's create action first ("On this page", for example Add server on Servers), then Quick connect and the same quick actions as the desktop menu, without repeating the page's action. The pages themselves no longer show a full-width create button.
  - The pages Connect and Activity open on desktop too.
  - The footer is hidden.
  - The theme switch is three icons with a "Theme" label, in the More sheet and the account menu.
- **Page headers on phones.** Each page's icon sits in a tinted box with the title and a short, one-line description beside it (for example "Target servers by customer" on Servers), help and "⋯" at the end, and a divider under it. Server and customer pages show one line under the name: a server's health, environment and address, or a customer's description. The main create action moves to the "+" button, and the other actions (Refresh, Export, Edit, Delete, …) are in a "⋯" menu. The header, toolbar and list are spaced evenly. Server and customer pages have a back button before the title and their details (hostname, environment, slug, server counts) under it.
- **Dashboard on phones.** The four metrics are a compact 2×2 grid, and the server count shows its Prod / Staging / Dev / Demo split as one thin bar. The Quick actions card is hidden, because "+" has the same list. Recent connections and My access use the same cards as the list pages (environment tint, status by the corner, action under a divider) and sit without a frame around them. Each section (Recent connections, My access, Recent activity) has one title row with a brand marker, "View all" and a "⋯" menu (My access: Browse servers, My access requests, New access request). The servers tile shows its Prod / Staging / Dev / Demo counts as coloured dots. The dashboard shows fewer rows on phones: 3 recent connections, 5 servers in My access and 5 audit events.
- **Administration on phones.** `/admin` shows the list of sections, grouped like a phone's Settings app, with a one-line description each and the search box on top. A section opens full width with "‹ Administration" to go back, instead of the dropdown. Going back still asks before discarding unsaved changes.
- Desktop and tablet layouts are unchanged.

### Fixed

- The private network address notice explains what actually needs to reach the host: browser terminals connect from the Shellius backend, so it has to be able to reach that network. Connecting from your own machine (the CLI or a downloaded key) needs your machine on it too, for example over VPN.
- On phones: the Keystore Organization / Personal switch is full width, the Activity counts are one summary card, the bulk-action bar sits clear of the "+" button, and customer stat tiles use short labels.
- **Keystore → Export to servers** cards follow the list card style: the key name, one status next to the chevron (Running, Done, or how many failed), who ran it and when, and dot counts for succeeded / failed / running / waiting instead of a coloured progress bar. Server rows inside show their status the same way.
- The Administration page title looks the same as every other page's, on desktop and on phones.
- The cursor bar in the email logo sits on the same baseline as the letters. It was a separate table cell, so it sat lower in some mail clients.
- Fields that draw their own focus style, such as the command palette search, no longer show an extra accent outline when focused. Buttons and links keep their keyboard focus ring.

## [1.5.0] - 2026-09-19

### Added

- **Connect sign-in providers from Profile.** Sign-in methods lists every SSO provider the organization uses, with Connect for the ones you haven't linked and Disconnect for the ones you have. Connecting links the provider account to you, never to another account with the same email. An account already linked to another user is refused.
- **Set a password.** People who sign in only with SSO can add a password from Profile. They confirm it's them with their two-factor code, or with a code emailed to them.
- **Sign-in methods for administrators.** On Users, "Sign-in methods" shows whether a user has a password and which SSO accounts are linked, and can unlink one. It needs the new "Manage sign-in methods" permission (Admin and Super admin by default) and follows the same rule as editing users: you can't act on someone whose role has more permissions than yours.
- **Require single sign-on** (Administration → Access rules). When on, password sign-in, password resets and adding a password are refused, except for roles with the "Single sign-on" permission, so an administrator can still sign in if the identity provider breaks. The sign-in page shows only the SSO buttons.
- Emails when an SSO account is linked to or unlinked from your account, and when a password is added.
- **Email providers.** Administration → Email (was Settings → "Email server") can hold several ways to send email, and one is active at a time:
  - SMTP, Google (Gmail API), Microsoft 365 (Microsoft Graph), SendGrid, Mailgun, Postmark and Resend.
  - Google: "Connect Google account" signs in once and only asks for permission to send email. Google Workspace service accounts (domain-wide delegation) work too. The OAuth client defaults to `SSO_GOOGLE_CLIENT_ID` / `SSO_GOOGLE_CLIENT_SECRET`.
  - Microsoft 365: an Entra ID app with the Mail.Send application permission sends from a chosen mailbox.
  - "Send test email" sends to any address (your own by default) and shows the provider's own error when it fails. Each provider shows its last test result.
  - A notice says what happens when no provider is active: emails use the server's `SMTP_*` settings, or are not sent at all.
  - API keys, client secrets, passwords and Google sign-in tokens are encrypted and never shown again. Leave a secret blank when editing to keep it.
  - Every change and test is in the audit log, without secrets.
  - See `docs/email-delivery.md`.
- `SMTP_SECURITY` (`none`, `starttls` or `tls`) and `SMTP_FROM_NAME` for the environment SMTP settings.

### Changed

- Settings is now **Administration** (`/admin`), opened from the profile menu. Users, Roles and Groups moved out of the sidebar into it, next to the organization settings, grouped as People & access (Users, Roles, Groups), Authentication (Single sign-on, Two-factor, Access rules), Organization (General, Certificate authority, Quick Connect) and Integrations (Email, Storage). A search box finds a section by name or keyword (for example "smtp" or "okta"), and on phones the sections are a dropdown. Each section, the menu entry and the command palette entries ("Administration › Users", …) only appear with the matching permission. Switching sections asks before discarding unsaved changes. Old links keep working: `/settings` and `/settings?tab=…` redirect to the matching section, and `/users`, `/roles`, `/roles/:id`, `/groups` and `/groups/:id` redirect to `/admin/…`. Links in notifications, search results and the Google email-provider sign-in now point at the new pages.
- The sidebar collapses automatically on the Terminals workspace and Administration. You can still expand it there; leaving restores your usual setting.
- The Shellius logo files (`frontend/public/brand`) have outlined, evenly spaced lettering, so the gap between SHELL, the bar and US is gone and they look the same without the font installed.
- Signing in with SSO for the first time no longer links the provider to an existing account with the same email straight away:
  - If the account has a password, you confirm with that password (and your two-factor code, if you use one) before the provider is linked. This applies to every role.
  - If the account has no password but has administrative permissions, an approval link is emailed to the account.
  - Other accounts without a password are linked as before.
- The sign-in page no longer jumps straight to the identity provider for SSO-only accounts. It shows "This account signs in with <Provider>" and a Continue button.
- The SSO provider form warns when "Require verified email" is turned off.
- People who have both a password and a linked SSO account can change their password again.
- **Emails use the new Shellius brand.** The header shows the full Shellius logo (icon and wordmark) built in HTML, so it appears even when a mail client blocks images and no public app URL is set. The old header icon was blocked by Gmail and Outlook. Buttons use the brand gradient.
- SMTP has an explicit Security setting: STARTTLS, TLS, or None. Before, the TLS switch only applied on port 465.
- The "Email server" permission is now called "Email delivery" (same key, `settings.smtp`), and is marked as sensitive.
- `/api/settings/smtp` is deprecated. It still works, and now reads and writes the org's active SMTP provider.

### Security

- An identity provider account with the same email can no longer take over a Shellius account without the account's password, two-factor code or an emailed approval. Wrong passwords on the confirm page count toward the account lockout.
- When single sign-on is required, the sign-in page answers the same for every email address, and a failed password sign-in gives the same message whether the password was wrong or the account can't use one. Administrators allowed a password use "Sign in with a password instead". Neither step reveals which accounts are exempt.
- Linking and unlinking SSO accounts are recorded in the audit log as their own events (`auth.identity.linked`, `auth.identity.unlinked`), with how it happened.

### Migration notes

- The `20260921000000_email_providers` migration adds the `email_providers` table. It copies each org's SMTP settings from Settings → Notifications → SMTP into an active "SMTP" provider. The SMTP password is moved into the provider's encrypted settings when the backend starts, so start the backend once after `prisma migrate deploy`.
- The old SMTP "Use TLS" switch becomes Security: TLS on port 465, STARTTLS (required) on other ports, None when it was off. If your mail server doesn't support STARTTLS on port 587, set Security to None.
- The `smtp_configs` table is kept unchanged, so rolling back to 1.4.x keeps working. Changes made after upgrading aren't copied back to it.
- To use a Google provider with OAuth, add `https://<your host>/api/settings/email/google/callback` to the Google OAuth client's redirect URIs.

## [1.4.1] - 2026-09-19

### Fixed

- Just-in-time Linux accounts (a policy's OS provisioning: groups, sudo, ACLs) were never provisioned. Building the provisioning manifest failed on every certificate check, and allocating the account's Linux UID failed on a Postgres type mismatch. Both are fixed, and access without OS provisioning is unaffected.
- Quick Connect and "Save to My hosts" could hang with no error. The check that stops Quick Connect reaching a production server looked up each production server's hostname one at a time, with no time limit, so a slow DNS server stalled the request. The lookups now run in parallel, with a 2-second limit and a short cache. Looking up the target host itself has a time limit too, and the dialog shows an error if the server doesn't respond.
- Saving a key with a password to My hosts said it saved only the key. It saved both; the label now says "key and password".
- Long group and customer names wrap left-aligned in their tables instead of centred.
- Email sign-in codes: when the email couldn't be sent (no SMTP configured, or the mail server refused it), the screen still said the code was sent. It now shows an error saying to use another method or ask an administrator to check the email settings. The mail server's exact reason is written to the backend log. Too many code requests also shows an error instead of "sent".
- Two-factor setup: on the sign-in page, the QR code, key and code field are centred in one column. On Profile, the QR code sits beside numbered steps. The key is grouped in fours and copies with a click, and the code field is wide enough for password-manager icons.
- The terminal workspace's "lost its session" banner matches the workspace style: a rounded card with the same buttons as the tab bar.

## [1.4.0] - 2026-09-19

### Changed

- **New look across the app**, following the Shellius brand guideline (`frontend/public/brand/README.txt`).
  - Brand colours in light and dark mode: an Ink canvas in dark mode, with Sky and Lavender accents.
  - Brand fonts: Manrope for the interface, Space Grotesk for headings and the logo, JetBrains Mono for code and terminals. The fonts are self-hosted.
  - Primary buttons and checked boxes use the brand gradient. Page titles use the gradient text.
  - A faint brand glow sits behind page content. Menus and dialogs have softer shadows.
  - New logo, favicon and app icons from the brand kit.
- **Sign-in pages redesigned.** Sign-in shows the centred logo and a single email field. The other sign-in pages show the logo top-left. All of them have a faint animated terminal background.
- **Web terminal, RDP viewer and command snippets** use the brand terminal colours (Ink background, Sky cursor).
- Text fields, selects and buttons share one size and corner radius across the app.
- **Terminal workspace**: tabs are rounded pills with no divider below them. The workspace has padding around it. The sessions panel is a rounded card.
- Sign-in lists SSO providers as full-width "Sign in with …" buttons, one per row, under an "or continue with" divider.

### Fixed

- Adding an SSO provider other than GitHub failed with `"allowedOrgs" is required`. The GitHub organization list is now optional, and other providers don't send it.

## [1.3.0] - 2026-09-19

### Added

- **Personal vault**: everyone can keep their own identities and SSH keys, visible only to them.
  - The Keystore has a Personal / Organization switch. Members see only their personal items.
  - Personal items can be used in Quick Connect. They can never be bound to org servers or used for key deployment.
  - Owners who also hold Manage Keystore can move a personal identity or key into the organization Keystore.
  - Deleting a user deletes their personal vault.
- **My hosts**: a private list of SSH hosts per user, connected with personal (or permitted org) identities.
  - Same checks as Quick Connect: production servers refused, DENY policies applied, audited, recorded.
  - Host keys are pinned on first connect.
  - Quick Connect can save a target to My hosts.
- Permissions `vault.use` and `vault.hosts`, granted to every built-in role on upgrade.
- Org switch in Settings → Access to turn the personal vault off.
- See `docs/personal-vault.md`.

### Changed

- Identity and key names are unique per scope: org names across the org, personal names per owner.
- The auth pages use a shared layout with a faint grid and legal footer; the content area has a faint grid.
- Checkboxes are themed for light and dark mode across the app, with a partial state on select-all; table header checkboxes and the bulk-selection bar are aligned.

### Security

- Testing a stored identity against a typed-in host now refuses production servers and hosts a DENY policy keeps you from (previously only saved-server tests were vetted).

### Migration notes

- Database migration `20260920000000_personal_vault`: adds `owner_id` to `ssh_keys` and `credentials`, and the `personal_hosts` table. Existing identities and keys stay in the organization Keystore.
- On first boot every built-in role (and custom roles, by base tier) gets `vault.use` and `vault.hosts`. Remove them on the Roles page, or turn the feature off in Settings → Access, if you don't want personal vaults.

## [1.2.2] - 2026-09-19

### Added

- `docs/tui-parity.md`: what the CLI can and can't do compared with the web UI, with a phased plan.

### Changed

- Dashboard rows adapt to the cards each person can see:
  - Recent connections takes the whole row when your role has no quick actions.
  - "My access" spans the full width (servers in two columns) when Recent activity isn't shown.
  - My access "View all" scrolls inside the card instead of stretching the page.
  - The metric grid follows the number of cards shown.
- CLI releases (`tui/v*`) no longer take GitHub's "Latest" badge from the app release.

## [1.2.1] - 2026-09-19

Security fix release. Upgrade recommended. If you don't use `TRAEFIK_HOST`, set `APP_URL` to the
public URL of the web app.

### Security

- Invite, password-reset, email-verification and approval links were built from the request's
  `Host` header when `TRAEFIK_HOST` wasn't set. On the public "forgot password" endpoint, a forged
  `Host` could put the reset token on another domain (reset-link poisoning). Links now always use
  the configured app URL.

### Fixed

- Links that open app pages now use `APP_URL` (the public URL of the web app, falling back to
  `PUBLIC_BASE_URL`, `FRONTEND_URL` or `TRAEFIK_HOST`). Previously the "SMTP unavailable" reset
  dialog, and emails, could show the backend address (for example `http://localhost:3001`).
  `APP_URL` now also applies everywhere else the app URL is used, not only SSO.

## [1.2.0] - 2026-09-18

This release adds **custom roles** and fixes the gaps found in a full RBAC audit, including
admin → super admin account takeover and an unrestricted certificate-issue endpoint. Upgrading is
automatic, but **read the Migration notes**: some Manager and Member permissions are tighter by
default.

### Added

- **Custom roles.** Sidebar → Administration → **Roles** (`/roles`):
  - Every permission is a switch, grouped by area, with sensitive ones flagged.
  - Create a role from scratch or copy an existing one, edit the built-in Admin / Manager / Member
    (with Reset to defaults), and delete a role after moving its users.
  - A **Matrix** view compares every role side by side and exports CSV.
  - Example: copy Admin into "Senior admin" and add Email server, MFA policy and Audit export,
    without making them super admins.
  - You can only grant permissions you hold. Nobody can edit their own role, and Super admin
    always has everything.
- 61 permissions replace the fixed role checks everywhere: API, UI, command palette, shortcuts and
  CLI. Changes to a role apply immediately; open browsers refresh their permissions on their own.
- Access policies and approver lists can target custom roles. A custom role "based on" a built-in
  role also matches that role's policies.
- RBAC audit in `docs/rbac/`: per-permission and per-endpoint matrices, how the default policies
  work, and every gap found.

### Changed

- Who may skip production approval is now the **Production without approval** role permission,
  plus an organization-wide switch in Settings → Access. Who may use Quick Connect is the **Use
  Quick Connect** permission. Existing settings carry over on upgrade.
- Tightened defaults for the built-in roles:
  - Managers no longer change a server's environment, bind stored identities to servers, use
    stored identities in Quick Connect or watch session recordings.
  - Members no longer change dynamic IPs.
  - Managers can see their own direct reports.
  - Anything removed can be granted back on the Roles page.
- Personal notification preferences moved to **Profile**; Settings now has an **Email server** tab.
- Pages you can't open now say so instead of silently sending you to the dashboard.
- Dashboard shows "My live sessions" and "My certificates" to people who can't see everyone's.
- The CLI reads the permission list at login to show which production servers need approval.
- Dashboard: **Recent connections** replaces "Recent quick connects" and is shown to everyone.
  - **Active now:** your live sessions. "Go to terminal" if the session is open in a tab or
    Workspace; "Connect now" if it's running in the background. End from the row menu.
  - **Recent (last 7 days):** servers you connected to and your Quick Connects in one list. Server
    rows show what your access allows now: Connect, Pending, or Request access.
  - New `GET /api/terminal/recent-servers` (your own sessions only).
  - The widget shows at most 3 active and 4 recent connections, with **View all** links to a new
    **Recent connections page** (`/connections`). The page has every item, search, an All /
    Servers / Quick Connect filter and a 7- or 30-day range, so the widget no longer grows and
    leaves empty space beside Quick actions. The page is also in the command palette.
- Dashboard: redesigned **Quick actions**. Quick connect and New access request are prominent
  tiles; other actions are compact grouped rows with shortcuts on hover; the command palette and
  shortcut list are in the footer.
- Dashboard: environment counts in the Total servers card use the same colour as their labels.

### Fixed

- Recent activity / Audit log: events on your own account, session or request no longer repeat
  your name. "Local Admin signed in Local Admin" is now "Local Admin signed in", and "Local Admin
  ended session Local Admin on host" is now "Local Admin ended session sshtest.local". Quick
  Connect sessions show `user@host` instead of the placeholder "host". Someone else's session or
  request is still named ("Jane Doe on sshtest.local").
- Secondary approvers can open and revoke the requests they're asked to approve. Approve and
  Revoke buttons now match what the API allows.
- Admins no longer see Delete buttons that the API rejects.
- Opening a policy with selected subjects no longer crashes: an import was commented out.
- Switches were invisible in dark mode. Settings checkboxes are now switches.
- The seed strips one pair of matching outer quotes from `SEED_*` values. `docker run --env-file`
  passes quotes through literally, which stored names like `"Local Admin"` (quotes included) for
  the super admin and organization.
- Avatar initials ignore punctuation, so a quoted or bracketed name no longer shows `"A`.

### Security

Fixes from the RBAC audit (details in `docs/rbac/rbac-audit.md`):

- An admin could take over a super admin account (set their password or email, demote or
  suspend them, or send them an invite / reset link). You can now only manage users whose role
  you could assign. Passwords can't be set for other users, and invites only work for pending
  accounts and never reactivate suspended ones.
- `POST /api/certificates/issue` let any user get a CA-signed certificate for any login name
  (for example `root`) without a policy check. It now needs its own permission (super admin by
  default) and a server, checks every principal, issues user certificates only and never prod.
- Admins could change the super-admin-only production setting through `PUT /api/org`.
- Managers could move servers out of prod, bind stored identities to servers, and use or test
  stored secrets against any host. Members could re-point any dynamic-IP server.
- Access-request revoke wasn't limited to the caller's organization.
- Break-glass access and deploying keys to prod ignored the production approval setting.
- Approvers could grant longer than the policy's maximum session length, and email approval
  links kept working after the approver was suspended.
- Quick Connect ignored DENY policies on saved servers.
- Deleting a customer turned its customer-scoped policies into organization-wide ones. They're
  now switched off.
- Access-policy role, user and group references are validated. SSO can't auto-assign Super admin
  or a role with sensitive permissions, and its default role no longer uses the nonexistent
  `viewer`.
- Server, customer, group, user, install-link and recording-download actions are now audited.

### Migration notes

- A migration adds the `roles` table and `users.role_id`. On startup every organization gets its
  four built-in roles and every user is linked to one, before the server takes requests.
- Your current settings carry over:
  - The "which roles skip production approval" setting becomes the Admin role's **Production
    without approval** permission plus the Settings → Access switch.
  - Quick Connect's minimum role becomes the **Use Quick Connect** permission.
- Manager and Member defaults are tighter (see Changed). If your managers relied on changing
  server environments, binding identities, using stored identities in Quick Connect or watching
  recordings, grant those back on the Roles page.
- `PUT /api/users/:id` no longer accepts `password` or `avatarUrl`, and `PUT /api/org` no longer
  accepts `settings`. `POST /api/certificates/issue` requires `serverId` and the new
  `certificates.issue_direct` permission. The web UI and CLI don't use any of these.
- CLI: sign in again (`shellius login`) to get the new permission list. Until you do, it falls
  back to the stored role.

## [1.1.0] - 2026-09-18

This is a large release:
- a full secrets/credentials manager (Keystore) and Quick Connect;
- a new in-app terminal workspace (tabs, splits and Workspaces, detach/reattach, and session
  recovery after restarts or expiry);
- multi-provider SSO;
- a broad security hardening pass (per-host agent tokens, single-use tickets and install
  links, encryption at rest);
- a new **all-in-one Docker image** (`yavadmin/shellius`).

Everyone will need to sign in again after upgrading, and hosts need re-bootstrapping with
`--upgrade` (see Breaking changes and Migration notes).

### Security

- **Fixed:** `multer` (file uploads for bulk import) upgraded from 1.4.5 to 2.4.0; 1.x has
  several HIGH advisories that `npm audit` did not report. All three Dockerfiles now run
  `apk upgrade`, so images pick up Alpine security fixes (e.g. OpenSSL 3.5.8) released after
  the base image. Dev-tooling advisories were fixed with `npm audit fix`; production dependency
  audits are clean for the backend and frontend.
- **Fixed:** only the person who requested access can open a terminal with an approved access
  request. Before, an admin (who can view every request) or the request's reviewer could use
  someone else's approval to open a shell on a Keystore (credential-mode) server as themselves.
  Certificate servers were already protected.
- **Fixed:** `GET /api/access-requests/:id` (and its RDP-token/connect variants) are now
  org-scoped. Before, an admin could read another organization's request by id.
- **Fixed:** per-host agent tokens replace the single, org-wide
  `AGENT_SHARED_SECRET` used by `check-principals` and `/api/hosts/heartbeat`
  on every target host. Previously, a certificate minted for an *approved*
  access request on one server (e.g. a dev box) could also authenticate on
  any other server in the org — including production — because verification
  never checked which host was asking, and every host shared one fleet-wide
  secret. Certificates are now bound to the exact server they were issued
  for (`Certificate.issuedForId`), and each host authenticates with its own
  token (hash-only, stored in `Server.agentTokenHash`), minted fresh every
  time its bootstrap script is generated. **Hosts already bootstrapped must
  re-run the install one-liner with `--upgrade`** (from the server's
  "Bootstrap" panel: `curl -fsSL "<install-url>" | sudo bash -s -- --upgrade`)
  to pick up their per-host token. Until then, `AGENT_LEGACY_SHARED_SECRET`
  (default `warn`) keeps un-upgraded hosts working against the old
  `AGENT_SHARED_SECRET`, logging a rate-limited deprecation warning and
  setting `x-shellius-agent-deprecated: 1` on responses; set it to `deny` to
  cut legacy hosts off immediately. **`AGENT_LEGACY_SHARED_SECRET` will
  default to `deny` in the next release** — re-bootstrap all hosts before
  upgrading again. See `docs/deployment.md` → "Upgrade notes: per-host agent
  tokens".
- **Fixed:** the backend now **refuses to start in production** without a
  strong `SERVER_ENCRYPTION_KEY` (64 hex chars, or at least 32 characters).
  Previously it only warned and fell back to a key derived from a constant in
  the source tree. Encrypted values now use a versioned envelope
  (`v2:<keyId>:…`); legacy values are still read. Rotate keys by setting the
  new key in `SERVER_ENCRYPTION_KEY`, the old one(s) in
  `SERVER_ENCRYPTION_KEY_PREVIOUS`, and running `npm run crypto:reencrypt`
  (supports `--dry-run`).
- **Fixed:** terminal WebSockets no longer carry the access token in the URL.
  The browser first calls `POST /api/terminal/ws-ticket` and connects with a
  single-use, 30-second ticket bound to the user, org and connection target;
  the upgrade is also rejected (403) when the `Origin` header doesn't match
  the configured public origin. nginx access logs no longer record query
  strings.
- **Fixed:** suspending, deactivating or deleting a user, changing their role,
  revoking their sessions, or changing/resetting their password now **ends
  their live terminal sessions immediately**; new terminal connections apply
  the same account-status and session-revocation checks as the REST API.
- **Fixed:** session recordings are now **encrypted at rest** (AES-256-GCM
  with a per-recording data key wrapped by `SERVER_ENCRYPTION_KEY`) before
  upload to object storage, independent of bucket settings; replay decrypts
  on the fly and existing unencrypted recordings still play.
- **Fixed:** admins could terminate another organization's session by id;
  terminate is now scoped to the caller's organization.
- **Fixed:** secrets are masked in application logs and audit-log metadata;
  key-export output is scrubbed of the credentials used for that export;
  CLI device-login codes are stored hashed and the device flow is rate
  limited; Quick Connect tickets, WebSocket tickets, key inspect/import and
  identity tests are rate limited per user; avatar images only load from
  `https:` or raster `data:` URLs.
- **Fixed:** host install and uninstall links (`/api/bootstrap/install.sh`,
  `install.ps1`, `uninstall.sh`) are now **single-use**. A second download of
  the same link returns `410 LINK_ALREADY_USED`, so a link that ends up in
  shell history, a chat message or a proxy log can't be replayed to mint
  another agent token. Generate a new link from the server's Bootstrap panel
  to re-run an install.
- **Fixed:** `react-router-dom` upgraded to 7.x (moderate advisories in 6.x);
  `deepmerge-ts` in Prisma's CLI config loader pinned to 8.x via an npm
  override (high-severity advisory; Prisma 7 still ships the vulnerable 7.x,
  so an override is the fix). `npm audit` is clean for backend and frontend.
- **Docs:** `docs/DEPLOYMENT.md` §4.2.1 covers keeping query strings out of
  access logs on a proxy you run yourself (Traefik/Coolify, Caddy, nginx /
  Nginx Proxy Manager, cloud load balancers).

### Added

- **All-in-one Docker image** `yavadmin/shellius` (`docker/Dockerfile.allinone`): web UI, API
  and nginx in one container, listening on :8080 and running non-root.
  - ~93 MB compressed (~405 MB on disk), smaller than the backend image alone (~156 MB).
    A Trivy scan reports no HIGH/CRITICAL findings.
  - Production dependencies only, a Postgres-only Prisma engine, and no npm/yarn at runtime.
  - `tini` plus a small supervisor runs migrations and the seed, then keeps the API and nginx
    together: if either dies, the container exits so it restarts as a unit.
  - Published by CI alongside the two existing images, with `docker-compose.allinone.yml` and
    docs in `docs/DEPLOYMENT.md` §4.0.
- Root `.dockerignore`, so every image build skips `node_modules`, `.env` files, git history
  and docs.
- Terminal workspace **session recovery**:
  - Tabs re-attach automatically after network drops, with backoff and offline awareness.
  - When a session is really gone (Shellius restarted, access expired or revoked, admin
    terminated, detach timeout, remote `exit`), the tab shows a recovery card. It explains
    what happened and offers what will work with your *current* access: Reconnect, View
    request, Request access again, or Quick Connect again (prefilled; one-off passwords are
    never stored).
  - Recovery happens in the same tab, so its place and split are kept.
  - A banner offers **Reconnect all** when several tabs are affected.
  - New `GET /api/terminal/sessions/:id/recovery` and `POST /api/terminal/sessions/:id/reconnect`.
- Terminal workspace **Workspaces**: tabs merged into a split become one tab in the tab bar
  ("Workspace", renameable), with a member count and combined status. You can reorder it,
  cycle to it with the keyboard, ungroup it, close it (sessions keep running) or end all its
  sessions.
- Redesigned **Sessions panel**: "Running in background" (with Attach all) and "Open in tabs"
  sections. Rows show auth method, age and time left before a detached session closes or access
  ends; click a row to open or attach it; Duplicate/End on hover; filter; proper empty state.
- On startup, SSH sessions left `ACTIVE` by a crashed or killed backend are closed with reason
  `server_restart`.
- Running sessions that aren't open in a tab can be re-attached from the **"+" New connection
  dialog** as well as the empty workspace, with **Attach all**. The Sessions button shows how many
  are waiting.
- **Keystore, Key Deployment & Quick Connect** — a deliberate, admin-sanctioned
  exception to the "zero static keys" principle for hosts that can't be
  CA-bootstrapped (appliances, customer-owned boxes, legacy systems):
  - **Keystore**: store reusable SSH key pairs (generated or imported) and
    "Identities" (`username` + password / key / both), all encrypted at rest
    (AES-256-GCM) and never returned by list/get endpoints — only fingerprints
    and `hasPassword`/`hasPassphrase` flags. Private key export is
    admin-only and audited.
  - **Key import** in every common format — OpenSSH (incl. bcrypt-encrypted),
    PEM PKCS#1 RSA (incl. legacy `Proc-Type: 4,ENCRYPTED`), SEC1 EC, PKCS#8
    (plain and encrypted), and PuTTY `.ppk` v2/v3 (Argon2). ed25519, RSA and
    ECDSA (nistp256/384/521); DSA is rejected as deprecated. An optional
    OpenSSH user certificate can be attached to an imported key and is
    validated against it.
  - **Key Deployment**: push, remove, or rotate a key across many servers in
    one batch (BullMQ-backed, async), with sudo support and automatic
    Identity repointing on rotation.
  - **Quick Connect**: ad-hoc SSH sessions (password, key, or a saved
    Identity) without saving a server, via short-lived, single-use, encrypted
    Redis tickets (60s TTL). Refuses any host matching a saved production
    server — Quick Connect can never be used to route around the approval
    flow. A target can be saved as a real server afterwards.
  - **Quick Connect history**: per-user, last 7 days, no secrets — a
    dashboard "Recent Quick Connects" widget with one-click reconnect.
  - Servers gained `authMode: certificate | credential` — a `credential` mode
    server uses a stored Identity instead of the CA and needs no bootstrap
    agent. Host keys are pinned (TOFU) per server; a mismatch blocks the
    connection until an admin resets the pin.
  - See `docs/keystore-and-quick-connect.md` for the full API contract.

- **Unified SSH engine** — every outbound SSH connection (web terminal,
  key deployment, credential tests, provisioning) now goes through one `ssh2`
  based client (`backend/src/services/sshConnect.js`); the backend no longer
  shells out to the OpenSSH `ssh` binary. Adds RSA (`rsa-sha2-256/512`) and
  ECDSA certificate authentication alongside ed25519, with the legacy SHA-1
  `ssh-rsa-cert-v01` intentionally never offered. Covered by a self-contained
  end-to-end test (`npm run test:e2e:ssh`) that spins up disposable sshd
  containers. Outbound SSH targets are guarded against loopback / link-local
  (incl. the cloud metadata address `169.254.169.254`) / unspecified /
  multicast addresses, resolved once to prevent DNS-rebinding
  (`SSH_TARGET_ALLOW_LOOPBACK` opts a lab deployment back in — never enable
  in production).

- **Terminals workspace** — a persistent, Termius-style in-app terminal:
  - SSH sessions are **detachable**: closing a tab or the browser no longer
    kills the session. A `terminalHub` keeps it alive server-side, buffers
    recent output for replay, and fans output out to every attached socket.
    A detached session auto-ends after `TERMINAL_DETACH_TTL_SECONDS`
    (default 15 min) unless reattached first.
  - Tabs, split panes (2-up, 2-down, 2x2 grid), duplicate, rename, and a side
    panel listing every live session (including ones not open in any tab)
    with Attach / Duplicate / End.
  - Workspace layout persists in `localStorage` (session IDs + labels only,
    no secrets) and reconnects/replays on reload.
  - Session recording is continuous across detach/attach (one recording per
    SSH session, not per WebSocket).
  - Known limitation: reattach requires hitting the same backend instance
    that owns the session — multi-replica deployments need sticky routing on
    `/api/terminal/*` (see Deployment docs).

- **Multi-provider SSO, including GitHub** — an org can now enable several
  SSO providers simultaneously (Google, Microsoft Entra ID, Okta, Auth0, any
  generic OIDC IdP, and GitHub via OAuth 2.0, including GitHub Enterprise
  Server), each with its own login button, allowed domains / allowed GitHub
  orgs, default role, and auto-provisioning setting. Linked identities live
  per-provider per-user (`UserIdentity`), so a user can sign in with more
  than one method. `GET /api/auth/me` lists linked identities;
  unlinking is blocked if it would leave the user with no way to sign in.

- **Auth & session hardening** (parity pass, see `docs/auth-hardening.md`):
  - Access tokens are now explicitly **typed** (`typ: 'access'`) — MFA
    challenge, bootstrap, and gateway tokens can never be replayed as bearer
    tokens.
  - Refresh tokens are single-use and grouped into rotation **families**;
    reuse of an already-rotated token outside a 10s grace window revokes the
    whole family and is audited (`auth.refresh_reuse`). Families carry an
    absolute lifetime (`SESSION_ABSOLUTE_TTL`, default 30 days) independent
    of activity.
  - Every request re-checks the user's live status and `sessionsValidFrom` —
    role demotions, suspensions, and forced-logouts (`POST
    /api/users/:id/revoke-sessions`) take effect immediately, not at next
    token refresh.
  - Account lockout after repeated failed local logins
    (`AUTH_LOCKOUT_THRESHOLD` / `AUTH_LOCKOUT_MINUTES`, default 5 / 15 min),
    admin unlock endpoint, constant-time handling of unknown emails.
  - TOTP and email-OTP MFA, backup codes, per-org enforcement
    (`MfaConfig.enforced`), and a `GET /api/auth/sessions` /
    `DELETE /api/auth/sessions/:id` device/session manager in the UI.
  - SSO (OIDC) callback now verifies the ID token signature via JWKS and
    checks `iss`/`aud`/`exp`/`nonce`; PKCE (S256) on every provider.
  - New "hardened sign-in" frontend flow covering MFA challenge, session
    list, and lockout messaging.

- **Production approval bypass role** — `server.environment === 'prod'` still
  requires manager approval by default (unchanged invariant), but an org can
  now configure `Organization.settings.access.prodApprovalBypassMinRole`
  (`admin` (default) | `super_admin` | `none`) so sufficiently privileged
  roles get immediate, audited access (`access_request.prod_bypass`) instead
  of waiting on a reviewer. Policy `autoApprove` can no longer silently grant
  unreviewed prod access to roles below the bypass threshold — the prod
  invariant is enforced centrally, not per-policy.

- **Global search & command palette** — `GET /api/search` searches servers,
  customers, users, identities, keys, and policies in one call (role-gated
  per type, org-scoped); a command palette (`Ctrl/Cmd+K`) and a Quick Actions
  menu surface it in the UI, alongside deep-linkable create/import modals
  (`?action=new`, `?action=invite`, etc.) and expanded keyboard shortcuts.

- **Avatars** — user profile pictures (uploaded, ≤150KB WebP) or inherited
  from the SSO provider; every API that embeds a user now returns a
  consistent `{ id, name, email, avatarUrl }` shape.

- Dashboard redesign: compact metric cards, a "Recent activity" feed, "Recent
  Quick Connects", and a Quick Actions widget.

- `cd backend && npm run db:seed:demo` — an idempotent, clearly-tagged demo
  dataset for screenshots/demos (never runs automatically; `-- --reset` to
  remove it).

### Changed

- Terminal workspace: **splits now belong to their tabs** instead of being one layout for the
  whole page. Opening or selecting a tab outside a split shows it full size, with no empty half
  pane. Choosing Single on one tab no longer collapses another split, and several splits can
  exist side by side. Clicking any tab of a split brings the split back. New "Remove from
  split" tab action and split icons on grouped tabs. See `docs/terminal-workspace.md`.
- UI consistency pass: uniform badges and "user cell" rendering (avatar +
  name + email) across every table, centred/borderless topbar controls,
  consistent dialog widths and dropdown clipping fixes, a lighter dark theme
  palette with raised cards/popovers, and a reworked topbar (search-by-action,
  avatar-only user menu, theme menu).
- `GET /api/search` `counts` now report **total** matches per type, not just
  the truncated page returned, so the UI can show "12 more…".
- Server detail header actions condensed into a "More" menu.

### Fixed

- Terminal workspace: switching tabs or layouts no longer reconnects every terminal it moves.
  That produced "Too many requests" errors after a few quick switches or a reload with several
  tabs, and stray prompt lines from resizes while a tab was hidden. Terminals also stop sending
  no-op or zero-size resizes to the remote shell.
- Terminal workspace: saved tabs are now per user, so another person signing in on the same
  browser no longer inherits them.
- Access request status tabs retry by themselves when Shellius is briefly unreachable, and
  "Request again" reuses the tab.
- Access requests: the sidebar badge showed the unread-notification count. It now shows
  requests waiting for your review, the same number as the "Pending reviews" tab, and updates
  after you approve or deny.
- Access requests: the status filter (`?status=`) was accepted by the API but ignored, so
  "All statuses / Approved / Expired…" didn't filter.
- Audit log: expandable rows no longer trigger React's missing-`key` warning.
- Fresh installs: gap-fill migrations for the CA/certificate tables so a
  brand-new database created via `prisma migrate deploy` ends up byte-for-byte
  identical to one that evolved through every historical migration. Verified
  by `backend/scripts/verify-migrations.sh` (`npm run db:verify-migrations`)
  against three scenarios: fresh DB, an existing `main`-schema DB, and an
  existing DB with every current migration already marked applied.
- Redis client now honours `REDIS_URL` everywhere (a code path was falling
  back to individual `REDIS_HOST`/`REDIS_PORT` vars even when `REDIS_URL` was
  set).
- A cancelled Quick Connect attempt no longer burns the connection ticket it
  never used.
- Web terminal no longer hangs silently on "Connecting" in dev — connect
  failures now surface a timeout/error instead.
- Terminal resize/close control frames were, in some races, typed into the
  shell instead of being intercepted as control messages.
- Terminal tabs now resume their own session correctly on reload (no
  duplicate render loop; detached sessions are reachable again from the
  workspace).

### New environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SSH_TARGET_ALLOW_LOOPBACK` | `false` | Allow outbound SSH to loopback targets (dev only — never enable in production) |
| `TERMINAL_DETACH_TTL_SECONDS` | `900` | How long a detached terminal session stays alive before it's ended |
| `SESSION_ABSOLUTE_TTL` | `2592000` (30d) | Absolute refresh-token-family lifetime |
| `AUTH_LOCKOUT_THRESHOLD` | `5` | Failed local logins before account lockout |
| `AUTH_LOCKOUT_MINUTES` | `15` | Lockout duration |
| `SSO_ALLOWED_DOMAINS` | *(any)* | Comma-separated allow-list for env-preset SSO providers |
| `SSO_GOOGLE_CLIENT_ID` / `_SECRET` | — | Google OIDC env preset |
| `SSO_ENTRA_TENANT_ID` / `_CLIENT_ID` / `_CLIENT_SECRET` | — | Microsoft Entra ID env preset |
| `SSO_OKTA_DOMAIN` / `_CLIENT_ID` / `_CLIENT_SECRET` | — | Okta env preset |
| `SSO_AUTH0_DOMAIN` / `_CLIENT_ID` / `_CLIENT_SECRET` | — | Auth0 env preset |
| `SSO_CLIENT_ID` / `_CLIENT_SECRET` (+`SSO_ISSUER_URL`) | — | Generic OIDC / GitHub (incl. GHES) env preset |
| `KEY_DEPLOYMENT_CONCURRENCY` | `5` | BullMQ concurrency for key deployment jobs |
| `ONBOARDING_CONCURRENCY` | `5` | BullMQ concurrency for server onboarding jobs |
| `TRUST_PROXY` | — | Trusted reverse-proxy hop count for client-IP resolution |
| `RECORDINGS_DIR` | `./data/recordings` | Local fallback recording path when no object storage is configured |

See `docs/DEPLOYMENT.md` for the complete reference (every variable, not just
new ones this release).

### Breaking changes

- **Everyone must sign in again.** Access tokens are now typed and existing
  untyped tokens are rejected; refresh tokens are re-scoped into rotation
  families. There is no in-place token migration.
- The terminal workspace requires WebSocket upgrade support all the way
  through your reverse proxy for `/api/terminal/*` (this was already true for
  the plain web terminal; the new detach/reattach and Quick Connect flows
  make it load-bearing for more of the app). Confirm `Upgrade`/`Connection`
  headers are forwarded — see `docs/DEPLOYMENT.md`.
- `ssh2` is now pinned to an exact version because of the custom certificate
  signing override — do not bump it without re-running
  `npm run test:e2e:ssh`.
- Reattaching a detached terminal session only works against the backend
  instance that owns it. If you run multiple backend replicas, you now need
  sticky sessions on `/api/terminal/*` (see Deployment docs) — this is new
  with the Terminals workspace; the old one-shot `/terminal` page tolerated
  any replica.

### Migration notes

- Run `docker compose ... exec backend npx prisma migrate deploy` as usual
  (or let the container entrypoint do it automatically — see
  `docker/entrypoint-backend.sh`). If `prisma migrate status` reports drift on
  an older installation, see "Upgrading an existing deployment" in
  `docs/DEPLOYMENT.md` for the gap-fill/baseline procedure.
- Existing single-provider SSO configuration migrates automatically to the
  new multi-provider `SsoConfig` model on first read — no manual action
  needed; the legacy `GET/PUT /api/auth/sso/config` endpoints keep working
  against the first provider.
- All users are signed out on upgrade (see Breaking changes) — this is
  expected, not a bug.

## [1.0.2] - 2026-04-09

### Changed

- Seed script now upserts baseline groups and access policies on every
  container boot (previously first-boot only), so deployments that started
  before those defaults existed pick them up on upgrade without a manual seed
  run.

## [1.0.1] - 2026-04-09

### Changed

- Frontend: topbar and sidebar now share one `UserMenu` dropdown component
  instead of two divergent implementations.

## [1.0.0] - 2026-04-09

### Added

- Production `docker-compose.prod.yml` mirroring the VaultHive Traefik labels (single host, HTTP entrypoint, Cloudflare-fronted)
- Bundled Nginx (`docker/nginx-proxy.conf`) that fronts the backend and frontend over a single port and is the only Traefik-attached service
- `super_admin` bypass in `policyService.evaluate` -- super admins get direct access to every server, including production, with no approval flow (superseded by the configurable `prodApprovalBypassMinRole` in 1.1.0)
- TUI `/device` browser approval page (`frontend/src/pages/Device.jsx`) so users can confirm device codes from the web UI
- README, SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, and CHANGELOG documentation

### Changed

- TUI `apiEnvelope.error` field now tolerates both string and object shapes returned by the backend
- TUI `serverListData` now decodes the backend's `items[]` response shape (was `servers[]`)
- TUI status bar now reads `RefreshToken` instead of `AccessToken` for the "session active" indicator -- expired access tokens no longer scare the user when a refresh token is still on disk
- TUI initial-view check now treats the presence of a refresh token as "logged in"; access tokens refresh transparently on the first API call
- TUI `app.go` global key handler now only quits on `Ctrl+C` (the previous `||`/`&&` precedence bug bound plain `q` as a global quit, breaking the host-list filter)

### Fixed

- DNS collision in the production stack: `shellius-nginx` was sometimes resolving the bare name `frontend` to JobTracker's container on the shared `homelab` network. Both backend and frontend now have unique container names (`shellius-api`, `shellius-web`) and explicit network aliases.
- TUI hostlist textinput now receives its `Focus()` command, so the filter actually captures keystrokes
- TUI `auth.SaveTokens` now persists the user's role into `~/.shellius/config.yaml` so super-admin status survives restarts
- Certificates page: removed a duplicate text label in the "Valid Until" column.

## [0.3.0] - 2026-04-07

Connect button fix, dashboard stat card redesign, and a private-repo-friendly
CLI/TUI install flow.

## [0.2.0] - 2026-04-07

### Added

- **Phase 17F — Profile, GDPR, self-service registration**
  - New `/profile` page: edit display name, change password (LOCAL accounts only), download a GDPR JSON export of every record about you, and delete your account with a type-to-confirm danger zone (soft-delete + 30-day grace before hard purge)
  - `/register` page gated by per-org `selfServiceRegistrationEnabled` flag: email-verified signup pinned to the `viewer` role, enumeration-safe responses, rate-limited
  - Email verification flow with new `verifyEmail` template and `EMAIL_VERIFY` token type in `inviteService`
  - `accountDeleted` and `smtpTest` email templates added to the registry
  - `passwordChangedAt`, `deletedAt` columns on `User`; `pending_verification` and `deleted` states added to `UserStatus` enum; `selfServiceRegistrationEnabled` added to `Organization`
  - `authService.login` now blocks accounts in `deleted` state
  - Login page `?deleted=1` confirmation banner; AcceptInvite page rebranded as "Set up your account" with name + Terms checkbox
- **Phase 18 — UX polish & defensive guards**
  - DataTable v2 rows-per-page selector (10/25/50/100) wired through every consuming page
  - Sidebar collapse mode tightens icon-only nav, adds tooltips, and surfaces a Profile shortcut alongside Settings
  - QuickConnect button polls active access every 60s and defensively re-validates `{status, expiresAt}` so an expired AR cannot show "Connect"
  - Policy evaluator API derives a canonical `outcome` field (`allow` / `deny` / `requires_approval`) so the UI has a single source of truth
  - New `PrivateIPWarning` component (banner / pill / note variants) wired into QuickConnectModal, RequestForm, ServerForm, and ServerDetail to flag RFC1918 / CGNAT / link-local hosts that need a VPN
- App-wide footer with version badge and Privacy / Terms / EULA / GitHub links, plus in-app legal pages at `/legal/:doc`
- 84 new Jest tests across registration, profile, access-request audit, policy outcome, and email templates (full suite: 174/174 passing)

### Changed

- Templated SMTP test email (`smtpTest`) replaces the plaintext one-liner — admins now see the shared HTML layout and full host/port/TLS context

## [0.1.0] -- 2026-04-06

Initial public release. Phases 1-3 and 5-12 of the project blueprint are
shipped; Phase 4 (multi-cloud connectors) is parked behind a flag.

### Phase 1 -- Foundation

- Project scaffolding (backend, frontend, TUI, docker compose, .env.example)
- PostgreSQL 16 + Prisma ORM
- Redis 7 + BullMQ scaffolding
- Express backend with authentication, RBAC, audit, tenant scoping middleware
- React 18 + Vite + Tailwind + shadcn/ui frontend shell

### Phase 2 -- Identity & Auth

- Email/password login with bcrypt
- JWT access + refresh tokens
- SSO via Passport (OIDC, SAML)
- RFC 8628 device authorization flow
- User and group management

### Phase 3 -- Customers & Servers

- Customer CRUD
- Server CRUD with environment tags (`demo`/`dev`/`staging`/`prod`)
- Health check service with TCP probe
- Frontend pages for customer and server management

### Phase 5 -- SSH Certificate Authority

- `CaKeyPair` and `Certificate` Prisma models
- `caService` with Ed25519 generation, AES-256-GCM encrypted-at-rest private key, `ssh-keygen`-based signing, rotation, and revocation
- `certificateService` with policy-driven issue, list, revoke, and verify
- `/api/certificates` and `/api/ca` routes
- Cert-expiry BullMQ job
- Certificates page and CA management section in Settings

### Phase 6 -- Access Policies

- `AccessPolicy` and `PolicySubject` models
- `policyService.evaluate` with prod hard-rule, deny-before-allow precedence, group resolution
- CRUD routes
- Policies page with multi-step PolicyForm
- "My Access" dashboard widget

### Phase 7 -- Access Requests & Approval Flow

- `AccessRequest` and `Notification` models
- `accessRequestService` with policy-driven submit, manager review, ephemeral SSH key generation, and (placeholder) RDP file generation
- `/api/access-requests` and `/api/notifications` routes
- BullMQ jobs: expire approved requests, expire pending requests, notify-expiring (deduplicated)
- AccessRequests page (My Requests / Pending Reviews / All tabs), RequestForm, ApprovalCard, CredentialDownload
- NotificationContext + NotificationBell with 30s polling

### Phase 8 -- Web Terminal

- `Session` Prisma model
- `terminalService` WebSocket SSH proxy via `ws` + `ssh2`, JWT upgrade auth, per-connection ephemeral cert, in-memory session map for force-terminate
- `/api/sessions` routes
- xterm.js `WebTerminal` component, Terminal page (full viewport), Sessions page

### Phase 9 -- TUI Client

- Go 1.22 + Bubble Tea TUI
- Device authorization flow with auto-open browser
- Token persistence in `~/.shellius/config.yaml` with auto-refresh
- Host list grouped by customer with environment badges and fuzzy filter
- Access request form with polling
- SSH handoff via `tea.ExecProcess`
- Cross-compile via `make build-all` (linux/darwin/windows × amd64/arm64)

### Phase 10 -- Audit & Session Recording

- `auditService` with action taxonomy (auth, user, group, customer, server, policy, access_request, cert, session, ca, connector, org)
- `/api/audit` and `/api/audit/export` routes (CSV + JSON)
- asciinema v2 `.cast` recording teed from the SSH stream
- `GET /api/sessions/:id/recording`
- `sessionCleanup` BullMQ job (1h) -- ends stale sessions and prunes recordings past retention
- AuditLog page with filters and export
- SessionPlayer component (asciinema-player)

### Phase 11 -- RDP Support

- `guacd` (Apache Guacamole daemon) added to docker-compose
- Server model gains `rdpUsername` and AES-256-GCM-encrypted RDP password fields
- `rdpService` implements the Guacamole protocol handshake by hand
- WebSocket RDP proxy at `/api/terminal/rdp` with short-lived gateway JWT
- `accessRequestService.generateRdpFile` returns a real `.rdp` file (RD Gateway support deferred)
- `RdpTerminal` frontend component using `guacamole-common-js`
- `Terminal` page now branches on `request.protocol`
- Servers page shows distinct icons for SSH vs RDP

### Phase 12 -- Polish & Deployment

- Dashboard with stat cards, quick actions, MyAccessWidget, recent activity feed
- Settings page tabbed: Organization, CA Management, SSO, Cloud Connectors (parked notice), Notifications
- Loading skeletons, empty states, ErrorBoundary, NotFound 404
- Keyboard shortcuts (`/` focus, `g+d`/`g+s`/`g+a`/`g+c` navigation)
- Production `docker-compose.prod.yml` with healthchecks, resource limits, named volumes, Traefik labels
- `/api/metrics` Prometheus endpoint protected by `METRICS_TOKEN`
- Backup scripts (`backup-db.sh`, `backup-recordings.sh`)
- `docs/deployment.md`
