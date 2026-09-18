/**
 * runQuickAction — single implementation for executing an entry from
 * QUICK_ACTIONS (lib/commands.js), shared by the Topbar Quick Actions menu
 * (components/command/QuickActionsMenu.jsx), the command palette
 * (components/command/CommandPalette.jsx) and the Dashboard Quick Actions
 * widget (components/dashboard/QuickActionsWidget.jsx) so the three surfaces
 * behave identically.
 *
 * ctx:
 *   navigate         (href) => void — required for href-based actions
 *   openQuickConnect () => void — required for the 'quick-connect' action
 *   openPalette      () => void — required for the 'command-palette' action
 *   onBeforeRun      (action) => void — optional, called first (e.g. to
 *                    close the menu/dialog hosting the action list)
 */
export function runQuickAction(action, ctx = {}) {
  const { navigate, openQuickConnect, openPalette, onBeforeRun } = ctx;
  onBeforeRun?.(action);

  if (action.action === 'quick-connect') {
    openQuickConnect?.();
    return;
  }
  if (action.action === 'command-palette') {
    openPalette?.();
    return;
  }
  if (action.action === 'shortcuts-help') {
    window.dispatchEvent(new CustomEvent('shellius:open-shortcuts'));
    return;
  }
  if (action.href) navigate?.(action.href);
}
