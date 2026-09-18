import { createContext, useContext, useState, useCallback, useMemo } from 'react';

const CommandPaletteContext = createContext(null);

/**
 * CommandPaletteContext — lets any component (Topbar search trigger, Quick
 * Actions menu, keyboard shortcuts) open the command palette without prop
 * drilling. The palette itself (components/command/CommandPalette.jsx) is
 * mounted once in AppLayout and reads `open` from here.
 */
export function CommandPaletteProvider({ children }) {
  const [open, setOpen] = useState(false);

  const openPalette = useCallback(() => setOpen(true), []);
  const closePalette = useCallback(() => setOpen(false), []);
  const togglePalette = useCallback(() => setOpen((prev) => !prev), []);

  const value = useMemo(
    () => ({ open, setOpen, openPalette, closePalette, togglePalette }),
    [open, openPalette, closePalette, togglePalette]
  );

  return <CommandPaletteContext.Provider value={value}>{children}</CommandPaletteContext.Provider>;
}

export function useCommandPalette() {
  const ctx = useContext(CommandPaletteContext);
  if (!ctx) throw new Error('useCommandPalette must be used within a CommandPaletteProvider');
  return ctx;
}

export default CommandPaletteContext;
