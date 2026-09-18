import { useCallback, useEffect, useState } from 'react';
import { listAccessRequests } from '@/services/accessRequestService';

export const PENDING_REVIEWS_EVENT = 'shellius:pending-reviews';

/**
 * Number of access requests waiting for the current user's review: the same
 * query and number as the "Pending reviews" tab on the Access requests page.
 * The page broadcasts its own count (PENDING_REVIEWS_EVENT) after every
 * load/approve/deny, so the sidebar badge and the tab never disagree.
 *
 * `refreshKey` changes (e.g. the unread-notification count, which bumps
 * when a new request arrives) trigger a refetch.
 */
export default function usePendingReviewCount(refreshKey) {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const resp = await listAccessRequests({ tab: 'to-review', status: 'PENDING', limit: 1 });
      setCount(resp.meta?.total ?? 0);
    } catch {
      /* keep the last known count */
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  useEffect(() => {
    const id = setInterval(refresh, 60000);
    const onFocus = () => refresh();
    const onBroadcast = (e) => {
      if (typeof e.detail === 'number') setCount(e.detail);
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener(PENDING_REVIEWS_EVENT, onBroadcast);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(PENDING_REVIEWS_EVENT, onBroadcast);
    };
  }, [refresh]);

  return count;
}
