import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * FilterSheet — the bottom sheet a mobile list's "Filters" button opens.
 * Minimal and self-contained on purpose; it will be folded into the shared
 * BottomSheet (components/mobile/BottomSheet.jsx) once that lands.
 *
 * The filter controls are the page's own `filters` slot, stacked full width.
 * Filters apply as they change (same as desktop), so "Done" just closes.
 */
export default function FilterSheet({ open, onClose, title = 'Filters', activeCount = 0, onReset, children }) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose?.();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end"
      // Keep clicks inside the sheet from reaching a clickable ancestor.
      onClick={(e) => e.stopPropagation()}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex max-h-[90dvh] w-full flex-col rounded-t-2xl border-t border-border bg-card shadow-2xl outline-none animate-in slide-in-from-bottom duration-200"
      >
        <div className="flex justify-center pt-2">
          <span className="h-1 w-10 rounded-full bg-muted-foreground/30" aria-hidden="true" />
        </div>
        <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-1">
          <h2 className="text-base font-semibold text-foreground">
            {title}
            {activeCount > 0 && (
              <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
                {activeCount}
              </span>
            )}
          </h2>
          <Button variant="ghost" size="icon" className="h-11 w-11" onClick={onClose} aria-label="Close filters">
            <X className="h-5 w-5" />
          </Button>
        </div>
        {/* Controls stack full width; the page's fixed desktop widths are overridden. */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4 [&>*]:!w-full [&>*]:!max-w-none">
          {children}
        </div>
        <div className="flex gap-2 border-t border-border px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          {onReset && (
            <Button variant="outline" className="h-11 flex-1" onClick={onReset} disabled={activeCount === 0}>
              Reset
            </Button>
          )}
          <Button className="h-11 flex-1" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
