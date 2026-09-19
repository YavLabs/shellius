# Email Templates

Shellius sends every email through a small registry of HTML templates
under `backend/src/email/`. Each template renders an inline-styled HTML
body in the Shellius brand (Ink → Indigo header with the Shellius lockup,
Sky → Lavender accent rule and buttons) plus a plain-text fallback that's
readable on its own. Delivery is covered in `docs/email-delivery.md`.

## Directory layout

```
backend/src/email/
├── escape.js              # tiny HTML escape helper (no deps)
├── brand.js               # brand colours + header logo URL resolution
├── layout.js              # shared inline-styled HTML layout
├── button.js              # CTA button helper with MSO conditional fallback
├── index.js               # registry + renderTemplate(name, vars)
└── templates/
    ├── invite.js
    ├── passwordReset.js
    ├── passwordChanged.js
    ├── accessRequestSubmitted.js
    ├── accessRequestApproved.js
    ├── accessRequestDenied.js
    └── certificateExpiring.js
```

## Render contract

Every template module exports a `render(vars) → { subject, html, text }`
function. Subject lines start with `[Shellius]` for inbox filtering.

```js
import { renderTemplate } from '../email/index.js';
import { sendMail } from '../services/mailer.js';

const tpl = renderTemplate('invite', {
  recipientName: user.name,
  orgName: org.name,
  inviteUrl,
  expiresInHours: 168,
});

await sendMail({
  orgId,            // required for per-org SMTP config lookup
  to: user.email,
  subject: tpl.subject,
  html: tpl.html,
  text: tpl.text,
});
```

## Adding a new template

1. Drop a new file under `templates/`, e.g. `templates/welcomeBack.js`:

   ```js
   import { escapeHtml as esc } from '../escape.js';
   import { renderLayout } from '../layout.js';
   import { button } from '../button.js';

   export function render({ recipientName, dashboardUrl }) {
     const subject = '[Shellius] Welcome back';
     const safeName = esc(recipientName || 'there');
     const safeUrl = esc(dashboardUrl);

     const bodyHtml = `
       <h1 style="margin:0 0 16px;font:600 22px/1.3 -apple-system,sans-serif;color:#0a0a0a">
         Welcome back
       </h1>
       <p style="margin:0 0 16px;font:400 15px/1.5 -apple-system,sans-serif;color:#3f3f46">
         Hi ${safeName}, it's been a while!
       </p>
       <div style="margin:32px 0;text-align:center">
         ${button({ href: safeUrl, label: 'Open Dashboard' })}
       </div>
     `;

     const text = `Welcome back, ${recipientName}.\n\nDashboard: ${dashboardUrl}`;

     return {
       subject,
       html: renderLayout({ title: subject, preheader: 'Welcome back', bodyHtml }),
       text,
     };
   }
   ```

2. Register it in `backend/src/email/index.js`:

   ```js
   import * as welcomeBack from './templates/welcomeBack.js';

   const TEMPLATES = {
     invite,
     passwordReset,
     // ...
     welcomeBack,
   };
   ```

3. Add a sample-vars entry in `backend/scripts/preview-email.js` so
   the preview CLI works for the new template.

4. Add a Jest test in `backend/src/email/__tests__/templates.test.js`
   covering the new template's render contract and XSS escape.

## Previewing locally

```bash
node backend/scripts/preview-email.js invite > /tmp/invite.html
open /tmp/invite.html        # macOS
xdg-open /tmp/invite.html    # Linux
```

For the plain-text fallback:

```bash
node backend/scripts/preview-email.js invite --text
```

## XSS safety

**Every** variable interpolated into a template body MUST go through
`escapeHtml()`. The helper escapes the five HTML metacharacters
(`< > " & '`). Templates should NEVER use raw template literals on
user-supplied data without `esc(...)`. The Jest suite verifies this
with `<script>x</script>` and `&` test cases on the invite template
— extend the suite when you add a template that takes new user input.

## Header logo

The header shows the hosted PNG lockup
`${APP_URL}/brand/png/shellius-lockup-dark-bg-640x128.png` (served by the web
app from `frontend/public/brand/png/`) at 200×40 with `alt="Shellius"`. The
app URL is resolved like every other link (`APP_URL` → `PUBLIC_BASE_URL` →
`FRONTEND_URL` → `https://$TRAEFIK_HOST`). When none is set, or it points at
localhost (which a recipient's mail client can't reach), the header renders
an HTML-only wordmark instead — "SHELL", a small Sky → Lavender block, "US" —
so there is never a broken image. Never use `data:` URIs or SVG in emails:
Gmail and Outlook block them.

Brand colours (`brand.js`): Ink `#09090C`, Indigo `#141A2E`, Sky `#8FB6F5`,
Lavender `#B9A6F2`, Light `#EDEEF2`, Muted `#8A8D94`. Buttons use the
Sky → Lavender gradient with Ink text and a solid Sky `background` /
`bgcolor` / VML fill for clients without CSS gradients (Outlook desktop).
`button({ href, label, color })` with an explicit `color` renders a solid
button with white text (e.g. the red "Reject").

## Mail-client compatibility

The shared `layout.js` uses 100% inline styles, a 600px max-width
table layout, MSO conditional comments where appropriate, and a
preheader `<div>` for inbox preview text. Tested in Gmail, Apple Mail,
Outlook (web + desktop), and the GitHub email rendering on PR
notifications.

## Plain-text fallback

Every template returns BOTH `html` and `text`. The plain-text version
is mandatory — some clients (terminal mail readers, DLP scanners,
accessibility tools) prefer it. Keep the text version readable on its
own: include the key URL on its own line, no Markdown.
