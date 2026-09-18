import { useState, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import Footer from './Footer';
import CommandPalette from '@/components/command/CommandPalette';
import ShortcutsDialog from '@/components/command/ShortcutsDialog';
import { CommandPaletteProvider } from '@/context/CommandPaletteContext';
import { QuickConnectProvider } from '@/context/QuickConnectContext';
import { TerminalWorkspaceProvider } from '@/context/TerminalWorkspaceContext';
import useKeyboardShortcuts from '@/hooks/useKeyboardShortcuts';
import useDocumentTitle from '@/hooks/useDocumentTitle';
import { useAuth } from '@/context/AuthContext';

/**
 * GlobalShortcuts — mounts useKeyboardShortcuts() as a descendant of
 * QuickConnectProvider so it can read Quick Connect's "allowed" state (the
 * hook needs it to gate the "g q" sequence's visibility in help/menus).
 * Renders nothing.
 */
function GlobalShortcuts() {
  useKeyboardShortcuts();
  return null;
}

function AppLayout() {
  useDocumentTitle();
  const location = useLocation();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => {
    const open = () => setShortcutsOpen(true);
    window.addEventListener('shellius:open-shortcuts', open);
    return () => window.removeEventListener('shellius:open-shortcuts', open);
  }, []);

  // Both the workspace (/terminals) and the standalone full-screen terminal
  // window (/terminal) own their full height directly (header row + a
  // flex-1 min-h-0 xterm pane) — no page scroll, so they need the
  // non-scrolling, min-h-0-constrained `main` too (see the min-h-0 comment
  // below for why this matters).
  const isTerminalsRoute = location.pathname === '/terminals' || location.pathname === '/terminal';
  // Keyed by user: a different sign-in gets a fresh workspace (own tabs, own storage).
  const { user } = useAuth();

  return (
    // TerminalWorkspaceProvider must be the outermost of these two:
    // QuickConnectProvider renders <QuickConnectModal> as a sibling of its
    // own `children` (not inside them), and QuickConnectModal calls
    // useTerminalWorkspace() to open tabs — it only has TerminalWorkspace
    // context available if that provider is an ancestor of QuickConnectProvider
    // itself, not just of its children.
    <TerminalWorkspaceProvider key={user?.id || 'anon'}>
      <QuickConnectProvider>
        <CommandPaletteProvider>
          <GlobalShortcuts />
          <div className="flex h-screen overflow-hidden bg-background text-foreground">
            <Sidebar />
            <div className="flex flex-1 flex-col overflow-hidden min-w-0">
              <Topbar />
              {/* /terminals owns the full available height (no page scroll,
                  no footer) so the tab bar + panes fill the viewport. */}
              {isTerminalsRoute ? (
                // min-h-0 is load-bearing: without it this flex-1 column
                // child's default min-height:auto lets its content (the
                // xterm pane, sized by FitAddon) push it taller than the
                // viewport, clipping the last line/cursor with no way to
                // scroll to it. See docs/terminal-workspace.md.
                <main className="min-h-0 flex-1 overflow-hidden bg-muted/30">
                  <Outlet />
                </main>
              ) : (
                <main className="flex-1 overflow-y-auto overflow-x-hidden bg-muted/30">
                  <div className="min-h-[calc(100%-3rem)]">
                    <Outlet />
                  </div>
                  <Footer />
                </main>
              )}
            </div>
          </div>

          {/* Mounted once so ⌘K / Ctrl+K / "/" work from any authenticated page */}
          <CommandPalette />
          <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
        </CommandPaletteProvider>
      </QuickConnectProvider>
    </TerminalWorkspaceProvider>
  );
}

export default AppLayout;
