import { useEffect, useId } from 'react';
import { cn } from '@/lib/utils';
import useIsMobile from '@/hooks/useIsMobile';
import BottomSheet from '@/components/mobile/BottomSheet';

function ConfirmDialog({
  open,
  title = 'Confirm',
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  variant = 'default',
}) {
  const isMobile = useIsMobile();
  const titleId = useId();
  const messageId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const cancelButton = (
    <button
      onClick={onCancel}
      className="h-9 rounded-md border border-input bg-background px-4 text-sm font-medium text-foreground hover:bg-accent"
    >
      {cancelLabel}
    </button>
  );
  const confirmButton = (
    <button
      onClick={onConfirm}
      className={cn(
        'h-9 rounded-md px-4 text-sm font-medium transition-colors',
        variant === 'destructive'
          ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
          : 'bg-primary text-primary-foreground hover:bg-primary/90'
      )}
    >
      {confirmLabel}
    </button>
  );

  // Phones: a bottom sheet (docs/plans/1.5.1-mobile.md §3).
  if (isMobile) {
    return (
      <BottomSheet
        open={open}
        onClose={onCancel}
        title={title}
        role="alertdialog"
        describedBy={message ? messageId : undefined}
        closeOnEscape={false}
        footer={
          <div className="flex justify-end gap-2">
            {cancelButton}
            {confirmButton}
          </div>
        }
      >
        {message && <p id={messageId} className="text-sm text-muted-foreground">{message}</p>}
      </BottomSheet>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onCancel}
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={message ? messageId : undefined}
        className="relative z-10 w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-lg"
      >
        <h3 id={titleId} className="text-lg font-semibold text-foreground">{title}</h3>
        {message && <p id={messageId} className="mt-2 text-sm text-muted-foreground">{message}</p>}
        <div className="mt-6 flex justify-end gap-2">
          {cancelButton}
          {confirmButton}
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;
