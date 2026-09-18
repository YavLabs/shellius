/**
 * Quick Connect terminal launch helpers.
 *
 * The default path for every "Connect" entry point is now an in-app
 * TerminalWorkspaceContext tab (see context/TerminalWorkspaceContext.jsx) —
 * call sites (components/quickConnect/QuickConnectModal.jsx,
 * components/dashboard/RecentQuickConnectsWidget.jsx,
 * components/workspace/NewConnectionDialog.jsx) call
 * `useTerminalWorkspace().openTab({ ticket }, meta)` directly, which
 * navigates to /terminals.
 *
 * These window-based helpers remain only for the explicit "Open in new
 * window" secondary action (standalone `/terminal?ticket=...`), where a
 * popup-blocker-safe blank tab must be opened synchronously before any
 * `await`.
 */

export function openBlankTerminalTab() {
  return window.open('', '_blank');
}

export function openTicketTerminal(win, { ticket, label }) {
  const url = `/terminal?ticket=${encodeURIComponent(ticket)}&label=${encodeURIComponent(label || 'Quick Connect')}`;
  if (win) win.location = url;
  else window.open(url, '_blank');
}

export function closeBlankTerminalTab(win) {
  win?.close();
}
