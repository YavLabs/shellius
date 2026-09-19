import { useRef } from 'react';
import { pagedRows, storePage } from '@/lib/mobileCard';

/**
 * Phones scroll through server-paginated lists instead of paging: this keeps
 * the pages fetched so far and returns them as one list. The page asks for
 * page + 1 (MobileLoadMore does it on scroll); page 1 starts over, and so
 * does a change of `resetKey` (e.g. a server sort that keeps the page).
 *
 * While the next page loads the caller still passes the previous page's
 * rows, so nothing is stored until `loading` is false again.
 *
 * @returns {Array} every row loaded so far (just `rows` when disabled)
 */
export default function useMobilePages({ rows, page, loading, enabled = true, resetKey = '' }) {
  const store = useRef({ pages: new Map(), resetKey });
  if (!enabled) return rows;
  const s = store.current;
  if (s.resetKey !== resetKey) {
    s.pages = new Map();
    s.resetKey = resetKey;
  }
  if (!loading || page <= 1) s.pages = storePage(s.pages, page, rows);
  return pagedRows(s.pages);
}
