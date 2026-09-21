import { describe, it, expect } from 'vitest';
import { splitCheckboxClasses } from './checkbox.jsx';

/**
 * The tick and dash are absolute overlays centred on the WRAPPER, while
 * `className` used to land entirely on the input. So `<Checkbox
 * className="ml-2" />` slid the filled square 8px to the right and left its
 * own check behind — visible in the bulk-install host list as checkboxes
 * whose ticks sat outside the box.
 *
 * Margins are a layout concern for the whole control; everything else still
 * belongs to the input.
 */
describe('splitCheckboxClasses', () => {
  it('sends margins to the wrapper and the rest to the input', () => {
    expect(splitCheckboxClasses('ml-2')).toEqual({ wrapper: 'ml-2', input: '' });
    expect(splitCheckboxClasses('h-5 w-5')).toEqual({ wrapper: '', input: 'h-5 w-5' });
    expect(splitCheckboxClasses('ml-2 h-5')).toEqual({ wrapper: 'ml-2', input: 'h-5' });
  });

  it('recognises every margin shape, including negative and responsive', () => {
    for (const c of ['m-0', 'mt-1', 'mr-2', 'mb-3', 'mb-px', 'ml-4', 'mx-2', 'my-1', '-ml-px', 'sm:ml-2', 'md:-mt-1']) {
      expect(splitCheckboxClasses(c).wrapper).toBe(c);
    }
  });

  it('does not mistake other utilities for margins', () => {
    // `min-w-0` and `max-h-4` start with "m" — a lazier regex eats them.
    for (const c of ['min-w-0', 'max-h-4', 'mask-none', 'peer', 'rounded-[4px]', 'bg-muted']) {
      expect(splitCheckboxClasses(c).input).toBe(c);
    }
  });

  it('survives nothing at all', () => {
    expect(splitCheckboxClasses(undefined)).toEqual({ wrapper: '', input: '' });
    expect(splitCheckboxClasses('')).toEqual({ wrapper: '', input: '' });
    expect(splitCheckboxClasses('  ml-2   h-5  ')).toEqual({ wrapper: 'ml-2', input: 'h-5' });
  });
});
