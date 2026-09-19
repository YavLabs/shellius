import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';

/**
 * Page actions for the phone "+" button (docs/plans/1.5.1-mobile.md §1–2).
 *
 * On phones a page header doesn't draw its primary (create) action — it
 * registers it here instead, and the bottom navigation's "+" sheet lists it
 * first ("On this page"), above Quick connect and the global quick actions.
 * Headers register while mounted; nested headers (Administration → Users)
 * each add theirs, outer first.
 */
const PageActionsContext = createContext(null);

export function PageActionsProvider({ children }) {
  const [entries, setEntries] = useState([]); // [{ id, actions }]

  const register = useCallback((id, actions) => {
    setEntries((prev) => {
      const next = prev.filter((e) => e.id !== id);
      if (actions.length > 0) next.push({ id, actions });
      return next;
    });
  }, []);
  const unregister = useCallback((id) => setEntries((prev) => prev.filter((e) => e.id !== id)), []);

  const value = useMemo(
    () => ({ actions: entries.flatMap((e) => e.actions), register, unregister }),
    [entries, register, unregister]
  );
  return <PageActionsContext.Provider value={value}>{children}</PageActionsContext.Provider>;
}

/** The actions registered by the pages on screen (empty outside the provider). */
export function usePageActions() {
  return useContext(PageActionsContext)?.actions || [];
}

/**
 * Registers `actions` ([{ key, label, icon, onClick, disabled }]) while
 * `enabled`. Returns true when a provider took them — the caller then
 * doesn't render them itself. Handlers are read through a ref, so a page
 * re-rendering with new closures doesn't re-register.
 */
export function useRegisterPageActions(actions, enabled = true) {
  const ctx = useContext(PageActionsContext);
  const id = useId();
  const latest = useRef(actions);
  latest.current = actions;
  const active = !!ctx && enabled;
  const signature = active ? actions.map((a) => `${a.key}|${a.label}|${a.disabled ? 1 : 0}`).join(';') : '';
  const register = ctx?.register;
  const unregister = ctx?.unregister;

  useEffect(() => {
    if (!active) return undefined;
    register(
      id,
      latest.current.map((a) => ({
        key: `${id}-${a.key}`,
        label: a.label,
        icon: a.icon,
        disabled: !!a.disabled,
        run: () => latest.current.find((x) => x.key === a.key)?.onClick?.(),
      }))
    );
    return () => unregister(id);
    // signature covers the fields that change what the sheet shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, signature, id, register, unregister]);

  return active;
}
