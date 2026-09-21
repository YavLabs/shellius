import { useCallback, useEffect, useState } from 'react';
import { getPostureSummary } from '@/services/postureService';

export const POSTURE_ALERTS_EVENT = 'shellius:posture-alerts';

/**
 * Open findings that need attention: CRITICAL + HIGH, org-wide within the
 * caller's customer scope.
 *
 * Deliberately not every open finding. A badge that counts INFO and LOW too
 * is never zero on a real fleet, and a badge that is never zero is wallpaper
 * — the same reason the Server Details tab dot is CRITICAL/HIGH only.
 *
 * Returns 0 for anyone without `posture.read`; the caller decides whether to
 * render at all, and a refused request must not look like a clean fleet.
 *
 * `refreshKey` changes (e.g. the unread-notification count, which bumps when
 * a posture alert arrives) trigger a refetch.
 */
export default function usePostureAlertCount(enabled, refreshKey) {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const summary = await getPostureSummary();
      setCount((summary?.findings?.critical || 0) + (summary?.findings?.high || 0));
    } catch {
      /* keep the last known count rather than flashing a false zero */
    }
  }, [enabled]);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  useEffect(() => {
    if (!enabled) return undefined;
    const id = setInterval(refresh, 120000);
    const onFocus = () => refresh();
    // The Posture page broadcasts after every mute/acknowledge/expected-port
    // save, so acting on a finding clears the badge without waiting for the
    // poll — the badge and the page can never disagree for a minute.
    const onBroadcast = (e) => {
      if (typeof e.detail === 'number') setCount(e.detail);
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener(POSTURE_ALERTS_EVENT, onBroadcast);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(POSTURE_ALERTS_EVENT, onBroadcast);
    };
  }, [refresh, enabled]);

  return enabled ? count : 0;
}
