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
 *   /           → focus first [data-global-search] input
 *   g then d    → navigate /dashboard
 *   g then s    → navigate /servers
 *   g then a    → navigate /access-requests
 *   g then c    → navigate /certificates
 *
 * Shortcuts are ignored when an input, textarea, or select is focused.
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

      // / → focus search
      if (e.key === '/') {
        e.preventDefault();
        const searchEl = document.querySelector('[data-global-search]');
        if (searchEl) searchEl.focus();
        return;
      }

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
