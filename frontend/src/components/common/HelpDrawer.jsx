import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, HelpCircle } from 'lucide-react';
import { getHelp } from '@/config/helpContent';

/**
 * HelpDrawer — slide-in panel from the right edge of the viewport.
 * Renders into a React portal so it lives outside the parent's DOM
 * tree (same reason as Modal — see Phase 17A bug). Click the backdrop
 * or press Escape to close.
 */
function HelpDrawer({ open, onClose, helpKey }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  const help = getHelp(helpKey);

  const drawer = (
    <div
      className="fixed inset-0 z-50"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <aside
        className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="flex items-center gap-2">
            <HelpCircle className="h-4 w-4 text-primary" />
            <h2 className="text-base font-semibold text-foreground">
              {help?.title || 'Help'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Close help"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {!help ? (
            <p className="text-sm text-muted-foreground">
              No help content available for this page yet.
            </p>
          ) : (
            <div className="space-y-5">
              {help.summary && (
                <p className="text-sm leading-relaxed text-foreground/90">
                  {help.summary}
                </p>
              )}
              {help.sections?.map((section, idx) => (
                <div key={idx}>
                  <h3 className="mb-1 text-sm font-semibold text-foreground">
                    {section.heading}
                  </h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {section.body}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

        <footer className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
          Press <kbd className="rounded border border-border bg-muted px-1 text-[10px]">Esc</kbd> to close
        </footer>
      </aside>
    </div>
  );

  return createPortal(drawer, document.body);
}

export default HelpDrawer;
