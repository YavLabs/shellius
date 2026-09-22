import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Filter state that lives in the URL.
 *
 * Filters kept in component state are lost on refresh, cannot be linked to
 * (the Dashboard's "/certificates?status=ACTIVE" opened an unfiltered list)
 * and do not survive Back. Here the URL IS the state: reading declared keys
 * from the query string, writing them back with `replace` (so typing in a
 * search box does not push a history entry per keystroke), and leaving any
 * other query parameter — deep links like ?highlight= — alone.
 *
 * @param {Record<string, string>} defaults  every key this page owns, with
 *   its "no filter" value (usually ''). Keys not listed are never touched.
 * @returns {[Record<string,string>, (patch: object) => void, () => void]}
 *   values, set(patch) — merges; '' / null / undefined removes the key —
 *   and clear() for every declared key except `keep` ones.
 */
export default function useUrlFilters(defaults) {
  const [params, setParams] = useSearchParams();
  const keys = Object.keys(defaults);
  const keySig = keys.join('|');

  const values = useMemo(() => {
    const out = {};
    for (const k of keys) out[k] = params.get(k) ?? defaults[k] ?? '';
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, keySig]);

  const set = useCallback(
    (patch) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch || {})) {
            if (v === '' || v === null || v === undefined || v === defaults[k]) next.delete(k);
            else next.set(k, String(v));
          }
          return next;
        },
        { replace: true }
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setParams, keySig]
  );

  const clear = useCallback(
    (keep = []) => set(Object.fromEntries(keys.filter((k) => !keep.includes(k)).map((k) => [k, '']))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [set, keySig]
  );

  return [values, set, clear];
}
