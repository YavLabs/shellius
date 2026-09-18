/**
 * Command palette "Recent" section — localStorage only, capped at 5 entries.
 * Stores just enough to render + navigate: id, type, title, subtitle, href.
 * Never stores secrets or full result payloads.
 */
const STORAGE_KEY = 'shellius.palette.recent';
const MAX_ENTRIES = 5;

export function getRecentPaletteResults() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function addRecentPaletteResult({ id, type, title, subtitle, href }) {
  if (!id || !href) return;
  try {
    const existing = getRecentPaletteResults();
    const entry = { id, type, title, subtitle: subtitle || '', href };
    const deduped = existing.filter((e) => !(e.id === id && e.type === type));
    const next = [entry, ...deduped].slice(0, MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore storage errors (quota, private mode, etc.) */
  }
}
