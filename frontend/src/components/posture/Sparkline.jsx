/**
 * Sparkline — inline SVG only (no chart library), matching the app's
 * existing metric cards: a thin line, a soft area fill and the current
 * value picked out at the end. `points` is an array of numbers (nulls
 * allowed for gaps); `max` defaults to the data's own max (100 for percents).
 */
const COLORS = {
  primary: { stroke: 'stroke-primary', fill: 'fill-primary/10', dot: 'fill-primary' },
  emerald: { stroke: 'stroke-emerald-500', fill: 'fill-emerald-500/10', dot: 'fill-emerald-500' },
  amber: { stroke: 'stroke-amber-500', fill: 'fill-amber-500/10', dot: 'fill-amber-500' },
  violet: { stroke: 'stroke-violet-500', fill: 'fill-violet-500/10', dot: 'fill-violet-500' },
};

function Sparkline({ points = [], max = 100, height = 32, width = 120, color = 'primary', formatValue }) {
  const values = points.filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  const c = COLORS[color] || COLORS.primary;

  if (values.length < 2) {
    return (
      <div className="flex items-center justify-center text-xs text-muted-foreground" style={{ height, width }}>
        Not enough data
      </div>
    );
  }

  const hi = Math.max(max, ...values);
  const lo = 0;
  const stepX = width / (points.length - 1);
  const y = (v) => height - ((v - lo) / (hi - lo || 1)) * (height - 4) - 2;

  // Break the line at gaps (null samples) instead of interpolating over them.
  const segments = [];
  let current = [];
  points.forEach((v, i) => {
    if (v === null || v === undefined || Number.isNaN(v)) {
      if (current.length) segments.push(current);
      current = [];
      return;
    }
    current.push([i * stepX, y(v)]);
  });
  if (current.length) segments.push(current);

  const last = values[values.length - 1];
  const lastIdx = [...points].reverse().findIndex((v) => v !== null && v !== undefined && !Number.isNaN(v));
  const lastX = (points.length - 1 - lastIdx) * stepX;
  const lastY = y(last);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="overflow-visible">
      {segments.map((seg, i) => {
        const line = seg.map((p) => p.join(',')).join(' ');
        const area = `${seg[0][0]},${height} ${line} ${seg[seg.length - 1][0]},${height}`;
        return (
          <g key={i}>
            <polygon points={area} className={c.fill} stroke="none" />
            <polyline points={line} className={c.stroke} fill="none" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
          </g>
        );
      })}
      <circle cx={lastX} cy={lastY} r="2.25" className={c.dot} />
      {formatValue && (
        <title>{formatValue(last)}</title>
      )}
    </svg>
  );
}

export default Sparkline;
