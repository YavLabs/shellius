import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { parseGroupKeys, serializeGroupKeys } from '@/lib/grouping';

/**
 * A list's group-by levels, kept in the URL (`?group=customer,environment`)
 * so a grouped view survives refresh and can be linked, and remembered per
 * list in localStorage so the next visit opens grouped the way it was left.
 *
 * The URL wins: a link that says how to group is followed; only a visit
 * with no `group` param at all picks up the remembered choice. Clearing the
 * grouping stores that too, so "flat" is remembered as a choice.
 *
 * @param {string} storageKey  e.g. 'shellius.servers.groupBy'
 * @param {Array<{value, label}>} options  the levels this list offers
 * @param {{ param?: string }} [opts]
 * @returns {[string[], (keys: string[]) => void]}
 */
export default function useGroupBy(storageKey, options, { param = 'group' } = {}) {
  const [params, setParams] = useSearchParams();
  const raw = params.get(param);
  const optionSig = (options || []).map((o) => o.value).join('|');

  const keys = useMemo(
    () => parseGroupKeys(raw, options),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [raw, optionSig]
  );

  const write = useCallback(
    (next) => {
      const value = serializeGroupKeys(next);
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (value) p.set(param, value);
          else p.delete(param);
          return p;
        },
        { replace: true }
      );
      try {
        localStorage.setItem(storageKey, value);
      } catch {
        // Private mode / blocked storage: the URL still holds it.
      }
    },
    [setParams, param, storageKey]
  );

  // First visit without ?group=: restore the remembered levels, once.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    if (raw !== null) return;
    let saved = '';
    try {
      saved = localStorage.getItem(storageKey) || '';
    } catch {
      saved = '';
    }
    const savedKeys = parseGroupKeys(saved, options);
    if (savedKeys.length) write(savedKeys);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [keys, write];
}
