import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import SearchableSelect from '@/components/ui/SearchableSelect';
import EntityPicker from '@/components/shared/EntityPicker';
import BottomSheet from '@/components/mobile/BottomSheet';
import useIsMobile from '@/hooks/useIsMobile';
import { cn } from '@/lib/utils';
import { appliedFilterCount, clearedFilterValues } from '@/lib/filters';

/**
 * The filter drawer every list shares.
 *
 * Lists used to put every filter inline above the table. On Services & ports
 * that was six dropdowns and a search box on one row, which wraps to two
 * rows on a laptop and reads as chrome rather than controls — and the row
 * grew every time a filter was added, so it could only get worse. One
 * "Filters" button with a count, and the controls in a drawer.
 *
 * Filters are a DRAFT while the drawer is open. That is the point of having
 * Apply and Cancel: changing four selects on a server-paginated list used to
 * fire four requests and four re-renders, and there was no way to back out
 * of a filter you opened by mistake. Nothing is committed until Apply.
 *
 * Right-side drawer on desktop, the app's standard bottom sheet on a phone —
 * same controls, same draft, same buttons.
 *
 * @param {Array} defs   [{ key, label, placeholder, options, type, searchable }]
 *                       type: 'select' (default) | 'text' | 'date' |
 *                       'entity' (+ entity: 'servers'|'customers'|'users' —
 *                       searches the API; not capped at 100)
 * @param {object} values current committed values, keyed by def.key
 * @param {Function} onApply called with the draft when Apply is pressed
 */
function FilterDrawer({ open, onClose, defs = [], values = {}, onApply, title = 'Filters' }) {
  const isMobile = useIsMobile();
  const [draft, setDraft] = useState(values);

  // Seed the draft on OPEN only.
  //
  // Callers build `values` as an object literal, so it is a new reference on
  // every render — depending on it directly would re-seed the draft while
  // the drawer is open and silently discard what the user just picked.
  // Keyed on the open transition instead.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) setDraft(values);
    wasOpen.current = open;
  }, [open, values]);

  useEffect(() => {
    if (!open || isMobile) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, isMobile]);

  const draftCount = useMemo(() => appliedFilterCount(defs, draft), [defs, draft]);

  const set = (key, value) => setDraft((p) => ({ ...p, [key]: value }));
  const clearAll = () => setDraft(clearedFilterValues(defs));
  const apply = () => {
    onApply?.(draft);
    onClose?.();
  };

  const body = (
    <div className="flex flex-col gap-4">
      {defs.map((def) => (
        <label key={def.key} className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{def.label}</span>
          {def.type === 'date' ? (
            <input
              type="date"
              value={draft[def.key] ?? ''}
              onChange={(e) => set(def.key, e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          ) : def.type === 'entity' ? (
            <EntityPicker
              className="w-full"
              kind={def.entity}
              value={draft[def.key] ?? ''}
              onChange={(v) => set(def.key, v)}
              anyLabel={def.placeholder || `All ${def.label.toLowerCase()}`}
            />
          ) : def.type === 'text' ? (
            <Input
              value={draft[def.key] ?? ''}
              onChange={(e) => set(def.key, e.target.value)}
              placeholder={def.placeholder}
              className="h-9 w-full"
            />
          ) : (
            <SearchableSelect
              className="w-full"
              value={draft[def.key] ?? ''}
              onChange={(v) => set(def.key, v)}
              options={def.options || []}
              placeholder={def.placeholder || def.label}
              searchable={def.searchable ?? (def.options || []).length > 8}
              clearable={false}
            />
          )}
        </label>
      ))}
    </div>
  );

  const footer = (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        className={cn(isMobile && 'h-11')}
        onClick={clearAll}
        disabled={draftCount === 0}
      >
        Clear all
      </Button>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="outline" className={cn(isMobile && 'h-11')} onClick={onClose}>
          Cancel
        </Button>
        <Button className={cn(isMobile && 'h-11')} onClick={apply}>
          Apply{draftCount > 0 ? ` (${draftCount})` : ''}
        </Button>
      </div>
    </div>
  );

  if (!open) return null;

  if (isMobile) {
    return (
      <BottomSheet
        open={open}
        onClose={onClose}
        closeLabel="Close filters"
        title={title}
        // The page's fixed desktop widths would otherwise leak into a 360px
        // sheet; controls stack full width here.
        bodyClassName="flex flex-col gap-4 pb-4 [&_button.field-soft]:h-11"
        footer={footer}
      >
        {body}
      </BottomSheet>
    );
  }

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="absolute inset-y-0 right-0 flex w-full max-w-sm flex-col border-l border-border bg-card shadow-2xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
          <h3 className="text-base font-semibold text-foreground">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close filters"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{body}</div>
        <div className="shrink-0 border-t border-border px-5 py-3">{footer}</div>
      </div>
    </div>,
    document.body
  );
}

export default FilterDrawer;
