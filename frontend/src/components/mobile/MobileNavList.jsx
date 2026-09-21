import { Link } from 'react-router-dom';
import { ChevronRight, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Grouped link lists for the phone hubs (Connect, Activity) and the More
 * sheet — the same rows as the Administration section list: brand-tinted
 * icon tile, label, one-line description, an optional count and a chevron.
 */

/** A heading + a card of rows. */
export function NavGroup({ label, children, className }) {
  return (
    <section className={className}>
      {label && (
        <h2 className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</h2>
      )}
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">{children}</ul>
    </section>
  );
}

/** Count pill at the end of a row (hidden at 0). */
function RowCount({ count, tone = 'neutral' }) {
  if (!count) return null;
  return (
    <span
      className={cn(
        'flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums',
        tone === 'attention' && 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
        tone === 'live' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
        tone === 'neutral' && 'bg-muted text-muted-foreground'
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

/**
 * One row: a link (`to`) or a button (`onClick`).
 * @param {{ icon, label, description?, to?, onClick?, count?, countTone?, destructive? }} props
 */
export function NavRow({ icon: Icon, label, description, to, onClick, count, countTone, destructive = false, trailing }) {
  const body = (
    <>
      <span
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
          destructive ? 'bg-destructive/10 text-destructive' : 'bg-[hsl(var(--brand)/0.12)] text-primary'
        )}
      >
        {Icon && <Icon className="h-[18px] w-[18px]" aria-hidden="true" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-sm font-medium', destructive ? 'text-destructive' : 'text-foreground')}>
          {label}
        </span>
        {description && <span className="block truncate text-xs text-muted-foreground">{description}</span>}
      </span>
      <RowCount count={count} tone={countTone} />
      {trailing}
      {!destructive && !trailing && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden="true" />}
    </>
  );
  const cls =
    'flex min-h-[3.75rem] w-full items-center gap-3 px-3 py-2.5 text-left transition-colors active:bg-accent hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring';
  return (
    <li>
      {to ? (
        <Link to={to} onClick={onClick} className={cls}>
          {body}
        </Link>
      ) : (
        <button type="button" onClick={onClick} className={cls}>
          {body}
        </button>
      )}
    </li>
  );
}

/** Input-looking button that opens the command palette (search everything). */
export function SearchLauncher({ onClick, placeholder = 'Search servers, users, keys…' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-11 w-full items-center gap-2.5 rounded-lg border border-input bg-background px-3 text-left text-base text-muted-foreground transition-colors active:bg-accent"
    >
      <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{placeholder}</span>
    </button>
  );
}

/**
 * Phone section title (dashboard widgets and similar): a short brand bar,
 * the title, an optional muted count, and an action (usually "View all")
 * at the end. Space above it sets the section apart.
 */
export function SectionTitle({ title, count, action, className }) {
  return (
    <div className={cn('flex min-h-9 items-center gap-2 pb-1.5 pt-3', className)}>
      <span className="bg-brand-gradient h-4 w-1 shrink-0 rounded-full" aria-hidden="true" />
      <h2 className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-foreground">{title}</h2>
      {count !== null && count !== undefined && count !== false && (
        <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
      )}
      {action && <span className="ml-auto flex shrink-0 items-center gap-1">{action}</span>}
    </div>
  );
}

/** "View all ›" for a SectionTitle: a link (`to`) or a button (`onClick`). */
export function ViewAllLink({ to, onClick, label = 'View all' }) {
  const cls = 'inline-flex h-9 items-center gap-0.5 rounded-md px-1.5 text-sm font-medium text-[hsl(var(--brand))] active:bg-accent';
  const body = (
    <>
      {label}
      <ChevronRight className="h-4 w-4" aria-hidden="true" />
    </>
  );
  return to ? (
    <Link to={to} className={cls}>
      {body}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={cls}>
      {body}
    </button>
  );
}
