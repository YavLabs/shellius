/**
 * Shared HTTP for the directory adapters: a timeout, a page cap, and the
 * insistence that a failed read is a failed read.
 *
 * The page cap exists because every one of these APIs pages, and a paging bug
 * that silently stops early looks exactly like a directory that has shrunk.
 * Hitting the cap is therefore an error, not a quiet truncation.
 */

import { DirectoryFetchError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 20_000;
/** 200 pages at 100–999 per page is far past any real directory. */
export const MAX_PAGES = 200;

export async function fetchJson(url, { headers = {}, method = 'GET', body = null, timeoutMs = DEFAULT_TIMEOUT_MS, label = 'directory' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'error' });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new DirectoryFetchError(`${label} did not respond within ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new DirectoryFetchError(`${label} could not be reached: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    // The body often carries the actual reason (expired secret, missing
    // scope). Keep it short — it is shown to an admin and stored on the run.
    const detail = text ? ` — ${text.slice(0, 300)}` : '';
    throw new DirectoryFetchError(`${label} returned ${res.status}${detail}`, { status: res.status });
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new DirectoryFetchError(`${label} returned a response that was not JSON`);
  }
}

/** Guard every pager with the same "this should have ended by now" rule. */
export function assertPageBudget(pages, label) {
  if (pages >= MAX_PAGES) {
    throw new DirectoryFetchError(`${label} returned more than ${MAX_PAGES} pages — refusing to trust a partial directory`);
  }
}

export default { fetchJson, assertPageBudget, MAX_PAGES };
