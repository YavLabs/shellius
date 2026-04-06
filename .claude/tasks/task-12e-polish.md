# Task 12E: UI Polish

**Agent:** frontend
**Status:** [ ] Pending
**Blocks:** None
**Blocked By:** None

## Objective
Add loading skeletons, empty states, error boundaries, responsive design improvements, keyboard shortcuts, and a 404 page for a polished production-ready UI.

## Deliverables
- **Loading skeletons** — skeleton components for:
  - Data tables (animated rows with gray blocks)
  - Dashboard cards (pulsing placeholder boxes)
  - Detail panels (text line placeholders)
  - Reusable `Skeleton` component with variants: text, card, table-row, avatar
- **Empty states** — meaningful empty states for:
  - Servers page: illustration + "No servers yet" + "Add Server" CTA
  - Certificates page: "No certificates issued" + link to docs
  - Access Requests: "No requests yet" + "Request Access" CTA
  - Policies: "No policies configured" + "Create Policy" CTA
  - Sessions: "No active sessions"
  - Audit Log: "No events matching filters"
- **Error boundaries**:
  - `client/src/components/ErrorBoundary.jsx` — catches render errors, shows friendly message with "Try Again" button
  - Page-level error boundaries wrapping each route
  - API error fallback component for failed data fetches
- **Responsive design**:
  - Mobile-friendly navigation (hamburger menu / bottom nav)
  - Data tables switch to card layout on small screens
  - Forms stack vertically on mobile
  - Terminal page goes full-screen on mobile
- **Keyboard shortcuts**:
  - Global: `/` to focus search, `g then d` for dashboard, `g then s` for servers, `?` for shortcut help
  - Table: `j/k` row navigation, `enter` to open, `d` to delete (with confirm)
  - Shortcut help modal listing all shortcuts
- **404 page**:
  - `client/src/pages/NotFound.jsx` — clean design with "Page not found" message, link to dashboard

## Acceptance Criteria
- Loading skeletons appear during data fetches (no empty flashes or layout shifts)
- Empty states show helpful messages with actionable CTAs
- Error boundaries catch rendering errors without crashing the entire app
- UI is usable on mobile devices (320px+) and tablets
- Data tables are readable on mobile (card layout or horizontal scroll)
- Keyboard shortcuts work and are discoverable via `?` modal
- 404 page renders for unknown routes
- No console errors or warnings in production build
