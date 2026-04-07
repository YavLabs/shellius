# Task 17A: QuickConnect Modal Close Bug + ServerDetail Connect Button

**Agent:** debugger → frontend
**Status:** [ ] Pending
**Blocks:** 17Q-A, 17R-A
**Blocked By:** None
**Model:** sonnet

## Symptoms
1. **Modal closes mid-typing.** On the Servers list, click Connect →
   modal opens → start typing in the username Input → modal disappears
   AND navigates to the server detail page.
2. **ServerDetail has no Connect button.** It always shows "Request
   Access", even when the current user has an active approved request.

## Root cause hypotheses
1. Likely the row's `onRowClick` is firing because the modal isn't in
   a portal that stops event propagation, OR the Input's onChange
   isn't calling `e.stopPropagation()`. Less likely: a portal close-
   on-outside-click that fires on the input's container.
2. ServerDetail just hasn't been wired to QuickConnectButton — it
   still uses the old static "Request Access" Button.

## Fix
- Read `frontend/src/components/servers/QuickConnectModal.jsx` and
  find what's bubbling. Add `e.stopPropagation()` on the modal root
  AND on the Input onChange (defensive). If the modal already uses
  Radix Dialog, the issue is somewhere else — investigate.
- Read `frontend/src/pages/Servers.jsx` and check if the row click
  handler is null'd while a modal is open. The simplest fix is to
  guard the row click: only navigate if no modal is open.
- Read `frontend/src/pages/ServerDetail.jsx` and replace the static
  Request Access button with `<QuickConnectButton server={server}
  currentUser={currentUser} />` (the same component used in the list).
  This ensures both views share the Connect-vs-Request decision logic.

## Acceptance
- Typing in the QuickConnect modal does NOT close it or navigate.
- ServerDetail page's action bar shows the correct Connect/Request
  button based on the active-AR state.
- Both views use the same `QuickConnectButton` component.
