import { MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
        <Button variant="ghost" size="icon" className="-mr-2 -mt-1 h-11 w-11 shrink-0" onClick={stop} aria-label={label}>
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

/** A compact button for one of the row's primary actions. */
export function CardActionButton({ action, row }) {
  const Icon = action.icon;
  const destructive = action.variant === 'destructive';
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn('h-10 gap-1.5 px-3', destructive && 'text-destructive hover:text-destructive')}
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

/** Meta chip wrapper: an optional muted label before the value. */
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
 * MobileCard — one row of a mobile list.
 *
 *   [☐] [leading]  title ……………………… [⋯]
 *                  secondary
 *                  meta · meta · meta
 *                  [primary] [primary] [extra]
 */
export function MobileCard({
  leading,
  title,
  secondary,
  meta = [],
  actions,
  menu,
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
  return (
    <div
      role={clickable ? 'button' : undefined}
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
        'relative flex min-w-0 gap-3 rounded-lg border border-border bg-card px-3 py-3 text-sm transition-colors',
        clickable &&
          'cursor-pointer active:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'border-primary/40 bg-primary/5',
        className
      )}
    >
      {selectable && (
        // 44px hit area around the 16px checkbox.
        <label
          className="-my-3 -ml-3 flex w-11 shrink-0 cursor-pointer items-start justify-center pt-[1.1rem]"
          onClick={stop}
        >
          <Checkbox checked={!!selected} onChange={() => onSelectChange?.(!selected)} aria-label={selectLabel} />
        </label>
      )}
      {leading && <div className="flex shrink-0 items-start pt-0.5">{leading}</div>}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1 break-words font-medium leading-snug text-foreground">{title}</div>
          {menu && <div onClick={stop}>{menu}</div>}
        </div>
        {secondary && <div className="mt-0.5 min-w-0 break-words text-xs text-muted-foreground">{secondary}</div>}
        {metaItems.length > 0 && (
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">{metaItems}</div>
        )}
        {children}
        {actions && (
          <div className="mt-3 flex flex-wrap items-center gap-2" onClick={stop}>
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}

/** Card-shaped loading placeholders. */
export function MobileCardSkeleton({ count = 5, withLeading = false }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex gap-3 rounded-lg border border-border bg-card px-3 py-3">
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

/** Vertical stack of cards. */
export function MobileCardList({ children, className }) {
  return <div className={cn('space-y-2', className)}>{children}</div>;
}

export default MobileCard;
