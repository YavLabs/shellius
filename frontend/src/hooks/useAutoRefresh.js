import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Keep a page's data fresh without anyone pressing F5.
 *
 * - `refresh()` runs the loader now and records when it last succeeded, so
 *   the page can say "updated 12s ago" next to its Refresh button.
 * - When `interval` is set (ms) and `enabled` is true, it re-runs on that
 *   interval — for pages waiting on something that will change on its own
 *   (a collector about to report, a bootstrap in progress).
 * - Polling pauses while the browser tab is hidden and catches up once when
 *   it becomes visible again: a background tab polling forever is load on
 *   the API for a page nobody is looking at.
 * - A run never overlaps the previous one; a slow API is not multiplied.
 *
 * @param {() => Promise<unknown>} load
 * @param {{ interval?: number, enabled?: boolean }} [opts]
 * @returns {{ refresh: () => Promise<void>, refreshing: boolean, lastUpdated: Date|null }}
 */
export default function useAutoRefresh(load, { interval = 0, enabled = true } = {}) {
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const inFlight = useRef(false);
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      await loadRef.current?.();
      setLastUpdated(new Date());
    } catch {
      /* the loader owns its own error state */
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled || !interval) return undefined;
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      refresh();
    };
    const id = setInterval(tick, interval);
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, interval, refresh]);

  return { refresh, refreshing, lastUpdated };
}
