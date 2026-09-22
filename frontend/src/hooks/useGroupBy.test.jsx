import { afterEach, describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import useGroupBy from './useGroupBy';

const OPTIONS = [
  { value: 'batch', label: 'Export run' },
  { value: 'status', label: 'Status' },
];
const KEY = 'test.useGroupBy.default';

function Probe({ onKeys, defaultKeys }) {
  const [keys] = useGroupBy(KEY, OPTIONS, { defaultKeys });
  onKeys(keys);
  return null;
}

function run(url, defaultKeys) {
  let last = [];
  render(
    <MemoryRouter initialEntries={[url]}>
      <Probe defaultKeys={defaultKeys} onKeys={(k) => (last = k)} />
    </MemoryRouter>
  );
  return () => last;
}

afterEach(() => localStorage.clear());

describe('useGroupBy defaultKeys', () => {
  it('applies the default on a first visit (no ?group=, nothing remembered)', async () => {
    const keys = run('/x', ['batch']);
    await waitFor(() => expect(keys()).toEqual(['batch']));
    // Not remembered: a later change of default still applies.
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('a remembered "flat" choice beats the default', async () => {
    localStorage.setItem(KEY, '');
    const keys = run('/x', ['batch']);
    await new Promise((r) => setTimeout(r, 0));
    expect(keys()).toEqual([]);
  });

  it('remembered levels and the URL beat the default', async () => {
    localStorage.setItem(KEY, 'status');
    const remembered = run('/x', ['batch']);
    await waitFor(() => expect(remembered()).toEqual(['status']));

    localStorage.clear();
    const fromUrl = run('/x?group=status,batch', ['batch']);
    await waitFor(() => expect(fromUrl()).toEqual(['status', 'batch']));
  });

  it('without defaultKeys it behaves as before (flat)', async () => {
    const keys = run('/x');
    await new Promise((r) => setTimeout(r, 0));
    expect(keys()).toEqual([]);
  });
});
