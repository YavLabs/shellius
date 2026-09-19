/**
 * Pure helpers behind the mobile bottom sheet (docs/plans/1.5.1-mobile.md §3):
 * swipe-to-close and keeping the sheet above the on-screen keyboard.
 * No DOM access here so they can be unit tested.
 */

/** Drag distance (px) that always closes the sheet, whatever its height. */
export const DISMISS_DISTANCE = 120;
/** Fraction of the sheet's height that also closes it (short sheets). */
export const DISMISS_FRACTION = 0.35;
/** A flick faster than this (px/ms) closes the sheet... */
export const DISMISS_VELOCITY = 0.6;
/** ...as long as it moved at least this far (px), so a tap never closes. */
export const FLICK_MIN_DISTANCE = 24;

/**
 * How far the sheet follows the finger. Downward drags track 1:1; upward
 * drags don't move it (the sheet is already as tall as it gets).
 */
export function dragOffset(dy) {
  if (!Number.isFinite(dy) || dy <= 0) return 0;
  return dy;
}

/**
 * Whether releasing a drag should close the sheet.
 * @param {{ dy: number, dt: number, height: number }} drag
 *   dy — downward distance in px, dt — gesture duration in ms,
 *   height — the sheet's height in px.
 */
export function shouldDismiss({ dy, dt, height }) {
  if (!Number.isFinite(dy) || dy <= 0) return false;
  const threshold = height > 0
    ? Math.min(DISMISS_DISTANCE, height * DISMISS_FRACTION)
    : DISMISS_DISTANCE;
  if (dy >= threshold) return true;
  const velocity = dt > 0 ? dy / dt : 0;
  return dy >= FLICK_MIN_DISTANCE && velocity >= DISMISS_VELOCITY;
}

/**
 * Height (px) of whatever covers the bottom of the layout viewport — the
 * on-screen keyboard — from `window.visualViewport`. A `position: fixed;
 * bottom: 0` sheet sits at the layout viewport's bottom, so it has to be
 * lifted by this much to stay visible.
 */
export function keyboardInset({ innerHeight, viewportHeight, offsetTop = 0 }) {
  if (![innerHeight, viewportHeight, offsetTop].every(Number.isFinite)) return 0;
  const inset = Math.round(innerHeight - viewportHeight - offsetTop);
  return inset > 0 ? inset : 0;
}
