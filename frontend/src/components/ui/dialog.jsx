import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

// Keep in sync with components/shared/Modal.jsx's `sizes` map — the two
// modal primitives share one visual language.
const DIALOG_SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-3xl',
};

const DialogContent = React.forwardRef(
  ({ className, children, size = 'md', showClose = true, onOpenAutoFocus, ...props }, ref) => (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        onOpenAutoFocus={onOpenAutoFocus}
        className={cn(
          'fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-full -translate-x-1/2 -translate-y-1/2 flex-col gap-0 overflow-hidden rounded-lg border border-border bg-card shadow-lg duration-150 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          DIALOG_SIZES[size] || DIALOG_SIZES.md,
          className
        )}
        {...props}
      >
        {children}
        {showClose && (
          <DialogPrimitive.Close className="absolute right-4 top-3.5 rounded-md p-1 text-muted-foreground opacity-70 ring-offset-background transition-opacity hover:bg-accent hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

// Fixed, non-scrolling title/description area — pairs with DialogBody below
// for content that needs its own internal scroll (mirrors Modal.jsx's
// header/body/footer split so long dialogs never let the footer or header
// get pushed off-screen).
const DialogHeader = ({ className, ...props }) => (
  <div
    className={cn(
      'flex shrink-0 flex-col space-y-1.5 border-b border-border px-5 py-4 pr-11 text-left',
      className
    )}
    {...props}
  />
);
DialogHeader.displayName = 'DialogHeader';

// Scrollable body — wrap the main dialog content in this when the dialog can
// grow taller than the viewport, so the header/footer stay put and only the
// body scrolls (matches Modal.jsx's `overflow-y-auto px-5 py-4` body).
const DialogBody = ({ className, ...props }) => (
  <div className={cn('flex-1 overflow-y-auto px-5 py-4', className)} {...props} />
);
DialogBody.displayName = 'DialogBody';

const DialogFooter = ({ className, ...props }) => (
  <div
    className={cn(
      'flex shrink-0 flex-col-reverse border-t border-border px-5 py-3 sm:flex-row sm:justify-end sm:space-x-2',
      className
    )}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

const DialogTitle = React.forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-base font-semibold leading-none tracking-tight text-foreground', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
