import { useEffect, useState } from 'react';
import { isKeyboardOpen } from '@/lib/mobileNav';

function read() {
  if (typeof window === 'undefined' || !window.visualViewport) return false;
  return isKeyboardOpen(window.innerHeight, window.visualViewport.height);
}

/**
 * true while the on-screen keyboard is open (the visual viewport is much
 * shorter than the layout viewport). Always false where visualViewport
 * isn't supported.
 */
export default function useKeyboardOpen() {
  const [open, setOpen] = useState(read);
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return undefined;
    const onResize = () => setOpen(read());
    onResize();
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);
  return open;
}
