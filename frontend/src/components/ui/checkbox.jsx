import * as React from 'react';
import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Checkbox — themed 16px checkbox. Drop-in replacement for a native
 * `<input type="checkbox" checked={...} onChange={...} />`: same props,
 * same `event.target.checked` in onChange, plus an `indeterminate` prop
 * (select-all headers) since the DOM `indeterminate` flag isn't a real HTML
 * attribute.
 *
 * @radix-ui/react-checkbox isn't a dependency here, so this is a styled
 * native input (appearance-none) using Tailwind's built-in `checked:` /
 * `indeterminate:` variants instead of the Radix primitive.
 *
 * `className` is split: margin utilities go to the WRAPPER, everything else
 * to the input. The tick and dash are absolutely positioned overlays centred
 * on the wrapper, so a margin on the input alone slides the box out from
 * under its own tick — a caller writing `<Checkbox className="ml-2" />` got a
 * checkbox whose check sat off to one side of the filled square. Margins are
 * a layout concern and belong to the whole control.
 *
 * The focus ring is driven by local pointer/keyboard tracking rather than
 * CSS `:focus-visible` — browsers intentionally treat checkboxes/radios as
 * "always focus-visible" (unlike buttons/links), so `focus-visible:` classes
 * still ring on a plain mouse click. Tracking mousedown vs focus ourselves
 * keeps the ring for keyboard users only, avoiding a double-border look
 * around an already-filled checked box.
 */
// m-2 / mx-1 / -ml-px / sm:ml-2 … — any margin utility, responsive or
// negative variants included.
const MARGIN_CLASS = /^(?:[\w-]+:)*-?m[trblxy]?-/;

export function splitCheckboxClasses(className) {
  const all = String(className || '').split(/\s+/).filter(Boolean);
  return {
    wrapper: all.filter((c) => MARGIN_CLASS.test(c)).join(' '),
    input: all.filter((c) => !MARGIN_CLASS.test(c)).join(' '),
  };
}

const Checkbox = React.forwardRef(function Checkbox(
  { className, indeterminate = false, onMouseDown, onFocus, onBlur, ...props },
  ref
) {
  const { wrapper: wrapperClass, input: inputClass } = splitCheckboxClasses(className);
  const innerRef = React.useRef(null);
  const usedPointerRef = React.useRef(false);
  const [showRing, setShowRing] = React.useState(false);
  React.useImperativeHandle(ref, () => innerRef.current);

  React.useEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = !!indeterminate;
  }, [indeterminate]);

  return (
    <span
      className={cn(
        'relative inline-flex h-4 w-4 shrink-0 items-center justify-center leading-none',
        wrapperClass
      )}
    >
      <input
        ref={innerRef}
        type="checkbox"
        onMouseDown={(e) => {
          usedPointerRef.current = true;
          onMouseDown?.(e);
        }}
        onFocus={(e) => {
          setShowRing(!usedPointerRef.current);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          usedPointerRef.current = false;
          setShowRing(false);
          onBlur?.(e);
        }}
        className={cn(
          'peer m-0 block h-4 w-4 shrink-0 cursor-pointer appearance-none rounded-[4px] border border-input bg-background align-middle outline-none transition-colors',
          'hover:border-muted-foreground/60',
          'checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary',
          'disabled:cursor-not-allowed disabled:opacity-50',
          showRing && 'ring-2 ring-ring ring-offset-1 ring-offset-background',
          inputClass
        )}
        {...props}
      />
      <Check
        aria-hidden="true"
        className="pointer-events-none absolute h-3 w-3 text-primary-foreground opacity-0 peer-checked:opacity-100"
      />
      <Minus
        aria-hidden="true"
        className="pointer-events-none absolute h-3 w-3 text-primary-foreground opacity-0 peer-indeterminate:opacity-100"
      />
    </span>
  );
});
Checkbox.displayName = 'Checkbox';

export { Checkbox };
export default Checkbox;
