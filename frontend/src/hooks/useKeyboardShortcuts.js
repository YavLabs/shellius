import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useQuickConnect } from '@/context/QuickConnectContext';
import { SEQUENCES, isSequenceVisible } from '@/lib/commands';

const SEQUENCE_TIMEOUT_MS = 1000;

/**
 * useKeyboardShortcuts
 *
 * Generic two-key sequence handler ("g" then "d", "c" then "s", ...) driven
 * entirely by the SEQUENCES registry in lib/commands.js — this hook knows
 * nothing about routes itself. Also opens the Keyboard Shortcuts help
 * dialog on "?" (shift+/).
 *
 * Rules:
 *   - No modifier keys (Cmd/Ctrl/Alt) — plain key presses only.
 *   - Ignored while typing in an input, textarea, select, or
 *     contenteditable element.
 *   - The first key must be followed by the second key within
 *     SEQUENCE_TIMEOUT_MS, or the sequence resets.
 *
 * NOT handled here (registered elsewhere, since they need modal state that
 * lives outside this hook):
 *   g q          → Quick Connect (components/quickConnect/QuickConnectButton.jsx)
 *   ⌘K / Ctrl+K  → command palette (components/command/CommandPalette.jsx, works even while typing)
 *   /            → command palette (components/command/CommandPalette.jsx, only when not typing)
 */
function useKeyboardShortcuts() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { allowed: quickConnectAllowed } = useQuickConnect();
  const pending = useRef(null); // { key, at }

  useEffect(() => {
    function isInputFocused() {
      const tag = document.activeElement?.tagName?.toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || document.activeElement?.isContentEditable;
    }

    function hasModifier(e) {
      return e.metaKey || e.ctrlKey || e.altKey;
    }

    function handleKeyDown(e) {
      if (isInputFocused() || hasModifier(e)) return;

      // "?" (shift+/) — open the Keyboard Shortcuts help dialog.
      if (e.key === '?') {
        e.preventDefault();
        pending.current = null;
        window.dispatchEvent(new CustomEvent('shellius:open-shortcuts'));
        return;
      }

      const key = e.key.toLowerCase();
      if (key.length !== 1) return; // ignore Shift/Escape/arrow keys etc.

      // Start (or restart) a sequence on the first key.
      if (!pending.current || Date.now() - pending.current.at > SEQUENCE_TIMEOUT_MS) {
        pending.current = { key, at: Date.now() };
        return;
      }

      const first = pending.current.key;
      const elapsed = Date.now() - pending.current.at;
      pending.current = null;

      if (elapsed > SEQUENCE_TIMEOUT_MS) {
        // Too slow — treat this keypress as a fresh possible first key.
        pending.current = { key, at: Date.now() };
        return;
      }

      const match = SEQUENCES.find((s) => s.keys[0] === first && s.keys[1] === key);
      if (!match || !isSequenceVisible(match, user, quickConnectAllowed)) return;
      if (!match.to) return; // action-only entries (e.g. quick-connect) are handled elsewhere

      e.preventDefault();
      navigate(match.to);
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate, user, quickConnectAllowed]);
}

export default useKeyboardShortcuts;
