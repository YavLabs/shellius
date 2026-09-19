import { describe, it, expect } from 'vitest';
import {
  dragOffset,
  shouldDismiss,
  keyboardInset,
  DISMISS_DISTANCE,
  FLICK_MIN_DISTANCE,
} from './sheetGesture';

describe('dragOffset', () => {
  it('follows downward drags 1:1', () => {
    expect(dragOffset(0)).toBe(0);
    expect(dragOffset(42)).toBe(42);
  });
  it('ignores upward drags and junk', () => {
    expect(dragOffset(-30)).toBe(0);
    expect(dragOffset(NaN)).toBe(0);
    expect(dragOffset(undefined)).toBe(0);
  });
});

describe('shouldDismiss', () => {
  it('closes once dragged past the fixed distance on a tall sheet', () => {
    expect(shouldDismiss({ dy: DISMISS_DISTANCE, dt: 2000, height: 700 })).toBe(true);
    expect(shouldDismiss({ dy: DISMISS_DISTANCE - 1, dt: 2000, height: 700 })).toBe(false);
  });
  it('uses a fraction of the height on short sheets', () => {
    // 200px sheet → 70px is enough
    expect(shouldDismiss({ dy: 70, dt: 2000, height: 200 })).toBe(true);
    expect(shouldDismiss({ dy: 60, dt: 2000, height: 200 })).toBe(false);
  });
  it('closes on a quick flick', () => {
    expect(shouldDismiss({ dy: 40, dt: 50, height: 700 })).toBe(true);
  });
  it('never closes on a tap or a tiny fast jitter', () => {
    expect(shouldDismiss({ dy: 0, dt: 10, height: 700 })).toBe(false);
    expect(shouldDismiss({ dy: FLICK_MIN_DISTANCE - 1, dt: 5, height: 700 })).toBe(false);
  });
  it('never closes on an upward drag', () => {
    expect(shouldDismiss({ dy: -300, dt: 100, height: 700 })).toBe(false);
  });
  it('falls back to the fixed distance when the height is unknown', () => {
    expect(shouldDismiss({ dy: 119, dt: 2000, height: 0 })).toBe(false);
    expect(shouldDismiss({ dy: 120, dt: 2000, height: 0 })).toBe(true);
  });
});

describe('keyboardInset', () => {
  it('is 0 without a keyboard', () => {
    expect(keyboardInset({ innerHeight: 844, viewportHeight: 844, offsetTop: 0 })).toBe(0);
  });
  it('is the covered height when the keyboard is open', () => {
    expect(keyboardInset({ innerHeight: 844, viewportHeight: 508, offsetTop: 0 })).toBe(336);
  });
  it('accounts for a scrolled visual viewport (iOS)', () => {
    expect(keyboardInset({ innerHeight: 844, viewportHeight: 508, offsetTop: 120 })).toBe(216);
  });
  it('never goes negative and tolerates bad input', () => {
    expect(keyboardInset({ innerHeight: 800, viewportHeight: 820, offsetTop: 0 })).toBe(0);
    expect(keyboardInset({ innerHeight: 800, viewportHeight: undefined })).toBe(0);
  });
});
