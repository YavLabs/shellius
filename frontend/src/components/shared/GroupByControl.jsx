import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, Layers, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MAX_GROUP_LEVELS } from '@/lib/grouping';

/**
 * Chip-chain group-by builder (after Ledgrr's shared GroupByBuilder).
 *
 * An ordered list of levels, each removable and reorderable, with a menu to
 * add another. The order is the nesting order — "Customer › Environment" and
 * "Environment › Customer" are different trees — which is why the chips read
 * left to right with chevrons between them rather than as a set of toggles.
 *
 * @param {{ groupKeys: string[], onChange: (keys: string[]) => void,
 *           options: Array<{ value: string, label: string }>, max?: number,
 *           emptyLabel?: string }} props
 */
export function GroupByBuilder({
  groupKeys,
  onChange,
  options,
  max = MAX_GROUP_LEVELS,
  emptyLabel = 'No grouping — one flat list',
}) {
  const used = new Set(groupKeys);
  const available = options.filter((o) => !used.has(o.value));
  const labelOf = (k) => options.find((o) => o.value === k)?.label || k;

  const removeAt = (idx) => onChange(groupKeys.filter((_, i) => i !== idx));
  const move = (idx, delta) => {
    const target = idx + delta;
    if (target < 0 || target >= groupKeys.length) return;
    const next = [...groupKeys];
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange(next);
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      {groupKeys.length === 0 && <span className="pr-1 text-xs text-muted-foreground">{emptyLabel}</span>}
      {groupKeys.map((k, idx) => (
        <Fragment key={k}>
          {idx > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
          <div className="flex items-center gap-0.5 rounded-md border border-border bg-muted/40 px-1.5 py-0.5">
            {groupKeys.length > 1 && (
              <>
                <button
                  type="button"
                  aria-label={`Move ${labelOf(k)} earlier`}
                  disabled={idx === 0}
                  onClick={() => move(idx, -1)}
                  className="inline-flex rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  <ChevronUp className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${labelOf(k)} later`}
                  disabled={idx === groupKeys.length - 1}
                  onClick={() => move(idx, 1)}
                  className="inline-flex rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  <ChevronDown className="h-3 w-3" />
                </button>
              </>
            )}
            <span className="px-0.5 text-xs font-medium">{labelOf(k)}</span>
            <button
              type="button"
              aria-label={`Remove ${labelOf(k)}`}
              onClick={() => removeAt(idx)}
              className="inline-flex rounded p-0.5 text-muted-foreground hover:text-destructive"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </Fragment>
      ))}
      {available.length > 0 && groupKeys.length < max && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
              <Plus className="h-3 w-3" />
              {groupKeys.length === 0 ? 'Add grouping' : 'Add level'}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {available.map((opt) => (
              <DropdownMenuItem key={opt.value} onClick={() => onChange([...groupKeys, opt.value])}>
                {opt.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/**
 * The toolbar's "Group" button: the chain behind a popover, its level count
 * on the button, and the chain itself shown inline beside it while grouping
 * is on — so what the list is grouped by is never hidden behind a click.
 */
export default function GroupByControl({ groupKeys, onChange, options, max = MAX_GROUP_LEVELS }) {
  const [open, setOpen] = useState(false);
  if (!options || options.length === 0) return null;
  const active = groupKeys.length > 0;
  const labelOf = (k) => options.find((o) => o.value === k)?.label || k;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-9 shrink-0 gap-2" aria-haspopup="dialog">
            <Layers className="h-4 w-4" />
            Group
            {active && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground tabular-nums">
                {groupKeys.length}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[22rem] max-w-[calc(100vw-2rem)] space-y-3 p-3">
          <div>
            <p className="text-sm font-medium">Group by</p>
            <p className="text-xs text-muted-foreground">
              Up to {max} levels, outermost first. Filters still apply inside every group.
            </p>
          </div>
          <GroupByBuilder groupKeys={groupKeys} onChange={onChange} options={options} max={max} />
          {active && (
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onChange([])}>
                Clear grouping
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
      {active && (
        <span
          className="flex min-w-0 items-center gap-1 rounded-md border border-border bg-muted/50 py-1 pl-2 pr-1 text-xs text-muted-foreground"
          title={`Grouped by ${groupKeys.map(labelOf).join(' › ')}`}
        >
          <span className="truncate max-sm:hidden">{groupKeys.map(labelOf).join(' › ')}</span>
          <button
            type="button"
            onClick={() => onChange([])}
            aria-label="Clear grouping"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      )}
    </div>
  );
}
