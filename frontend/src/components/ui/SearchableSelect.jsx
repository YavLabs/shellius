import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronsUpDown, Search, X } from 'lucide-react';

/**
 * SearchableSelect — universal single/multi select with type-ahead search and
 * custom option rendering. Replaces native <select> and the shadcn Select for
 * any picker that benefits from search (users, servers, customers, groups…).
 *
 * Props:
 *   options      {Array<{ value, label, ...extra }>}  choices
 *   value        single: string | null ; multiple: string[]   selected value(s)
 *   onChange     (value) => void   single: string ; multiple: string[]
 *   multiple?    {boolean}         enable multi-select (default false)
 *   placeholder? {string}
 *   searchPlaceholder?
 *   disabled?    {boolean}
 *   clearable?   {boolean}         show a clear (x) button (single only, default true)
 *   renderOption?(option) => ReactNode   custom row rendering (e.g. avatar)
 *   renderValue?(option|options) => ReactNode  custom trigger label rendering
 *   getKey?      (option) => string   defaults to option.value
 *   filterFn?    (option, query) => boolean  defaults to label substring
 *   emptyMessage?
 *   className?   wrapper class
 *   id?
 */
function defaultFilter(opt, q) {
  if (!q) return true;
  const hay = `${opt.label ?? ''} ${opt.sublabel ?? ''} ${opt.value ?? ''}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}

export default function SearchableSelect({
  options = [],
  value,
  onChange,
  multiple = false,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  searchable = true,
  disabled = false,
  clearable = true,
  renderOption,
  renderValue,
  getKey,
  filterFn = defaultFilter,
  emptyMessage = 'No matches',
  className = '',
  id,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef(null);
  const inputRef = useRef(null);

  const keyOf = getKey || ((o) => o.value);
  const selectedValues = multiple ? (Array.isArray(value) ? value : []) : value;

  const byKey = useMemo(() => {
    const m = new Map();
    for (const o of options) m.set(keyOf(o), o);
    return m;
  }, [options]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(
    () => options.filter((o) => filterFn(o, query)),
    [options, query, filterFn]
  );

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return undefined;
    function onDocClick(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    // Capture phase so it still fires when a parent (e.g. a modal) stops
    // propagation of the bubbling event.
    document.addEventListener('mousedown', onDocClick, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
    if (!open) setQuery('');
  }, [open]);

  const isSelected = (o) =>
    multiple ? selectedValues.includes(keyOf(o)) : selectedValues === keyOf(o);

  function pick(o) {
    const k = keyOf(o);
    if (multiple) {
      const next = selectedValues.includes(k)
        ? selectedValues.filter((v) => v !== k)
        : [...selectedValues, k];
      onChange?.(next);
    } else {
      onChange?.(k);
      setOpen(false);
    }
  }

  function clear(e) {
    e.stopPropagation();
    onChange?.(multiple ? [] : '');
  }

  const triggerLabel = () => {
    if (multiple) {
      const sel = selectedValues.map((v) => byKey.get(v)).filter(Boolean);
      if (sel.length === 0) return <span className="text-muted-foreground">{placeholder}</span>;
      if (renderValue) return renderValue(sel);
      return (
        <span className="flex flex-wrap gap-1">
          {sel.map((o) => (
            <span
              key={keyOf(o)}
              className="inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground"
            >
              {o.label}
              <X
                className="h-3 w-3 cursor-pointer opacity-60 hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange?.(selectedValues.filter((v) => v !== keyOf(o)));
                }}
              />
            </span>
          ))}
        </span>
      );
    }
    // Use has() not truthiness — '' (e.g. "Auto" / "All X") is a valid value.
    const sel = byKey.has(selectedValues) ? byKey.get(selectedValues) : null;
    if (!sel) return <span className="text-muted-foreground">{placeholder}</span>;
    if (renderValue) return renderValue(sel);
    return <span className="truncate">{sel.label}</span>;
  };

  const hasSelection = multiple
    ? selectedValues.length > 0
    : selectedValues !== undefined && selectedValues !== null && selectedValues !== '';

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        id={id}
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="flex min-w-0 flex-1 items-center">{triggerLabel()}</span>
        <span className="flex items-center gap-1">
          {clearable && hasSelection && !disabled && (
            <X
              className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground"
              onClick={clear}
            />
          )}
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </span>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover shadow-md">
          {searchable && (
            <div className="flex items-center gap-2 border-b border-border px-2.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="h-8 w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
            </div>
          )}
          <ul className="max-h-60 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted-foreground">{emptyMessage}</li>
            )}
            {filtered.map((o) => {
              const selected = isSelected(o);
              return (
                <li key={keyOf(o)}>
                  <button
                    type="button"
                    onClick={() => pick(o)}
                    className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-accent ${
                      selected ? 'bg-accent/50' : ''
                    }`}
                  >
                    <Check
                      className={`h-4 w-4 shrink-0 ${selected ? 'opacity-100 text-primary' : 'opacity-0'}`}
                    />
                    <span className="min-w-0 flex-1">
                      {renderOption ? renderOption(o) : <span className="truncate">{o.label}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
