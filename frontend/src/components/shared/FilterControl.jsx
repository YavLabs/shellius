import { useState } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import FilterDrawer from '@/components/shared/FilterDrawer';
import { appliedFilters, clearedFilterValues } from '@/lib/filters';

/**
 * The "Filters" button, its applied-count chip, and the drawer behind them.
 *
 * The chip is separate from the button on purpose: the count tells you
 * something is narrowing the list, and the × next to it clears everything in
 * one click. Folding the clear into the button would mean opening a drawer
 * to undo a filter you can already see the effect of.
 *
 * Renders nothing when a list has no filters to offer, so callers can pass
 * `defs` unconditionally.
 */
function FilterControl({ defs = [], values = {}, onChange, title = 'Filters' }) {
  const [open, setOpen] = useState(false);
  if (!defs || defs.length === 0) return null;

  const applied = appliedFilters(defs, values);
  const clearAll = () => onChange?.(clearedFilterValues(defs));

  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="h-9 shrink-0 gap-2"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
        >
          <SlidersHorizontal className="h-4 w-4" />
          Filters
          {applied.length > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground tabular-nums">
              {applied.length}
            </span>
          )}
        </Button>

        {applied.length > 0 && (
          <span
            className="flex min-w-0 items-center gap-1 rounded-md border border-border bg-muted/50 py-1 pl-2 pr-1 text-xs text-muted-foreground"
            // The names of what is narrowing the list, for anyone wondering
            // why the table is short.
            title={applied.map((d) => d.label).join(', ')}
          >
            <span className="truncate max-sm:hidden">
              {applied.length} filter{applied.length === 1 ? '' : 's'} applied
            </span>
            <span className="truncate sm:hidden">{applied.length}</span>
            <button
              type="button"
              onClick={clearAll}
              aria-label="Clear all filters"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
      </div>

      <FilterDrawer
        open={open}
        onClose={() => setOpen(false)}
        defs={defs}
        values={values}
        onApply={onChange}
        title={title}
      />
    </>
  );
}

export default FilterControl;
