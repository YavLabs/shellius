/**
 * Quick Connect "recent connections" — localStorage only, capped at 8 entries.
 * NEVER stores secrets (password / private key / passphrase) — only enough to
 * refill the form: host, port, username, identityId.
 */
const STORAGE_KEY = 'shellius.quickConnect.recent';
const MAX_ENTRIES = 8;

export function getRecentConnections() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function addRecentConnection({ host, port, username, identityId }) {
  if (!host) return;
  try {
    const existing = getRecentConnections();
    const entry = { host, port: port || 22, username: username || '', identityId: identityId || null };
    const deduped = existing.filter(
      (e) => !(e.host === entry.host && e.port === entry.port && e.username === entry.username)
    );
    const next = [entry, ...deduped].slice(0, MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore storage errors (quota, private mode, etc.) */
  }
}
