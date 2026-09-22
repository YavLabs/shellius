import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
 *
 * The remembered / default levels are returned from the FIRST render, not
 * after an effect writes them to the URL — otherwise every grouped page
 * fetched its flat list first and then flashed into groups.
 *
 * `defaultKeys` is the grouping a list opens with when there is neither a
 * `group` param nor anything remembered (a first visit). It goes in the URL
 * only — not remembered — so a later change of default still reaches people
 * who never picked a grouping themselves.
 *
 * @param {{ param?: string, defaultKeys?: string[] }} [opts]
 * @returns {[string[], (keys: string[]) => void]}
 */
export default function useGroupBy(storageKey, options, { param = 'group', defaultKeys } = {}) {
  const [params, setParams] = useSearchParams();
  const raw = params.get(param);
  const optionSig = (options || []).map((o) => o.value).join('|');

  // What a visit with no ?group= opens with: the remembered levels, else
  // (nothing remembered at all, not even "flat") the list's default.
  const [initial] = useState(() => {
    if (raw !== null) return null;
    let saved = null;
    try {
      saved = localStorage.getItem(storageKey);
    } catch {
      saved = null;
    }
    const savedKeys = parseGroupKeys(saved || '', options);
    if (savedKeys.length) return { keys: savedKeys, remember: true };
    const fallback = saved === null ? parseGroupKeys(serializeGroupKeys(defaultKeys), options) : [];
    return fallback.length ? { keys: fallback, remember: false } : null;
  });
  // Once anything has been written, the URL alone is the truth.
  const [touched, setTouched] = useState(false);

  const keys = useMemo(
    () => (raw === null && !touched && initial ? initial.keys : parseGroupKeys(raw, options)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [raw, optionSig, touched, initial]
  );

  const setUrl = useCallback(
    (value) =>
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (value) p.set(param, value);
          else p.delete(param);
          return p;
        },
        { replace: true }
      ),
    [setParams, param]
  );

  const write = useCallback(
    (next) => {
      const value = serializeGroupKeys(next);
      setTouched(true);
      setUrl(value);
      try {
        localStorage.setItem(storageKey, value);
      } catch {
        // Private mode / blocked storage: the URL still holds it.
      }
    },
    [setUrl, storageKey]
  );

  // Put the initial levels in the URL too, so the page can be linked as seen.
  // A default is not remembered, so a later change of default still reaches
  // people who never picked a grouping themselves.
  const synced = useRef(false);
  useEffect(() => {
    if (synced.current) return;
    synced.current = true;
    if (initial) setUrl(serializeGroupKeys(initial.keys));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [keys, write];
}
