/**
 * The app's modal detail row — a 3-column grid with the label in column one
 * and the value left-aligned across columns two and three, separated by a
 * hairline (see the Session details modal, which this matches).
 *
 * Left-aligned on purpose: right-aligned values push long strings — a unit
 * name, a compose path — against the panel edge and make every row start at
 * a different x, so the column is unreadable at a glance and the longest
 * value is the one that clips. `break-all` lets those wrap instead.
 */
export function DetailRow({ label, value, mono }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    // Stacked on a phone: a third of a 340px sheet is not a column, it is a
    // place for "REACHABILITY" to become three lines beside a one-word value.
    <div className="border-b border-border py-2.5 last:border-0 sm:grid sm:grid-cols-3 sm:gap-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground sm:col-span-1">
        {label}
      </dt>
      <dd className={`mt-0.5 break-all text-sm text-foreground sm:col-span-2 sm:mt-0 ${mono ? 'font-mono text-xs' : ''}`}>
        {value}
      </dd>
    </div>
  );
}

/** A titled group of DetailRows. No nested card — the modal is the card. */
export function DetailSection({ title, children, className = '' }) {
  return (
    <section className={className}>
      <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {title}
      </h4>
      <dl>{children}</dl>
    </section>
  );
}

export default DetailRow;
