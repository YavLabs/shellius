# Task 16C: HTML Email Template Infrastructure

**Agent:** backend
**Status:** [x] Done
**Blocks:** 16D, 16Q-C, 16R-C
**Blocked By:** None
**Model:** sonnet

## Deliverables
New directory `backend/src/email/`:

### layout.js
Exports `renderLayout({ title, preheader, bodyHtml, footerHtml })`.
Returns a complete HTML document with:
- `<!DOCTYPE html>` + mobile-responsive viewport meta
- Inline CSS only (no external stylesheets — mail clients strip them)
- Header bar: dark background `#0a0a0a`, Shellius wordmark + tagline
  "SSH/RDP Access Management"
- Body container: max-width 600px, white background, 32px padding
- CTA button style available via `button({ href, label })` helper —
  emerald `#10b981` background, white text, 12px radius
- Footer: org name, year, support link, "you received this because..."
- Preheader text (hidden from view but shown in inbox preview)

### escape.js
Tiny HTML-escape helper (no npm dep).

### templates/
One file per email type, each exporting
`render({ ...vars }) → { subject, html, text }`:

- `invite.js` — `{ recipientName, orgName, inviteUrl, expiresInHours }`
- `passwordReset.js` — `{ recipientName, resetUrl, expiresInHours }`
- `passwordChanged.js` — `{ recipientName, ipAddress, userAgent, when }`
- `accessRequestSubmitted.js` — `{ reviewerName, requesterName, serverHostname, environment, reason, reviewUrl }`
- `accessRequestApproved.js` — `{ recipientName, serverHostname, environment, expiresAt, connectUrl }`
- `accessRequestDenied.js` — `{ recipientName, serverHostname, deniedReason }`
- `certificateExpiring.js` — `{ recipientName, serverHostname, expiresAt, renewUrl }`

Every template returns BOTH `html` and a plain-text fallback. Subject
lines start with `[Shellius]` for easy inbox filtering.

### mailer.js integration
- New overload: `sendMail({ orgId, to, template, vars })`
- Looks up the template by name from a registry, calls its `render()`,
  passes the result to the existing transport
- Old shape `{ to, subject, html, text }` still works

## Docs
New `docs/email-templates.md`:
- How templates are structured
- How to add a new one (template file + registry entry + test)
- How to preview: `node backend/scripts/preview-email.js invite > /tmp/out.html && xdg-open /tmp/out.html`
- Screenshots of each rendered template

## Acceptance
- Every template renders valid HTML (paste into Litmus/Mail-tester)
- Plain-text fallback is readable on its own
- No new npm dependencies
- Docs show a preview of each template
