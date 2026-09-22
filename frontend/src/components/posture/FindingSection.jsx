import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * One collapsible section of the findings inbox.
 *
 * Tabs made three of these four views invisible: nothing on the page said a
 * muted or acknowledged finding existed, so the only way to remember them
 * was to already know. Sections put every count on screen at once and let
 * the ones that are not a queue stay shut.
 *
 * Open is expanded by default because it is the only section that is
 * actually work; the rest are reference and open on demand.
 */
function FindingSection({
  title,
  description,
  count,
  tone = 'neutral',
  open,
  onToggle,
  meta,
  children,
}) {
  const TONES = {
    neutral: 'bg-muted text-muted-foreground',
    danger: 'bg-red-500/15 text-red-600 dark:text-red-400',
    warning: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    success: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  };
  // An empty section is still worth showing — "0 muted" is information, and
  // a section that vanishes when empty teaches people it does not exist.
  // null = the count has not loaded yet: a placeholder, not "0".
  const empty = count === 0;
  const countLoading = count === null || count === undefined;
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        disabled={empty}
        className={cn(
          'flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors',
          !empty && 'hover:bg-accent/40',
          empty && 'cursor-default'
        )}
      >
        <ChevronRight
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
            empty && 'opacity-30'
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn('truncate text-sm font-semibold', empty ? 'text-muted-foreground' : 'text-foreground')}>
              {title}
            </span>
            {countLoading ? (
              <span className="h-4 w-6 shrink-0 animate-pulse rounded-full bg-muted" aria-label="Loading count" />
            ) : (
              <span
                className={cn(
                  'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums',
                  empty ? 'bg-muted text-muted-foreground' : TONES[tone] || TONES.neutral
                )}
              >
                {count}
              </span>
            )}
          </span>
          {/* Truncated while collapsed; read in full once opened — a
              description cut off mid-instruction is worse than none. */}
          {description && (
            <span className={cn('mt-0.5 block text-xs text-muted-foreground', !open && 'truncate')}>{description}</span>
          )}
        </span>
        {meta && <span className="shrink-0 text-[11px] font-medium text-muted-foreground">{meta}</span>}
      </button>
      {open && !empty && <div className="border-t border-border px-4 py-4 max-sm:px-3">{children}</div>}
    </section>
  );
}

export default FindingSection;
