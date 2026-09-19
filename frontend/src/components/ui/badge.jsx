import { X } from 'lucide-react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Badge — the single chip/pill component used everywhere in the app
 * (environment, status, policy effect, auth type, role, source, ...).
 *
 * Fixed geometry for every chip so nothing drifts across pages:
 *   inline-flex items-center gap-1 rounded-full border px-2 py-0.5
 *   text-[11px] font-medium leading-4 whitespace-nowrap
 *
 * Props:
 *   tone       'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent'
 *              (default 'neutral')
 *   variant    'solid' (tinted background, default) | 'outline' (transparent
 *              background, tone-colored border + text)
 *   uppercase  renders the label as an uppercase tracked code (used for
 *              environment badges: DEV / STAGING / PROD / DEMO). Geometry is
 *              unchanged — only casing/tracking.
 *   dot        renders a small leading status dot in the tone color instead
 *              of/alongside an icon.
 *   icon       optional lucide icon component rendered before the label.
 */

const TONE_SOLID = {
  neutral: 'border-border bg-muted text-muted-foreground',
  success: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  warning: 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  danger: 'border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-400',
  info: 'border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-400',
  accent: 'border-violet-500/20 bg-violet-500/10 text-violet-700 dark:text-violet-400',
};

const TONE_OUTLINE = {
  neutral: 'border-border bg-transparent text-muted-foreground',
  success: 'border-emerald-500/40 bg-transparent text-emerald-700 dark:text-emerald-400',
  warning: 'border-amber-500/40 bg-transparent text-amber-700 dark:text-amber-400',
  danger: 'border-red-500/40 bg-transparent text-red-700 dark:text-red-400',
  info: 'border-blue-500/40 bg-transparent text-blue-700 dark:text-blue-400',
  accent: 'border-violet-500/40 bg-transparent text-violet-700 dark:text-violet-400',
};

export const TONE_DOT = {
  neutral: 'bg-muted-foreground/60',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
  info: 'bg-blue-500',
  accent: 'bg-violet-500',
};

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: '',
        success: '',
        warning: '',
        danger: '',
        info: '',
        accent: '',
      },
      variant: {
        solid: '',
        outline: '',
      },
    },
    defaultVariants: {
      tone: 'neutral',
      variant: 'solid',
    },
  },
);

function Badge({
  className,
  tone = 'neutral',
  variant = 'solid',
  uppercase = false,
  dot = false,
  icon: Icon,
  // Removable tag chips (labels, subjects, domains…): renders a small ×
  // button after the label. `removeLabel` is its accessible name.
  onRemove,
  removeLabel = 'Remove',
  children,
  // Legacy shadcn `variant` values (default/secondary/destructive/outline)
  // are mapped to tone/variant below for backwards compatibility with any
  // stray callers still passing the old API.
  ...props
}) {
  const toneClasses = (variant === 'outline' ? TONE_OUTLINE : TONE_SOLID)[tone] || TONE_SOLID.neutral;

  return (
    <span
      className={cn(
        badgeVariants({ tone, variant }),
        toneClasses,
        uppercase && 'uppercase tracking-wide',
        className,
      )}
      {...props}
    >
      {dot && <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[tone] || TONE_DOT.neutral)} />}
      {Icon && <Icon className="h-3 w-3 shrink-0" />}
      {children}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className="-mr-0.5 ml-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full opacity-60 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-current"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

export { Badge, badgeVariants };
