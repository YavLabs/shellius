import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Loader2, Search, SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import FilterSheet from '@/components/mobile/FilterSheet';

/**
 * Toolbar, pager and bulk bar for mobile lists (docs/plans/1.5.1-mobile.md §5).
 */

/** Full-width search input with 16px text (no iOS zoom). */
export function MobileSearch({ value, onChange, placeholder = 'Search...' }) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-11 pl-9 text-base"
        type="search"
      />
    </div>
  );
}

/** "Filters" button (with active count) + the sheet holding the controls. */
export function MobileFiltersButton({ filters, activeCount = 0, onReset, title = 'Filters' }) {
  const [open, setOpen] = useState(false);
  if (!filters) return null;
  return (
    <>
      <Button variant="outline" className="h-10 gap-2 px-3" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <SlidersHorizontal className="h-4 w-4" />
        Filters
        {activeCount > 0 && (
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
            {activeCount}
          </span>
        )}
      </Button>
      <FilterSheet open={open} onClose={() => setOpen(false)} title={title} activeCount={activeCount} onReset={onReset}>
        {filters}
      </FilterSheet>
    </>
  );
}

/** "Sort" menu listing the sortable columns; picking the active one flips direction. */
export function MobileSortMenu({ options = [], sortKey, sortDir, onSelect, onClear }) {
  if (options.length === 0) return null;
  const active = options.find((o) => o.key === sortKey);
  const DirIcon = !active ? ArrowUpDown : sortDir === 'desc' ? ArrowDown : ArrowUp;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="h-10 min-w-0 gap-2 px-3">
          <DirIcon className="h-4 w-4 shrink-0" />
          <span className="truncate">{active ? active.label : 'Sort'}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Sort by</DropdownMenuLabel>
        {options.map((o) => {
          const isActive = o.key === sortKey;
          return (
            <DropdownMenuItem key={o.key} className="min-h-11" onClick={() => onSelect(o.key)}>
              <Check className={cn('mr-2 h-4 w-4', isActive ? 'opacity-100 text-primary' : 'opacity-0')} />
              <span className="flex-1">{o.label}</span>
              {isActive &&
                (sortDir === 'desc' ? (
                  <ArrowDown className="h-4 w-4 text-muted-foreground" aria-label="descending" />
                ) : (
                  <ArrowUp className="h-4 w-4 text-muted-foreground" aria-label="ascending" />
                ))}
            </DropdownMenuItem>
          );
        })}
        {onClear && active && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="min-h-11" onClick={onClear}>
              <span className="ml-6">Default order</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Select-all toggle for selectable lists. */
export function MobileSelectAll({ checked, indeterminate, onChange, disabled }) {
  return (
    <label className={cn('flex h-10 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-muted-foreground', disabled && 'opacity-50')}>
      <Checkbox checked={checked} indeterminate={indeterminate} onChange={onChange} disabled={disabled} aria-label="Select all" />
      All
    </label>
  );
}

/**
 * End of a mobile list: loads the next page on its own when it scrolls into
 * view (400px early), with a "Load more" button as the fallback, and a count
 * once everything is shown. Works for client lists (show more rows) and
 * server lists (fetch the next page) alike — the caller decides via `onMore`.
 */
export function MobileLoadMore({ shown, total, hasMore = shown < total, loading = false, onMore }) {
  const sentinel = useRef(null);
  const onMoreRef = useRef(onMore);
  onMoreRef.current = onMore;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || loading || typeof IntersectionObserver === 'undefined') return undefined;
    // Re-created whenever the list grows, so a short page that leaves the
    // sentinel on screen triggers the next load straight away.
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          onMoreRef.current?.();
        }
      },
      { rootMargin: '400px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, shown]);

  if (!hasMore) {
    return total > 0 ? (
      <p className="py-2 text-center text-xs text-muted-foreground tabular-nums">
        {total} {total === 1 ? 'item' : 'items'}
      </p>
    ) : null;
  }
  return (
    <div ref={sentinel} className="space-y-1.5 pt-1">
      <Button variant="outline" className="h-11 w-full gap-2" onClick={onMore} disabled={loading}>
        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
        {loading ? 'Loading…' : 'Load more'}
      </Button>
      <p className="text-center text-xs text-muted-foreground tabular-nums">
        Showing {shown} of {total}
      </p>
    </div>
  );
}

/**
 * Bulk-action bar pinned above the mobile bottom navigation and its raised "+" (64px + 24px + safe
 * area). Rendered fixed so it doesn't depend on the scroll container; the
 * list adds a spacer so the last card isn't hidden behind it.
 */
export function MobileBulkBar({ children }) {
  return (
    <>
      <div aria-hidden="true" className="h-40" />
      <div className="fixed inset-x-0 bottom-[calc(88px+env(safe-area-inset-bottom))] z-30 px-3 pb-2">
        <div className="max-h-[45dvh] overflow-y-auto rounded-lg bg-card shadow-lg ring-1 ring-black/5 [&_button]:min-h-10">
          {children}
        </div>
      </div>
    </>
  );
}
