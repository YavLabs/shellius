# Task 17D: Default Policies Seed + Per-Page Help Drawer

**Agent:** db + backend + frontend
**Status:** [x] Done
**Blocks:** 17Q-D, 17R-D
**Blocked By:** None
**Model:** sonnet

## Part 1 — Default policies

When a fresh org has no `AccessPolicy` rows, seed three:

1. `default-allow-non-prod` — priority 100 — ALLOW — any user — any
   server in (`demo`,`dev`,`staging`) — `maxSessionDuration: 3600`,
   `requireApproval: false`, `autoApprove: true`
2. `default-prod-requires-approval` — priority 50 — ALLOW — any user
   — any server in (`prod`) — `maxSessionDuration: 1800`,
   `requireApproval: true`, `autoApprove: false`
3. `default-deny-inactive` — priority 10 — DENY — users with
   `status='deactivated'` — all servers

Implementation: idempotent backend startup job in
`backend/src/jobs/seedDefaultPolicies.js` that checks
`prisma.accessPolicy.count({ where: { orgId } }) === 0` per org and
seeds if so. Hooked into `startAllJobs()` in `app.js`.

## Part 2 — Per-page Help drawer

- New `frontend/src/components/common/HelpDrawer.jsx` — a slide-in
  panel from the right edge of the viewport (Radix Dialog or a CSS
  fixed panel). Triggered by a `?` icon button.
- New `frontend/src/components/common/HelpButton.jsx` that renders the
  `?` icon and opens the drawer.
- New `frontend/src/config/helpContent.js` — keyed by page slug,
  values are `{ title, summary, sections: [{ heading, body }] }`.
  Cover every top-level page with 3-5 sections each.
- Wire the HelpButton into PageHeader as an optional right slot when
  the page passes `helpKey="<slug>"`.
- Update every PageHeader call to pass the appropriate `helpKey`.

## Acceptance
- Fresh DB → 3 default policies appear in /policies on first login.
- Every top-level page has a `?` icon in the header that opens a
  drawer with help content.
- Help text is clear, friendly, and explains what each page does.
