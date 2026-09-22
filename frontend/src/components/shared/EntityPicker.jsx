import { useEffect, useRef, useState } from 'react';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { lookup } from '@/services/lookupService';

/**
 * A server / customer / user picker that searches the API as you type.
 *
 * Replaces option lists built from `listX({ pageSize: 200 })`, which the
 * APIs cap at 100 — past the 100th server, there was nothing to pick and
 * nothing said so. The selected value is always labelled, even when it
 * came from the URL and is not among the current matches.
 *
 * @param {'servers'|'customers'|'users'} kind
 * @param {string} value           selected id, '' for "any"
 * @param {(id: string) => void} onChange
 * @param {string} [anyLabel]      the "no filter" option, e.g. "All servers"
 */
export default function EntityPicker({ kind, value, onChange, anyLabel = 'Any', placeholder, className }) {
  const [options, setOptions] = useState([]);
  const [selected, setSelected] = useState(null); // { value, label, sublabel }
  const [query, setQuery] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const seq = useRef(0);

  // Matches for what is typed, 250 ms after typing stops.
  useEffect(() => {
    const n = (seq.current += 1);
    const t = setTimeout(() => {
      lookup(kind, { q: query })
        .then((rows) => {
          if (n === seq.current) setOptions(rows);
        })
        .catch(() => {
          if (n === seq.current) setUnavailable(true);
        });
    }, query ? 250 : 0);
    return () => clearTimeout(t);
  }, [kind, query]);

  // The label of a value that is not in the current matches (from the URL,
  // or picked before the user typed something else).
  useEffect(() => {
    if (!value) {
      setSelected(null);
      return;
    }
    const hit = options.find((o) => o.value === value);
    if (hit) {
      setSelected(hit);
      return;
    }
    if (selected?.value === value) return;
    lookup(kind, { ids: [value] })
      .then((rows) => setSelected(rows[0] || { value, label: 'Unknown (no access, or deleted)' }))
      .catch(() => setSelected({ value, label: value }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, value, options]);

  const merged = [
    { value: '', label: anyLabel },
    ...(selected && !options.some((o) => o.value === selected.value) ? [selected] : []),
    ...options,
  ];

  return (
    <SearchableSelect
      className={className}
      value={value ?? ''}
      onChange={onChange}
      options={merged}
      placeholder={placeholder || anyLabel}
      searchPlaceholder="Type to search…"
      clearable={false}
      filterFn={() => true}
      onQueryChange={setQuery}
      emptyMessage={unavailable ? 'You cannot list these' : 'No matches'}
      renderOption={(o) => (
        <span className="min-w-0">
          <span className="block truncate text-foreground">{o.label}</span>
          {o.sublabel && <span className="block truncate text-[11px] text-muted-foreground">{o.sublabel}</span>}
        </span>
      )}
    />
  );
}
