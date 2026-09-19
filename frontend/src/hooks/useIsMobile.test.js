import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import useIsMobile, { MOBILE_QUERY } from './useIsMobile';

// No DOM test environment here: render once on the server and read the
// hook's first value (the effect that follows resizes doesn't run there).
function firstValue() {
  let value;
  function Probe() {
    value = useIsMobile();
    return null;
  }
  renderToString(createElement(Probe));
  return value;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useIsMobile', () => {
  it('uses the md breakpoint query', () => {
    expect(MOBILE_QUERY).toBe('(max-width: 767px)');
  });

  it('is false without a window (SSR-safe)', () => {
    expect(firstValue()).toBe(false);
  });

  it('follows matchMedia for the first render', () => {
    const matchMedia = vi.fn((q) => ({ matches: q === MOBILE_QUERY, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal('window', { matchMedia });
    expect(firstValue()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith(MOBILE_QUERY);

    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    expect(firstValue()).toBe(false);
  });

  it('is false when matchMedia is unavailable', () => {
    vi.stubGlobal('window', {});
    expect(firstValue()).toBe(false);
  });
});
