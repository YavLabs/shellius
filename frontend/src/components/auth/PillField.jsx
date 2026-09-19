import { forwardRef } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * PillField — sign-in field (app input radius) with an inline primary
 * (brand gradient) icon-only submit button
 * (the field's form submits on Enter or on the arrow). `trailing` renders
 * extra controls (e.g. show-password) left of the arrow.
 */
const PillField = forwardRef(function PillField(
  { className, busy = false, disabled = false, submitLabel = 'Continue', trailing, ...props },
  ref
) {
  return (
    <div
      className={cn(
        'group relative flex h-12 w-full items-center rounded-[calc(var(--radius)-2px)] border border-transparent bg-foreground/[0.035] pl-4 pr-1.5 dark:bg-foreground/[0.05] transition-colors',
        'focus-within:border-foreground/15 focus-within:bg-foreground/[0.07] hover:bg-foreground/[0.06]',
        className
      )}
    >
      <input
        ref={ref}
        disabled={disabled}
        className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
        {...props}
      />
      {trailing}
      <button
        type="submit"
        disabled={disabled || busy}
        aria-label={submitLabel}
        title={submitLabel}
        className="bg-brand-gradient ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-[7px] text-[color:var(--brand-on-gradient)] shadow-sm transition-[filter,opacity] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 disabled:saturate-50"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
      </button>
    </div>
  );
});

export default PillField;
