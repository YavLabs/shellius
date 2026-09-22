import api from './api';

/**
 * Options for a filter picker — see backend routes/lookup.js.
 * @param {'servers'|'customers'|'users'} kind
 * @param {{ q?: string, ids?: string[] }} opts
 * @returns {Promise<Array<{ value, label, sublabel }>>}
 */
export async function lookup(kind, { q = '', ids = [] } = {}) {
  const params = { limit: 25 };
  if (q) params.q = q;
  if (ids.length) params.ids = ids.join(',');
  const { data } = await api.get(`/lookup/${kind}`, { params });
  return data?.data?.items || [];
}

export default { lookup };
