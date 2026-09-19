import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { dragOffset, shouldDismiss, keyboardInset } from './sheetGesture';

/**
 * Mobile bottom sheet (docs/plans/1.5.1-mobile.md §3–4).
 *
 * Chrome: 16px rounded top, drag handle, title row with a close button, a
 * scrollable body and an optional sticky footer. Max 90dvh, safe-area aware,
 * and lifted above the on-screen keyboard via `visualViewport`. Swipe down on
 * the handle / title row, tap the backdrop or press Escape to close — each
 * just calls `onClose`, so a caller that refuses to close while a request is
 * running keeps doing so.
 *
 * Modal, ConfirmDialog and HelpDrawer render this on phones; ui/dialog.jsx
 * (Radix) reuses the hooks and classes below so its own focus trap stays.
 *
 * Buttons inside a form body can join the sticky footer by marking their row
 * with `data-sheet-footer` (styles in index.css, mobile only). Inputs inside
 * a sheet are 44px tall with a 16px font so iOS doesn't zoom.
 */

/**
 * Stops clicks inside an overlay reaching ancestors (e.g. a clickable table
 * row). Elements marked `data-modal-passthrough` are exempt — see Modal.jsx.
 */
export function stopUnlessPassthrough(e) {
  if (e.target.closest?.('[data-modal-passthrough]')) return;
  e.stopPropagation();
}

// Sheet positioning shared with ui/dialog.jsx: bottom edge follows the
// keyboard (--sheet-kb), height capped at 90dvh and at the visible viewport.
export const SHEET_POSITION_CLASSES =
  'bottom-[var(--sheet-kb,0px)] max-h-[min(90dvh,calc(var(--sheet-vvh,100dvh)_-_12px))]';

/** The small grab bar at the top of every sheet. */
export function SheetHandle({ className }) {
  return (
    <div data-sheet-drag className={cn('flex h-5 shrink-0 touch-none items-center justify-center', className)} aria-hidden="true">
      <span className="h-1 w-10 rounded-full bg-muted-foreground/30" />
    </div>
  );
}

/**
 * Swipe-to-close. Returns pointer handlers for the sheet panel; a drag only
 * starts on an element marked `data-sheet-drag` (handle, title row) and not
 * on a control inside it.
 */
export function useSheetDrag(panelRef, onDismiss, enabled = true) {
  const drag = useRef(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  const reset = (el) => {
    el.style.transition = 'transform 180ms ease-out';
    el.style.transform = '';
    window.setTimeout(() => { el.style.transition = ''; }, 200);
  };

  const onPointerDown = useCallback((e) => {
    if (!enabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = e.target;
    if (!target.closest?.('[data-sheet-drag]')) return;
    if (target.closest('button, a, input, textarea, select, [role="combobox"]')) return;
    const el = panelRef.current;
    if (!el) return;
    drag.current = { id: e.pointerId, y: e.clientY, t: performance.now(), dy: 0, height: el.offsetHeight };
    el.style.transition = 'none';
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, [enabled, panelRef]);

  const onPointerMove = useCallback((e) => {
    const d = drag.current;
    const el = panelRef.current;
    if (!d || d.id !== e.pointerId || !el) return;
    d.dy = e.clientY - d.y;
    el.style.transform = `translateY(${dragOffset(d.dy)}px)`;
  }, [panelRef]);

  const end = useCallback((e, cancelled) => {
    const d = drag.current;
    const el = panelRef.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (!el) return;
    if (!cancelled && shouldDismiss({ dy: d.dy, dt: performance.now() - d.t, height: d.height })) {
      dismissRef.current?.();
      // Still here a moment later (the caller refused, e.g. a request is
      // running, or a Radix exit animation finished)? Snap back.
      window.setTimeout(() => {
        if (el.isConnected && el.dataset.state !== 'closed') reset(el);
      }, 250);
      return;
    }
    reset(el);
  }, [panelRef]);

  const onPointerUp = useCallback((e) => end(e, false), [end]);
  const onPointerCancel = useCallback((e) => end(e, true), [end]);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}

/**
 * Keeps a `position: fixed; bottom: 0` sheet above the on-screen keyboard:
 * writes --sheet-kb (keyboard height) and --sheet-vvh (visible height) onto
 * the panel element and keeps the focused field in view. Takes the element
 * itself (from a callback ref) so it re-runs when the panel mounts.
 */
export function useKeyboardInset(el, active) {
  useEffect(() => {
    if (!active || !el || typeof window === 'undefined') return undefined;
    const vv = window.visualViewport;
    if (!vv) return undefined;
    let last = -1;
    const update = () => {
      const inset = keyboardInset({ innerHeight: window.innerHeight, viewportHeight: vv.height, offsetTop: vv.offsetTop });
      el.style.setProperty('--sheet-kb', `${inset}px`);
      el.style.setProperty('--sheet-vvh', `${Math.round(vv.height)}px`);
      if (inset > 0 && inset !== last) {
        const focused = document.activeElement;
        if (focused && el.contains(focused)) {
          window.requestAnimationFrame(() => focused.scrollIntoView?.({ block: 'nearest' }));
        }
      }
      last = inset;
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      el.style.removeProperty('--sheet-kb');
      el.style.removeProperty('--sheet-vvh');
    };
  }, [el, active]);
}

// Body scroll lock shared by every open sheet (nested sheets count up).
let lockCount = 0;
let savedOverflow = '';
function useScrollLock(active) {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return undefined;
    if (lockCount === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    lockCount += 1;
    return () => {
      lockCount -= 1;
      if (lockCount === 0) document.body.style.overflow = savedOverflow;
    };
  }, [active]);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Initial focus into the sheet, focus return on close, Tab stays inside. */
function useSheetFocus(panelRef, active) {
  // Remember what had focus *before* the sheet mounted — by the time effects
  // run, an autoFocus field inside the sheet already has it.
  const previousRef = useRef(null);
  if (active && previousRef.current === null && typeof document !== 'undefined') {
    previousRef.current = document.activeElement || false;
  }
  if (!active) previousRef.current = null;

  useEffect(() => {
    if (!active) return undefined;
    const previous = previousRef.current;
    const el = panelRef.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    return () => {
      if (previous && previous.isConnected && typeof previous.focus === 'function') {
        previous.focus({ preventScroll: true });
      }
    };
  }, [panelRef, active]);

  return useCallback((e) => {
    if (e.key !== 'Tab') return;
    const el = panelRef.current;
    if (!el) return;
    const items = [...el.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, [panelRef]);
}

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose — backdrop, swipe, close button, Escape
 * @param {React.ReactNode} props.title
 * @param {React.ReactNode} [props.icon] — shown before the title
 * @param {React.ReactNode} [props.footer] — sticky action row
 * @param {boolean} [props.closeOnEscape=true] — pass false when the caller
 *   already handles Escape itself
 * @param {string} [props.closeLabel='Close']
 * @param {string} [props.role='dialog'] — 'alertdialog' for confirmations
 * @param {string} [props.describedBy] — id of the element describing it
 * @param {string} [props.bodyClassName]
 */
function BottomSheet({
  open,
  onClose,
  title,
  icon,
  children,
  footer,
  closeOnEscape = true,
  closeLabel = 'Close',
  role = 'dialog',
  describedBy,
  className,
  bodyClassName,
}) {
  const panelRef = useRef(null);
  const [panelEl, setPanelEl] = useState(null);
  const setPanel = useCallback((node) => {
    panelRef.current = node;
    setPanelEl(node);
  }, []);
  const titleId = useId();
  const drag = useSheetDrag(panelRef, onClose, open);
  useKeyboardInset(panelEl, open);
  useScrollLock(open);
  const trapTab = useSheetFocus(panelRef, open);

  useEffect(() => {
    if (!open || !closeOnEscape) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeOnEscape, onClose]);

  if (!open || typeof document === 'undefined') return null;

  const hasBody = children !== null && children !== undefined && children !== false && children !== '';
  const sheet = (
    <div
      className="fixed inset-0 z-50"
      onClick={stopUnlessPassthrough}
      onMouseDown={stopUnlessPassthrough}
    >
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-in fade-in-0 duration-200"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={setPanel}
        role={role}
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={trapTab}
        {...drag}
        className={cn(
          'sheet-panel absolute inset-x-0 flex flex-col overflow-hidden rounded-t-2xl border border-b-0 border-border bg-card text-card-foreground shadow-2xl outline-none focus-visible:outline-0 animate-in slide-in-from-bottom duration-200',
          SHEET_POSITION_CLASSES,
          className,
        )}
      >
        <div data-sheet-drag className="shrink-0 touch-none border-b border-border">
          <SheetHandle />
          <div data-sheet-drag className="flex min-h-11 items-center gap-2 pb-1.5 pl-4 pr-1.5">
            {icon && <span className="flex shrink-0 items-center">{icon}</span>}
            <h2 id={titleId} className="line-clamp-2 min-w-0 flex-1 break-words text-base font-semibold text-foreground">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={closeLabel}
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
        {hasBody && (
          <div className={cn('sheet-body min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4', !footer && 'sheet-body-last', bodyClassName)}>
            {children}
          </div>
        )}
        {footer && <div className="sheet-footer shrink-0 border-t border-border px-4 pt-3">{footer}</div>}
      </div>
    </div>
  );

  return createPortal(sheet, document.body);
}

export default BottomSheet;
