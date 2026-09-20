/**
 * The arithmetic behind the shared filter drawer.
 *
 * Small on purpose, and in lib rather than in the component, because these
 * are the parts that decide what the UI CLAIMS: the number on the chip, and
 * what "Clear all" actually clears. Both are easy to get subtly wrong —
 * counting a filter whose value is the empty string, or clearing keys the
 * caller never declared and so wiping unrelated state.
 */

/** Is this value narrowing anything? */
export function isFilterSet(value) {
  return value !== undefined && value !== null && value !== '' && value !== false;
}

/** The defs whose value is currently set, in declaration order. */
export function appliedFilters(defs = [], values = {}) {
  return (defs || []).filter((d) => d && isFilterSet(values?.[d.key]));
}

/** How many filters are narrowing the list. */
export function appliedFilterCount(defs = [], values = {}) {
  return appliedFilters(defs, values).length;
}

/**
 * "Clear all", as a value object.
 *
 * Only the declared keys are reset, and each to '' rather than dropped:
 * pages spread this straight into their own state, and a missing key would
 * read as "unchanged" instead of "cleared".
 */
export function clearedFilterValues(defs = []) {
  return Object.fromEntries((defs || []).filter(Boolean).map((d) => [d.key, '']));
}

export default { isFilterSet, appliedFilters, appliedFilterCount, clearedFilterValues };
