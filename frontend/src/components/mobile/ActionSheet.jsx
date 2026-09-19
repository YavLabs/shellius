import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const SWIPE_CLOSE_PX = 80;

/**
 * ActionSheet — a small self-contained bottom sheet listing actions (the
 * bottom navigation's centre button). Rounded top, drag handle, title row
 * with a close button, scrollable body. Closes on backdrop tap, Escape, or
 * a swipe down on the handle / title row.
 *
 * groups: [{ key, label (optional heading), items: [{ key, label, icon, onSelect, emphasis }] }]
 */
function ActionSheet({ open, onClose, title, groups = [] }) {
  const panelRef = useRef(null);
  const startY = useRef(null);
  const dragY = useRef(0);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.activeElement;
    panelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      if (prev && typeof prev.focus === 'function') prev.focus();
    };
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  // The panel follows the finger via a CSS variable (translate-y below).
  const setDrag = (px) => {
    dragY.current = px;
    panelRef.current?.style.setProperty('--sheet-drag', `${px}px`);
    panelRef.current?.classList.toggle('transition-transform', px === 0);
  };
  const onTouchStart = (e) => {
    startY.current = e.touches[0].clientY;
  };
  const onTouchMove = (e) => {
    if (startY.current == null) return;
    setDrag(Math.max(0, e.touches[0].clientY - startY.current));
  };
  const onTouchEnd = () => {
    const closing = dragY.current > SWIPE_CLOSE_PX;
    startY.current = null;
    setDrag(0);
    if (closing) onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-50 md:hidden">
      <div className="absolute inset-0 animate-in fade-in-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'absolute inset-x-0 bottom-0 flex max-h-[90dvh] translate-y-[var(--sheet-drag,0px)] flex-col rounded-t-2xl border-t border-border bg-card pb-[env(safe-area-inset-bottom)] shadow-2xl outline-none',
          'transition-transform animate-in slide-in-from-bottom duration-200'
        )}
      >
        <div className="shrink-0 touch-none" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
          <div className="flex justify-center pb-1 pt-2.5" aria-hidden="true">
            <span className="h-1 w-10 rounded-full bg-muted-foreground/30" />
          </div>
          <div className="flex items-center justify-between px-4 pb-2">
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              className="-mr-2 flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
          {groups.map((group, idx) => (
            <div key={group.key} className={cn(idx > 0 && 'mt-2 border-t border-border pt-2')}>
              {group.label && (
                <p className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {group.label}
                </p>
              )}
              <ul>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.key}>
                      <button
                        type="button"
                        onClick={item.onSelect}
                        className={cn(
                          'flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm transition-colors active:bg-accent hover:bg-accent/60',
                          item.emphasis ? 'font-semibold text-foreground' : 'text-foreground'
                        )}
                      >
                        {Icon && (
                          <span
                            className={cn(
                              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                              item.emphasis
                                ? 'bg-brand-gradient text-[color:var(--brand-on-gradient)]'
                                : 'bg-muted text-muted-foreground'
                            )}
                          >
                            <Icon className="h-4 w-4" aria-hidden="true" />
                          </span>
                        )}
                        <span className="flex-1 truncate">{item.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}

export default ActionSheet;
