/**
 * terminalTouchScroll — drag-to-scroll the terminal's scrollback on touch
 * devices.
 *
 * Why this is needed: xterm renders the text into `.xterm-screen`, which is a
 * SIBLING of the scrollable `.xterm-viewport`, not a child of it. A finger on
 * the text therefore has no scrollable ancestor to pan — and every container
 * above the terminal is `overflow-hidden` — so the browser's native touch
 * scrolling does nothing at all. Mouse wheels are unaffected (xterm handles
 * `wheel` itself), which is why this only ever showed up on phones.
 *
 * We translate a vertical drag into `term.scrollLines()` (public API, so it
 * keeps working across xterm versions) and add a short momentum glide after
 * the finger lifts, which is what makes it feel native.
 *
 * Deliberately left alone:
 *   - taps: no movement means no preventDefault, so focusing the terminal and
 *     opening the on-screen keyboard still work exactly as before.
 *   - multi-touch: pinch-zoom is the browser's.
 *   - the alternate screen buffer (vim, less, htop): it has no scrollback, so
 *     dragging is a no-op there rather than something surprising.
 */

/** Below this many pixels a touch is still a tap, not a drag. */
const DRAG_THRESHOLD_PX = 8;
/** Momentum below this (px/ms) isn't worth animating. */
const MIN_FLING_VELOCITY = 0.05;
/** Per-frame velocity decay for the glide. */
const FRICTION = 0.94;

export function attachTouchScroll(term, container) {
  if (!term || !container || typeof window === 'undefined') return () => {};

  let startY = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;
  let residue = 0; // sub-line remainder, so slow drags still accumulate
  let dragging = false;
  let tracking = false;
  let frame = null;

  /** Height of one row in CSS pixels, derived from the rendered box. */
  const lineHeight = () => {
    const rows = term.rows || 1;
    const h = container.clientHeight || term.element?.clientHeight || 0;
    return h > 0 ? h / rows : 17;
  };

  const onAlternateBuffer = () => term.buffer?.active?.type === 'alternate';

  /** Convert a pixel delta into whole lines, keeping the remainder. */
  const scrollByPixels = (dy) => {
    residue += dy;
    const step = lineHeight();
    const lines = Math.trunc(residue / step);
    if (!lines) return;
    residue -= lines * step;
    // Dragging the content DOWN (positive dy) reveals earlier output, which
    // is a negative scroll in xterm's terms.
    term.scrollLines(-lines);
  };

  const stopGlide = () => {
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
  };

  const glide = () => {
    frame = null;
    if (Math.abs(velocity) < MIN_FLING_VELOCITY) return;
    // ~16ms per frame; the exact value doesn't matter because of the decay.
    scrollByPixels(velocity * 16);
    velocity *= FRICTION;
    frame = requestAnimationFrame(glide);
  };

  const onTouchStart = (e) => {
    if (e.touches.length !== 1) {
      tracking = false;
      return;
    }
    stopGlide();
    tracking = true;
    dragging = false;
    velocity = 0;
    residue = 0;
    startY = e.touches[0].clientY;
    lastY = startY;
    lastT = e.timeStamp || Date.now();
  };

  const onTouchMove = (e) => {
    if (!tracking || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    const t = e.timeStamp || Date.now();

    if (!dragging) {
      if (Math.abs(y - startY) < DRAG_THRESHOLD_PX) return;
      // A drag on the alternate screen has nothing to scroll — hand the
      // gesture back to the browser rather than swallowing it.
      if (onAlternateBuffer()) {
        tracking = false;
        return;
      }
      dragging = true;
      lastY = y;
      lastT = t;
    }

    const dy = y - lastY;
    const dt = Math.max(1, t - lastT);
    velocity = dy / dt;
    lastY = y;
    lastT = t;

    scrollByPixels(dy);
    // We're handling this gesture, so stop the browser from also treating it
    // as a page pan / pull-to-refresh.
    if (e.cancelable) e.preventDefault();
  };

  const onTouchEnd = () => {
    if (dragging && Math.abs(velocity) >= MIN_FLING_VELOCITY) {
      stopGlide();
      frame = requestAnimationFrame(glide);
    }
    tracking = false;
    dragging = false;
  };

  // `passive: false` is what makes preventDefault() possible on touchmove.
  container.addEventListener('touchstart', onTouchStart, { passive: true });
  container.addEventListener('touchmove', onTouchMove, { passive: false });
  container.addEventListener('touchend', onTouchEnd, { passive: true });
  container.addEventListener('touchcancel', onTouchEnd, { passive: true });

  return () => {
    stopGlide();
    container.removeEventListener('touchstart', onTouchStart);
    container.removeEventListener('touchmove', onTouchMove);
    container.removeEventListener('touchend', onTouchEnd);
    container.removeEventListener('touchcancel', onTouchEnd);
  };
}

export default attachTouchScroll;
