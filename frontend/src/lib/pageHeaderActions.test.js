import { describe, expect, it } from 'vitest';
import { overflowEntries, splitActions, visibleActions } from './pageHeaderActions';

const refresh = { key: 'refresh', label: 'Refresh', variant: 'outline' };
const add = { key: 'add', label: 'Add server' };
const exportMenu = {
  key: 'export',
  label: 'Export',
  variant: 'outline',
  items: [
    { key: 'csv', label: 'Export as CSV' },
    { key: 'json', label: 'Export as JSON' },
  ],
};

describe('splitActions', () => {
  it('makes the last gradient (default-variant) action primary when none is marked', () => {
    const { primary, secondary } = splitActions([refresh, add]);
    expect(primary.key).toBe('add');
    expect(secondary.map((a) => a.key)).toEqual(['refresh']);
  });

  it('honours an explicitly marked primary', () => {
    const { primary, secondary } = splitActions([{ ...refresh, primary: true }, add]);
    expect(primary.key).toBe('refresh');
    expect(secondary.map((a) => a.key)).toEqual(['add']);
  });

  it('has no primary when every action is secondary-styled', () => {
    const edit = { key: 'edit', label: 'Edit', variant: 'outline' };
    const del = { key: 'delete', label: 'Delete', variant: 'destructive' };
    const { primary, secondary } = splitActions([edit, del]);
    expect(primary).toBeNull();
    expect(secondary).toHaveLength(2);
  });

  it('drops hidden and desktop-only actions, and never makes a menu primary', () => {
    const { primary, secondary } = splitActions([
      { ...add, hidden: true },
      { key: 'qc', label: 'Quick connect', mobile: false },
      { ...exportMenu, variant: undefined },
    ]);
    expect(primary).toBeNull();
    expect(secondary.map((a) => a.key)).toEqual(['export']);
    expect(splitActions(undefined)).toEqual({ primary: null, secondary: [] });
  });

  it('visibleActions keeps order and drops hidden/empty entries', () => {
    expect(visibleActions([refresh, null, { ...add, hidden: true }]).map((a) => a.key)).toEqual(['refresh']);
  });
});

describe('overflowEntries', () => {
  it('lists plain actions and flattens menus under their label', () => {
    const entries = overflowEntries([refresh, exportMenu, { key: 'del', label: 'Delete', variant: 'destructive' }]);
    expect(entries.map((e) => [e.type, e.label])).toEqual([
      ['item', 'Refresh'],
      ['label', 'Export'],
      ['item', 'Export as CSV'],
      ['item', 'Export as JSON'],
      ['item', 'Delete'],
    ]);
    expect(entries.at(-1).destructive).toBe(true);
    expect(new Set(entries.map((e) => e.key)).size).toBe(entries.length);
  });

  it('skips empty menus and passes a disabled menu down to its items', () => {
    const entries = overflowEntries([
      { key: 'm', label: 'Menu', items: [{ key: 'a', label: 'A', hidden: true }] },
      { ...exportMenu, disabled: true },
    ]);
    expect(entries[0]).toMatchObject({ type: 'label', label: 'Export' });
    expect(entries.slice(1).every((e) => e.disabled)).toBe(true);
  });
});
