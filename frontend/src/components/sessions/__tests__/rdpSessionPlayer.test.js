import { describe, it, expect } from 'vitest';
import { formatMs } from '../RdpSessionPlayer.jsx';

describe('formatMs', () => {
  it('formats whole minutes and seconds', () => {
    expect(formatMs(0)).toBe('0:00');
    expect(formatMs(9_000)).toBe('0:09');
    expect(formatMs(65_000)).toBe('1:05');
    expect(formatMs(600_000)).toBe('10:00');
  });

  // Guacamole reports duration only once it has parsed that far, so the
  // player asks for a position before it knows a duration. Neither may render
  // as "NaN:NaN" in the middle of the controls.
  it('survives the values the player actually starts with', () => {
    expect(formatMs(undefined)).toBe('0:00');
    expect(formatMs(null)).toBe('0:00');
    expect(formatMs(NaN)).toBe('0:00');
    expect(formatMs(-1)).toBe('0:00');
    expect(formatMs(Infinity)).toBe('0:00');
  });

  it('truncates rather than rounding, so the clock never shows a second early', () => {
    expect(formatMs(1_999)).toBe('0:01');
    expect(formatMs(59_999)).toBe('0:59');
  });
});
