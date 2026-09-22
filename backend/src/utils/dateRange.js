/**
 * The inclusive end of a date filter.
 *
 * Date pickers send a bare day ("2026-09-21"). `new Date('2026-09-21')` is
 * midnight UTC at the START of that day, so `lte` against it excluded the
 * whole day the user picked — "to 21 Sept" returned nothing from the 21st.
 * A bare date means "up to the end of that day"; a full timestamp is taken
 * as given.
 *
 * @param {string|Date} value
 * @returns {Date|null}
 */
export function endOfDayInclusive(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T23:59:59.999Z`);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export default { endOfDayInclusive };
