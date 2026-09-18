import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useAuth } from '@/context/AuthContext';
import { useQuickConnect } from '@/context/QuickConnectContext';
import { NAV_SEQUENCES, CREATE_SEQUENCES, GENERAL_SHORTCUTS, isSequenceVisible } from '@/lib/commands';

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent || '');
const MOD_LABEL = isMac ? '⌘' : 'Ctrl';

function Kbd({ children }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}

function ShortcutRow({ label, keys }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-foreground">{label}</span>
      <span className="flex shrink-0 items-center gap-1">
        {keys.map((k, i) => (
          <span key={i} className="flex items-center gap-1">
            <Kbd>{k === 'Mod' ? MOD_LABEL : k}</Kbd>
          </span>
        ))}
      </span>
    </div>
  );
}

/**
 * ShortcutsDialog — the Keyboard Shortcuts help dialog, opened with "?"
 * (hooks/useKeyboardShortcuts.js) or via the "Keyboard shortcuts" command
 * palette / Quick Actions entry (both dispatch the
 * "shellius:open-shortcuts" window event, which AppLayout listens for).
 */
function ShortcutsDialog({ open, onClose }) {
  const { user } = useAuth();
  const { allowed: quickConnectAllowed } = useQuickConnect();

  const nav = NAV_SEQUENCES.filter((s) => isSequenceVisible(s, user, quickConnectAllowed));
  const create = CREATE_SEQUENCES.filter((s) => isSequenceVisible(s, user, quickConnectAllowed));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose?.()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription>
          Press the first key, then the second within a second. Shortcuts are disabled while
          typing in a field.
        </DialogDescription>

        <div className="mt-2 space-y-5">
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              General
            </h3>
            <div className="divide-y divide-border">
              {GENERAL_SHORTCUTS.map((s) => (
                <ShortcutRow key={s.label} label={s.label} keys={s.keys} />
              ))}
            </div>
          </section>

          {nav.length > 0 && (
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Navigation
              </h3>
              <div className="divide-y divide-border">
                {nav.map((s) => (
                  <ShortcutRow key={s.label} label={s.label} keys={s.keys} />
                ))}
              </div>
            </section>
          )}

          {create.length > 0 && (
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Create
              </h3>
              <div className="divide-y divide-border">
                {create.map((s) => (
                  <ShortcutRow key={s.label} label={s.label} keys={s.keys} />
                ))}
              </div>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default ShortcutsDialog;
