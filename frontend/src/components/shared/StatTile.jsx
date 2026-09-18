/**
 * StatTile — small equal-width stat card used inside detail sheets/modals
 * (e.g. Keystore key/identity detail: Identities / Servers / Exports).
 * Deliberately smaller and chrome-free compared to dashboard MetricCard —
 * no icon tile, no accent color, just label + number, so a row of 2-3
 * tiles reads as one quiet strip under the header.
 */
function StatTile({ label, value, className = 'flex-1' }) {
  return (
    <div className={`flex flex-col items-start gap-0.5 rounded-md border border-border bg-muted/30 px-3 py-2.5 ${className}`}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  );
}

export default StatTile;
