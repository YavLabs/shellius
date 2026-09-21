import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

/**
 * The posture count tile, in one place.
 *
 * Three pages had grown their own copy of the same square — Server Details'
 * severity filters, Customer Details' posture panel, and the fleet summary —
 * which is how they ended up disagreeing about padding and type size, and
 * why the phone layout had to be fixed three times.
 *
 * Phones get the compact size (smaller padding, a smaller number, three to a
 * row). Six tiles at desktop proportions filled a phone screen on their own,
 * pushing the findings they were supposed to summarise below the fold — a
 * summary you have to scroll past is worse than no summary.
 */

export function PostureTileGrid({ children, className }) {
  return (
    <div className={cn('grid grid-cols-3 gap-2 sm:gap-3', className)}>{children}</div>
  );
}

/**
 * @param {boolean} [props.inset]  tile sits inside a card — tint accordingly
 * @param {string} [props.to]       render as a link
 * @param {Function} [props.onClick] render as a filter toggle (with `active`)
 * otherwise a plain, inert tile.
 */
export function PostureTile({
  icon: Icon,
  label,
  tint,
  value,
  suffix,
  active = false,
  disabled = false,
  inset = false,
  onClick,
  to,
  title,
}) {
  const interactive = (!!onClick && !disabled) || !!to;
  const className = cn(
    'min-w-0 rounded-lg border p-2.5 text-left transition-colors sm:p-3.5',
    // `inset` is for tiles sitting INSIDE a card: bg-card on bg-card is
    // flat-on-flat and the tile disappears. Same treatment the Dashboard's
    // widget stats use.
    active ? 'border-primary bg-primary/5' : inset ? 'border-border bg-background/40' : 'border-border bg-card',
    interactive ? 'hover:border-primary/40 hover:bg-accent/40' : disabled && 'opacity-60'
  );

  const inner = (
    <>
      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground sm:text-xs">
        {Icon && <Icon className={cn('h-3.5 w-3.5 shrink-0', tint)} aria-hidden="true" />}
        <span className="truncate">{label}</span>
      </span>
      <span className="mt-0.5 block text-lg font-semibold leading-tight tabular-nums text-foreground sm:mt-1 sm:text-2xl">
        {value}
        {suffix}
      </span>
    </>
  );

  if (to) {
    return (
      <Link to={to} className={className} title={title}>
        {inner}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} disabled={disabled} aria-pressed={active} className={className} title={title}>
        {inner}
      </button>
    );
  }
  return (
    <div className={className} title={title}>
      {inner}
    </div>
  );
}

export default PostureTile;
