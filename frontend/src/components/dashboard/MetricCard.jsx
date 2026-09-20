import { useNavigate } from 'react-router-dom';
import Skeleton from '@/components/ui/Skeleton';

// Accent palette per card — icon tile + hover ring color.
const ACCENTS = {
  primary: { bg: 'bg-primary/10', text: 'text-primary', ring: 'group-hover:border-primary/40' },
  emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-600 dark:text-emerald-400', ring: 'group-hover:border-emerald-500/40' },
  amber: { bg: 'bg-amber-500/10', text: 'text-amber-600 dark:text-amber-400', ring: 'group-hover:border-amber-500/40' },
  violet: { bg: 'bg-violet-500/10', text: 'text-violet-600 dark:text-violet-400', ring: 'group-hover:border-violet-500/40' },
  // Same rose hue as the "danger" tone elsewhere (Badge, MobileCard accents) —
  // used for critical-count tiles (e.g. Posture) rather than a new colour.
  rose: { bg: 'bg-rose-500/10', text: 'text-rose-600 dark:text-rose-400', ring: 'group-hover:border-rose-500/40' },
};

/**
 * MetricCard — compact Dashboard top-row metric card. Header row = tinted
 * icon + label on the left, big number right-aligned on the same row. Below,
 * a single compact line with a muted subtitle and an optional footer slot
 * (env badges, a "View X →" link, etc). No divider. ~96-110px tall.
 */
function MetricCard({
  title,
  value,
  subtitle,
  icon: Icon,
  loading,
  footer,
  accent = 'primary',
  to,
  onClick,
}) {
  const navigate = useNavigate();
  const interactive = !!to || !!onClick;
  const handleClick = () => {
    if (onClick) onClick();
    else if (to) navigate(to);
  };
  const accentCls = ACCENTS[accent] || ACCENTS.primary;

  const Wrapper = interactive ? 'button' : 'div';
  const baseCls =
    'group relative flex h-full w-full flex-col rounded-lg border border-border bg-card p-4 text-left transition-all';
  const interactiveCls = interactive
    ? ` hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${accentCls.ring}`
    : '';

  return (
    <Wrapper
      {...(interactive ? { type: 'button', onClick: handleClick } : {})}
      className={baseCls + interactiveCls}
    >
      {/* Header row: icon tile + label (left), big number (right) */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${accentCls.bg} ${accentCls.text}`}
          >
            <Icon className="h-4 w-4" />
          </div>
          <p className="truncate text-sm font-medium text-muted-foreground">{title}</p>
        </div>
        {loading ? (
          <Skeleton className="h-7 w-12 shrink-0" />
        ) : (
          <p className="shrink-0 text-2xl font-semibold tracking-tight text-foreground tabular-nums">
            {value}
          </p>
        )}
      </div>

      {/* Identical rhythm on every card: subtitle line, then a footer line
          (badges or a link) with a fixed height so cards align in the grid. */}
      {loading ? (
        <div className="mt-2 space-y-2">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-5 w-32" />
        </div>
      ) : (
        <>
          <p className="mt-2 truncate text-xs text-muted-foreground">{subtitle || '\u00a0'}</p>
          <div className="mt-2 flex min-h-5 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {footer}
          </div>
        </>
      )}
    </Wrapper>
  );
}

export default MetricCard;
