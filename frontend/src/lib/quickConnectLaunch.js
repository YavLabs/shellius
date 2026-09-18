/**
 * Quick Connect terminal launch helpers — the single place that turns a
 * Quick Connect ticket into an open web terminal. Shared by
 * components/quickConnect/QuickConnectModal.jsx (fresh ticket) and
 * components/dashboard/RecentQuickConnectsWidget.jsx ("Connect again" /
 * reconnect ticket) so there is exactly one implementation to redirect when
 * Quick Connect terminals move from "new browser tab" to an in-app terminal
 * workspace tab — swap the body of `openTicketTerminal` (and friends)
 * without touching call sites.
 */

// Opens a blank tab synchronously — call this BEFORE any `await` so popup
// blockers don't kick in once control returns from the network request.
export function openBlankTerminalTab() {
  return window.open('', '_blank');
}

// Navigates a tab opened via `openBlankTerminalTab` (or, if it was blocked,
// opens a fresh one) to the web terminal for a Quick Connect ticket.
export function openTicketTerminal(win, { ticket, label }) {
  const url = `/terminal?ticket=${encodeURIComponent(ticket)}&label=${encodeURIComponent(label || 'Quick Connect')}`;
  if (win) win.location = url;
  else window.open(url, '_blank');
}

// Closes a tab opened via `openBlankTerminalTab` when the request that was
// going to populate it failed.
export function closeBlankTerminalTab(win) {
  win?.close();
}
