import { MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { TONE_DOT } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Mobile list building blocks (docs/plans/1.5.1-mobile.md §5). DataTable
 * renders these below `md`; hand-built lists (Audit log, Bulk import, …) use
 * them directly so every list on a phone looks the same.
 */

const stop = (e) => e.stopPropagation();

/** "⋯" menu with a row's remaining actions (same items as the desktop row menu). */
export function CardActionMenu({ actions = [], row, label = 'More actions' }) {
  if (!actions.some((a) => !a.separator)) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-11 w-11 shrink-0 text-muted-foreground" onClick={stop} aria-label={label}>
          <MoreHorizontal className="h-5 w-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {actions.map((action, idx) => {
          if (action.separator) return <DropdownMenuSeparator key={`sep-${idx}`} />;
          const Icon = action.icon;
          const destructive = action.variant === 'destructive';
          return (
            <DropdownMenuItem
              key={action.label}
              onClick={(e) => {
                e.stopPropagation();
                action.onClick(row);
              }}
              className={cn('min-h-11', destructive && 'text-destructive focus:bg-destructive/10 focus:text-destructive')}
            >
              {Icon && <Icon className="mr-2 h-4 w-4" />}
              {action.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A compact pill button for one of the row's primary actions. */
export function CardActionButton({ action, row }) {
  const Icon = action.icon;
  const destructive = action.variant === 'destructive';
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn('h-9 gap-1.5 px-3', destructive && 'text-destructive hover:text-destructive')}
      onClick={(e) => {
        e.stopPropagation();
        action.onClick(row);
      }}
    >
      {Icon && <Icon className="h-4 w-4" />}
      {action.mobileLabel || action.label}
    </Button>
  );
}

/** Meta item: an optional muted label before the value. */
export function CardMeta({ label, children }) {
  if (children === null || children === undefined || children === false || children === '') return null;
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1 text-xs text-muted-foreground">
      {label && <span className="shrink-0">{label}</span>}
      <span className="flex min-w-0 items-center">{children}</span>
    </span>
  );
}

/**
 * Card accents by Badge tone (lib/badgeTones.js): a soft diagonal tint from
 * the top-left corner, a tinted border and the colour of the bottom-left label.
 * Class strings are written out in full so Tailwind keeps them.
 */
const ACCENTS = {
  info: {
    card: 'border-sky-500/25 from-sky-500/[0.13] dark:from-sky-400/[0.12]',
    tag: 'text-sky-700 dark:text-sky-300',
  },
  warning: {
    card: 'border-amber-500/30 from-amber-500/[0.14] dark:from-amber-400/[0.12]',
    tag: 'text-amber-700 dark:text-amber-300',
  },
  danger: {
    card: 'border-rose-500/30 from-rose-500/[0.14] dark:from-rose-400/[0.13]',
    tag: 'text-rose-700 dark:text-rose-300',
  },
  success: {
    card: 'border-emerald-500/25 from-emerald-500/[0.12] dark:from-emerald-400/[0.10]',
    tag: 'text-emerald-700 dark:text-emerald-300',
  },
  accent: {
    card: 'border-violet-500/25 from-violet-500/[0.13] dark:from-violet-400/[0.12]',
    tag: 'text-violet-700 dark:text-violet-300',
  },
  neutral: {
    card: 'from-muted-foreground/[0.08]',
    tag: 'text-muted-foreground',
  },
};

/**
 * MobileCard — one row of a mobile list.
 *
 *   [leading]  title ………………… corner [⋯] [☐]
 *              secondary
 *              meta · meta · meta
 *   ───────────────────────────────────────────
 *   TAG                       [action] [action]
 *
 * The corner controls (a small `corner` value such as a count, the "⋯"
 * menu, the selection checkbox) share the title line without making it
 * taller, so the lines below stay right under the title. `accent` ({ tone, label }) tints the card and puts the
 * label small in the bottom-left corner — used for server environments.
 * The action row sits under a full-width divider, buttons on the right.
 */
export function MobileCard({
  leading,
  title,
  secondary,
  meta = [],
  actions,
  menu,
  corner,
  accent,
  reserveActions = false,
  titleClamp = 1,
  onClick,
  selectable = false,
  selected = false,
  onSelectChange,
  selectLabel = 'Select row',
  className,
  children,
}) {
  const metaItems = (Array.isArray(meta) ? meta : [meta]).filter(
    (m) => m !== null && m !== undefined && m !== false
  );
  const clickable = typeof onClick === 'function';
  const tone = accent ? ACCENTS[accent.tone] || ACCENTS.neutral : null;
  const tag = accent?.label;
  // Lists where any row has actions keep the action row on every card (empty
  // when this row has none) so all cards line up at the same height.
  const hasActionRow = !!actions || reserveActions;
  return (
    <div
      // No role="button": the card holds its own buttons (menu, actions), and
      // nested interactive roles confuse screen readers. Keyboard: Tab + Enter.
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onClick : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                e.preventDefault();
                onClick(e);
              }
            }
          : undefined
      }
      className={cn(
        'relative flex h-full min-w-0 flex-col rounded-lg border border-border bg-card p-3.5 text-sm transition-colors',
        tone && 'bg-gradient-to-br to-transparent to-60%',
        tone?.card,
        clickable &&
          'cursor-pointer active:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'border-primary/50 ring-1 ring-primary/30',
        className
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {leading && <div className="flex shrink-0">{leading}</div>}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            {/* A one-line title is right for a hostname or a port; a finding
                message is a sentence, and truncating it at the first line
                leaves "The firewall allows this port from Anyw…" — every row
                starting the same way, none of them saying which port. Lists
                of sentences ask for `titleClamp: 2`. */}
            <div
              className={cn(
                'min-w-0 flex-1 font-semibold leading-5 text-foreground',
                titleClamp > 1 ? 'line-clamp-2 break-words' : 'truncate'
              )}
            >
              {title}
            </div>
            {(corner || menu || selectable) && (
              // Negative margins: the 44px controls sit on the title line without
              // making it taller, so the next line stays right under the title.
              <div className="-my-3 -mr-2 flex shrink-0 items-center" onClick={stop}>
                {corner && <span className="mr-0.5 flex items-center text-xs text-muted-foreground">{corner}</span>}
                {menu}
                {selectable && (
                  // 44px hit area around the 16px checkbox.
                  <label className="-ml-1 flex h-11 w-10 shrink-0 cursor-pointer items-center justify-center">
                    <Checkbox checked={!!selected} onChange={() => onSelectChange?.(!selected)} aria-label={selectLabel} />
                  </label>
                )}
              </div>
            )}
          </div>
          {secondary && <div className="mt-0.5 min-w-0 truncate text-xs leading-4 text-muted-foreground">{secondary}</div>}
          {metaItems.length > 0 && (
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">{metaItems}</div>
          )}
          {children}
        </div>
      </div>
      {(hasActionRow || tag) && (
        <div
          className={cn(
            'flex min-w-0 items-center gap-2',
            // A full-width divider separates the content from the action row.
            hasActionRow ? '-mx-3.5 mt-3.5 min-h-[49px] border-t border-border px-3.5 pt-3' : 'mt-3'
          )}
        >
          {tag && (
            <span className={cn('shrink-0 text-[10px] font-semibold uppercase leading-none tracking-[0.14em]', tone?.tag)}>
              {tag}
            </span>
          )}
          {actions && (
            // Row controls (e.g. Connect) get the same height as the action buttons.
            <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 [&_button]:h-9" onClick={stop}>
              {actions}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Quiet status for a card's corner: a tone dot and the label (no chip). */
export function CardStatus({ tone = 'neutral', label }) {
  if (!label) return null;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[tone] || TONE_DOT.neutral)} aria-hidden="true" />
      {label}
    </span>
  );
}

/** Leading icon tile (for rows without an avatar); `status` adds a health dot. */
export function CardIcon({ icon: Icon, className, title, status, statusLabel }) {
  return (
    <span
      className={cn('relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background/60 text-muted-foreground', className)}
      title={title}
    >
      {Icon && <Icon className="h-4 w-4" />}
      {status && (
        <span
          className={cn('absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-card', status)}
          role="img"
          aria-label={statusLabel}
          title={statusLabel}
        />
      )}
    </span>
  );
}

/** Card-shaped loading placeholders. */
export function MobileCardSkeleton({ count = 5, withLeading = false }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex gap-3 rounded-lg border border-border bg-card p-3.5">
          {withLeading && <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-muted" />}
          <div className="min-w-0 flex-1 space-y-2">
            <div className={cn('h-4 animate-pulse rounded bg-muted', i % 2 ? 'w-2/3' : 'w-1/2')} />
            <div className={cn('h-3 animate-pulse rounded bg-muted/70', i % 2 ? 'w-1/3' : 'w-2/5')} />
            <div className="flex gap-2 pt-1">
              <div className="h-4 w-14 animate-pulse rounded-full bg-muted/70" />
              <div className="h-4 w-10 animate-pulse rounded-full bg-muted/70" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Empty list state as a card. */
export function MobileEmptyCard({ children }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * Vertical stack of cards. `uniform` makes every card as tall as the tallest
 * one (grid rows of equal height) — for data lists; leave it off where a card
 * can expand in place (Audit log details).
 */
export function MobileCardList({ children, className, uniform = false }) {
  return <div className={cn(uniform ? 'grid auto-rows-fr gap-2' : 'space-y-2', className)}>{children}</div>;
}

export default MobileCard;
