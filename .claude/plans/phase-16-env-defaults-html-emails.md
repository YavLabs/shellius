# Phase 16: Env Defaults, HTML Email Templates, Follow-ups

This phase closes the two Phase-15 reviewer mediums that were tracked
as follow-ups and ships two net-new features that came out of a user
request:

1. **Env-var defaults for SMTP + SSO credentials**, with UI overrides
   taking precedence.
2. **Professional HTML email templates** matching the Shellius theme
   for every email the platform sends.

Plus the two tracked mediums:

3. **Group membership audit logging** (15R-A follow-up).
4. **Client-side regex guard on SSO preset fields** (15R-E follow-up).

Every sub-task is paired with a **qa** gate and a **reviewer** gate,
same workflow rule as Phase 15. All agents already use `sonnet` — no
agent model changes needed.

## 1. Env-var defaults with UI override precedence

### Problem
Today the backend reads SMTP and SSO config **either** from env vars
**or** from the DB, but not both in a coherent precedence order:
- `mailer.js` reads SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_FROM from env
  at init time, then never looks at the DB.
- `ssoConfigService` reads/writes the DB row only; env vars are
  ignored entirely for SSO credentials.

The user workflow we want to support:
- Operator seeds defaults in `.env.prod` during deployment (e.g.
  `SMTP_HOST=smtp.sendgrid.net`, `SSO_GOOGLE_CLIENT_ID=...`)
- Super admin logs into the UI and optionally overrides them per org
  via Settings → SSO / Notifications
- Runtime resolution: **DB value if present, else env default, else
  nothing**

### Solution

#### SMTP
- `backend/src/services/mailer.js`: keep the lazy-init pattern, but
  resolve config from `smtpConfigService.get(orgId)` → merge in the
  `process.env.SMTP_*` defaults on missing fields. Per-call, not
  per-process — so an admin changing the UI row takes effect without
  a container restart.
- New table `smtp_configs` (org-scoped, encrypted password) with
  `POST/PUT /api/settings/smtp`. Reuse the `encrypt()` helper for the
  SMTP password, same as SSO client secret.
- Settings → Notifications tab gets a new **SMTP** card above the
  user-preferences toggle. Fields: host, port, user, password, from
  address, "use TLS" checkbox, Test button.
- Env vars honored (in precedence order, **lowest → highest**):
  1. `SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_USER`,
     `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE`
  2. Per-org `smtp_configs` row
- The UI shows which value is in effect and where it came from
  ("using env default" / "overridden in UI").

#### SSO
- Env var catalogue — add optional seed vars per preset:
  - `SSO_GOOGLE_CLIENT_ID`, `SSO_GOOGLE_CLIENT_SECRET`
  - `SSO_ENTRA_TENANT_ID`, `SSO_ENTRA_CLIENT_ID`, `SSO_ENTRA_CLIENT_SECRET`
  - `SSO_OKTA_DOMAIN`, `SSO_OKTA_CLIENT_ID`, `SSO_OKTA_CLIENT_SECRET`
  - `SSO_AUTH0_DOMAIN`, `SSO_AUTH0_CLIENT_ID`, `SSO_AUTH0_CLIENT_SECRET`
  - `SSO_ISSUER_URL`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET` (generic)
- `ssoConfigService.get` merges env defaults into the response so the
  wizard pre-fills them the first time an admin opens it. `upsert`
  keeps the existing UI-override-wins semantics.
- The wizard shows an "Environment default available" badge on fields
  backed by an env var so admins know what's happening.

Owner: **backend** (services + routes + migration), **frontend**
(SMTP card + SSO badge), **devops** (update `.env.prod.example`),
**qa**, **reviewer**.

## 2. HTML email templates

### Problem
`mailer.js` `sendMail({ text })` only sends plain-text bodies. The
invite/reset flows log a bare URL via `logger.warn`. There is no HTML
equivalent and no shared look-and-feel across emails.

### Solution
- New `backend/src/email/` directory:
  - `layout.js` — shared HTML layout (header with Shellius logo,
    body slot, footer with org name + support link) styled inline so
    it renders in every mail client. Theme matches the UI (dark
    header `#0a0a0a`, emerald accent `#10b981`, neutral body).
  - `templates/invite.js` — `renderInvite({ recipientName, orgName, inviteUrl, expiresIn })`
  - `templates/passwordReset.js` — `renderReset({ recipientName, resetUrl, expiresIn })`
  - `templates/accessRequestSubmitted.js` — manager notification
  - `templates/accessRequestApproved.js` — requester notification
  - `templates/accessRequestDenied.js` — requester notification
  - `templates/certificateExpiring.js` — 24h expiry reminder
  - `templates/passwordChanged.js` — post-reset confirmation (security
    hygiene — let users know if someone reset their password)
  - Every template returns `{ subject, html, text }`
- `mailer.sendMail()` accepts `{ to, template, vars }` as an alternative
  to `{ to, subject, html, text }`, looks up the template, renders it,
  and sends both the HTML and a plain-text fallback.
- Every existing callsite of `mailer.sendMail` switches to the
  template-based API.
- Templates use hand-authored inline-styled HTML. **No new npm
  dependencies** — no mjml, no handlebars, no juice. Just tagged
  template literals with variable interpolation escaped via a tiny
  `escape(s)` helper.
- Docs: `.claude/plans/phase-16-email-templates.md` (this file section)
  plus `docs/email-templates.md` with screenshots of each rendered
  template and instructions for adding a new one.

Owner: **backend** (templates + mailer integration), **devops**
(docs), **qa**, **reviewer**.

## 3. Group membership audit (15R-A follow-up)

- Add `audit('group.member.added', 'Group')` middleware to
  `POST /api/groups/:id/members`
- Add `audit('group.member.removed', 'Group')` to
  `DELETE /api/groups/:id/members/:userId`
- Payload in the audit log: `{ groupId, targetUserId, byUserId }`

Owner: **backend**, **qa**, **reviewer**.

## 4. SSO preset field regex (15R-E follow-up)

- Frontend `Settings.jsx` SSO wizard: add client-side regex validation
  on `tenantId` (UUID pattern), `oktaDomain` (hostname pattern),
  `auth0Domain` (hostname pattern) before they feed
  `deriveIssuerUrl`.
- Backend Joi: tighten `ssoConfigSchema` similarly.

Owner: **frontend** + **backend**, **qa**, **reviewer**.

## Sub-tasks

| ID  | Title                                                   | Agent         | QA | Review |
|-----|---------------------------------------------------------|---------------|----|--------|
| 16A | SMTP config table + route + service + env-merge        | backend       | 16Q-A | 16R-A |
| 16B | SSO env-defaults merge + "overridden" UI badge         | backend + frontend | 16Q-B | 16R-B |
| 16C | HTML email templates infrastructure + shared layout   | backend       | 16Q-C | 16R-C |
| 16D | Rewrite every existing sendMail callsite to use templates | backend    | 16Q-D | 16R-D |
| 16E | Group membership audit logging                         | backend       | 16Q-E | 16R-E |
| 16F | SSO preset field regex (tenantId/oktaDomain/auth0Domain) | frontend + backend | 16Q-F | 16R-F |
| 16G | Update .env.prod.example + docs/email-templates.md    | devops + planner | 16Q-G | — |

## Acceptance
- SMTP defaults in `.env.prod` are used transparently; UI override
  takes precedence without a container restart.
- SSO defaults in env vars pre-populate the wizard; saved UI config
  always wins.
- Every email sent by Shellius uses the shared HTML layout and
  renders legibly in Gmail, Outlook, and a terminal mail reader
  (text fallback works).
- Group member add/remove are visible in the audit log.
- SSO preset fields reject obviously-bad strings client-side before
  any URL is derived.
- Docs cover env defaults, email templates, and how to add a new
  template.
- All qa + reviewer gates green.
