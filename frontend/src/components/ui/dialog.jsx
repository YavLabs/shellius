import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import useIsMobile from '@/hooks/useIsMobile';
import {
  SheetHandle,
  useKeyboardInset,
  useSheetDrag,
} from '@/components/mobile/BottomSheet';

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

// Below `md` the dialog opens as a bottom sheet (docs/plans/1.5.1-mobile.md
// §3): pinned to the bottom, 16px rounded top, drag handle, swipe the handle
// or header down to close, lifted above the on-screen keyboard. All of it is
// `max-md:` so desktop is unchanged; Radix keeps the focus trap, Escape and
// outside-click handling.
const SHEET_CONTENT_CLASSES = cn(
  'max-md:inset-x-0 max-md:left-0 max-md:top-auto max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-b-none max-md:rounded-t-2xl max-md:border-b-0 max-md:shadow-2xl',
  'max-md:duration-200 max-md:data-[state=open]:zoom-in-100 max-md:data-[state=closed]:zoom-out-100 max-md:data-[state=open]:slide-in-from-bottom max-md:data-[state=closed]:slide-out-to-bottom',
  // = BottomSheet's SHEET_POSITION_CLASSES, mobile only (literal so
  // Tailwind sees it).
  'max-md:bottom-[var(--sheet-kb,0px)] max-md:max-h-[min(90dvh,calc(var(--sheet-vvh,100dvh)_-_12px))]',
);

const DialogContent = React.forwardRef(
  (
    { className, children, size = 'md', showClose = true, onOpenAutoFocus, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, ...props },
    ref,
  ) => {
    const isMobile = useIsMobile();
    const innerRef = React.useRef(null);
    const [node, setNode] = React.useState(null);
    const closeRef = React.useRef(null);
    const setRefs = React.useCallback(
      (el) => {
        innerRef.current = el;
        setNode(el);
        if (typeof ref === 'function') ref(el);
        else if (ref) ref.current = el;
      },
      [ref],
    );
    const dismiss = React.useCallback(() => closeRef.current?.click(), []);
    const drag = useSheetDrag(innerRef, dismiss, isMobile);
    useKeyboardInset(node, isMobile);
    const chain = (theirs, ours) => (e) => {
      theirs?.(e);
      if (!e.defaultPrevented) ours(e);
    };

    return (
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          ref={setRefs}
          onOpenAutoFocus={onOpenAutoFocus}
          onPointerDown={chain(onPointerDown, drag.onPointerDown)}
          onPointerMove={chain(onPointerMove, drag.onPointerMove)}
          onPointerUp={chain(onPointerUp, drag.onPointerUp)}
          onPointerCancel={chain(onPointerCancel, drag.onPointerCancel)}
          className={cn(
            'sheet-panel fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-full -translate-x-1/2 -translate-y-1/2 flex-col gap-0 overflow-hidden rounded-lg border border-border bg-card shadow-lg duration-150 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
            DIALOG_SIZES[size] || DIALOG_SIZES.md,
            SHEET_CONTENT_CLASSES,
            className
          )}
          {...props}
        >
          <SheetHandle className="md:hidden" />
          {children}
          {showClose && (
            <DialogPrimitive.Close className="absolute right-4 top-3.5 rounded-md p-1 text-muted-foreground opacity-70 ring-offset-background transition-opacity hover:bg-accent hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring max-md:right-1.5 max-md:top-[14px] max-md:inline-flex max-md:h-11 max-md:w-11 max-md:items-center max-md:justify-center max-md:p-0">
              <X className="h-4 w-4 max-md:h-5 max-md:w-5" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          )}
          {/* Swipe-to-close target (works when showClose is off too). */}
          <DialogPrimitive.Close ref={closeRef} className="hidden" tabIndex={-1} aria-hidden="true" />
        </DialogPrimitive.Content>
      </DialogPortal>
    );
  }
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

// Fixed, non-scrolling title/description area — pairs with DialogBody below
// for content that needs its own internal scroll (mirrors Modal.jsx's
// header/body/footer split so long dialogs never let the footer or header
// get pushed off-screen).
const DialogHeader = ({ className, ...props }) => (
  <div
    data-sheet-drag
    className={cn(
      'flex shrink-0 flex-col space-y-1.5 border-b border-border px-5 py-4 pr-11 text-left max-md:touch-none max-md:px-4 max-md:pb-3 max-md:pt-2 max-md:pr-14',
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
  <div className={cn('sheet-body flex-1 overflow-y-auto px-5 py-4 max-md:min-h-0 max-md:overscroll-contain max-md:px-4', className)} {...props} />
);
DialogBody.displayName = 'DialogBody';

const DialogFooter = ({ className, ...props }) => (
  <div
    className={cn(
      // Phones (below md): one wrapping row, buttons fill it (index.css
      // .sheet-footer); md and up: right-aligned as before.
      'sheet-footer flex shrink-0 flex-row flex-wrap gap-2 border-t border-border px-4 py-3 md:flex-nowrap md:justify-end md:gap-0 md:space-x-2 md:px-5',
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
