/**
 * Page header actions (docs/plans/1.5.1-mobile.md §2).
 *
 * Pages pass PageHeader an `actions` array instead of (or next to) button
 * children. Each action:
 *
 *   key        unique id
 *   label      button text
 *   icon       Lucide icon component (optional)
 *   onClick    handler (omit when the action is a menu, see `items`)
 *   variant    Button variant — 'default' (gradient, the default),
 *              'outline', 'destructive', …
 *   primary    true marks the page's primary action (mobile: full-width
 *              button under the subtitle). Without one, the last action with
 *              the default variant is primary.
 *   hidden     true drops it (permission checks inline in the array)
 *   disabled, spin (spinning icon, e.g. Refresh while loading)
 *   items      [{ key, label, icon, onClick, checked, destructive }] — a menu
 *              (desktop dropdown / mobile overflow entries)
 *   desktop    optional node rendered on desktop instead of the default
 *              button (keeps a bespoke desktop control as it was)
 *   mobile     false keeps it off the mobile header
 *
 * Pure helpers only; the rendering lives in components/common/PageHeader.jsx.
 */

const isPrimaryVariant = (a) => !a.variant || a.variant === 'default';

/** Actions that are not hidden, in order. */
export function visibleActions(actions) {
  return (actions || []).filter((a) => a && !a.hidden);
}

/**
 * Split actions for the mobile header: { primary, secondary }.
 * An explicitly marked primary wins; otherwise the last default-variant
 * action (the gradient button) is primary. Everything else is secondary
 * (the "⋯" overflow menu). A menu action (`items`) is never primary.
 */
export function splitActions(actions) {
  const list = visibleActions(actions).filter((a) => a.mobile !== false);
  let primary = list.find((a) => a.primary && !a.items) || null;
  if (!primary) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (!list[i].items && isPrimaryVariant(list[i])) {
        primary = list[i];
        break;
      }
    }
  }
  return { primary, secondary: list.filter((a) => a !== primary) };
}

/**
 * Entries for the mobile overflow menu: plain actions become one entry;
 * menu actions contribute their items, grouped under the action's label.
 */
export function overflowEntries(secondary) {
  const entries = [];
  for (const a of secondary || []) {
    if (a.items) {
      const items = a.items.filter((i) => i && !i.hidden);
      if (items.length === 0) continue;
      entries.push({ type: 'label', key: `${a.key}-label`, label: a.label });
      for (const i of items) {
        entries.push({ type: 'item', key: `${a.key}-${i.key}`, ...i, disabled: a.disabled || i.disabled });
      }
    } else {
      entries.push({
        type: 'item',
        key: a.key,
        label: a.label,
        icon: a.icon,
        onClick: a.onClick,
        disabled: a.disabled,
        destructive: a.variant === 'destructive',
        spin: a.spin,
      });
    }
  }
  return entries;
}
