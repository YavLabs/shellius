import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * Modal — renders into a React portal at document.body so it lives outside
 * the parent component's DOM tree. This is critical when the trigger lives
 * inside a clickable container (e.g. a DataTable row with onRowClick): if
 * the modal rendered inline, every click inside it would bubble up through
 * the row and trigger the row click handler, navigating away from the page
 * mid-modal-interaction (Phase 17A bug).
 *
 * Also stops propagation on the inner panel so clicks inside the modal
 * never reach any ancestor handler that may exist on document.body.
 */
function Modal({ open, onClose, title, children, footer, size = 'md' }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  const sizes = {
    sm: 'max-w-sm',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
  };

  const modal = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        className={`relative z-10 w-full ${sizes[size] || sizes.md} max-h-[90vh] overflow-hidden rounded-lg border border-border bg-card shadow-lg flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h3 className="text-base font-semibold text-foreground">{title}</h3>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="border-t border-border px-5 py-3">{footer}</div>
        )}
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

export default Modal;
