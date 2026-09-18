import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

const CHORD_ROUTES = {
  d: '/dashboard',
  s: '/servers',
  a: '/access-requests',
  c: '/certificates',
};

/**
 * useKeyboardShortcuts
 *
 * Registers global keyboard shortcuts:
 *   g then d    → navigate /dashboard
 *   g then s    → navigate /servers
 *   g then a    → navigate /access-requests
 *   g then c    → navigate /certificates
 *   g then q    → open Quick Connect (registered in
 *                 components/quickConnect/QuickConnectButton.jsx, not here,
 *                 since it opens a modal rather than navigating)
 *
 * NOT handled here (registered by components/command/CommandPalette.jsx,
 * which is mounted once in AppLayout and needs CommandPaletteContext):
 *   ⌘K / Ctrl+K → open the command palette (works even while typing)
 *   /           → open the command palette (only when not typing)
 *
 * Shortcuts below are ignored when an input, textarea, or select is focused.
 */
function useKeyboardShortcuts() {
  const navigate = useNavigate();
  const gPressedAt = useRef(null);

  useEffect(() => {
    function isInputFocused() {
      const tag = document.activeElement?.tagName?.toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || document.activeElement?.isContentEditable;
    }

    function handleKeyDown(e) {
      if (isInputFocused()) return;

      // g chord: wait up to 500ms for second key
      if (e.key === 'g') {
        gPressedAt.current = Date.now();
        return;
      }

      if (gPressedAt.current !== null) {
        const elapsed = Date.now() - gPressedAt.current;
        gPressedAt.current = null;
        if (elapsed <= 500 && CHORD_ROUTES[e.key]) {
          e.preventDefault();
          navigate(CHORD_ROUTES[e.key]);
          return;
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);
}

export default useKeyboardShortcuts;
