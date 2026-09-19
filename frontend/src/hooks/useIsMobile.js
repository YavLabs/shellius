import { useEffect, useState } from 'react';

/** Below Tailwind's `md` breakpoint — the mobile layout (docs/plans/1.5.1-mobile.md). */
export const MOBILE_QUERY = '(max-width: 767px)';

function matches() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(MOBILE_QUERY).matches
    : false;
}

/** true on phone-sized viewports; follows resizes and rotation. */
export default function useIsMobile() {
  const [isMobile, setIsMobile] = useState(matches);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, []);
  return isMobile;
}
