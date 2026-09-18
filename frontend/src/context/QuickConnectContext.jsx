import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import QuickConnectModal from '@/components/quickConnect/QuickConnectModal';
import { getQuickConnectSettings } from '@/services/quickConnectService';

const QuickConnectContext = createContext(null);

/**
 * QuickConnectContext — mounts a single QuickConnectModal instance and
 * fetches the org's Quick Connect settings once, so the Topbar button, the
 * Quick Actions menu, the command palette, and the `g q` shortcut all share
 * the same "allowed" check and open the same modal instead of each keeping
 * its own copy of state.
 */
export function QuickConnectProvider({ children }) {
  const [allowed, setAllowed] = useState(false);
  const [open, setOpen] = useState(false);
  const [prefill, setPrefill] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getQuickConnectSettings()
      .then((data) => {
        if (!cancelled) setAllowed(!!data?.allowed);
      })
      .catch(() => {
        if (!cancelled) setAllowed(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // `prefillData` (optional): { host, port, username, authTab } — used by the
  // dashboard's Recent Quick Connects widget to reopen the modal pre-filled
  // for history rows that need a secret re-entered (password / key auth).
  const openQuickConnect = useCallback((prefillData) => {
    setPrefill(prefillData || null);
    setOpen(true);
  }, []);
  const closeQuickConnect = useCallback(() => setOpen(false), []);

  const value = useMemo(
    () => ({ allowed, open, openQuickConnect, closeQuickConnect, prefill }),
    [allowed, open, openQuickConnect, closeQuickConnect, prefill]
  );

  return (
    <QuickConnectContext.Provider value={value}>
      {children}
      <QuickConnectModal open={open} onClose={closeQuickConnect} prefill={prefill} />
    </QuickConnectContext.Provider>
  );
}

export function useQuickConnect() {
  const ctx = useContext(QuickConnectContext);
  if (!ctx) throw new Error('useQuickConnect must be used within a QuickConnectProvider');
  return ctx;
}

export default QuickConnectContext;
