import { useMemo, useRef, useState } from 'react';

/**
 * MetricChart — a full-size line chart for one resource series.
 *
 * Inline SVG, like Sparkline: this app deliberately carries no chart
 * library, and the shapes it needs (one line, a soft fill, a hover readout)
 * are a few dozen lines of geometry. Gaps are drawn as gaps — a window the
 * collector missed must not be joined by a straight line, which would read
 * as "steady" when the truth is "no data".
 *
 * @param {{at: string, value: number|null}[]} points  already bucketed by the API
 */

const COLORS = {
  primary: { stroke: 'hsl(var(--primary))', fill: 'hsl(var(--primary) / 0.12)' },
  violet: { stroke: 'rgb(139 92 246)', fill: 'rgb(139 92 246 / 0.12)' },
  amber: { stroke: 'rgb(245 158 11)', fill: 'rgb(245 158 11 / 0.12)' },
  emerald: { stroke: 'rgb(16 185 129)', fill: 'rgb(16 185 129 / 0.12)' },
};

const PAD = { top: 10, right: 12, bottom: 22, left: 40 };

function niceMax(values, unit) {
  if (unit === '%') return 100;
  const hi = Math.max(1, ...values);
  const mag = 10 ** Math.floor(Math.log10(hi));
  return Math.ceil(hi / mag) * mag;
}

function MetricChart({
  points = [],
  color = 'primary',
  unit = '%',
  height = 180,
  formatTime = (d) => new Date(d).toLocaleString(),
}) {
  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [width, setWidth] = useState(720);

  // Width follows the container; a ResizeObserver avoids a render loop that
  // measuring during render would cause.
  const setRef = (el) => {
    wrapRef.current = el;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.max(240, Math.round(entry.contentRect.width));
      setWidth((prev) => (Math.abs(prev - w) > 2 ? w : prev));
    });
    ro.observe(el);
  };

  const geom = useMemo(() => {
    const values = points.map((p) => p.value).filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
    if (values.length === 0) return null;

    const innerW = Math.max(1, width - PAD.left - PAD.right);
    const innerH = Math.max(1, height - PAD.top - PAD.bottom);
    const max = niceMax(values, unit);
    const t0 = new Date(points[0].at).getTime();
    const t1 = new Date(points[points.length - 1].at).getTime();
    const span = Math.max(1, t1 - t0);

    const x = (at) => PAD.left + ((new Date(at).getTime() - t0) / span) * innerW;
    const y = (v) => PAD.top + innerH - (v / (max || 1)) * innerH;

    const segments = [];
    let cur = [];
    for (const p of points) {
      if (p.value === null || p.value === undefined || Number.isNaN(p.value)) {
        if (cur.length > 1) segments.push(cur);
        cur = [];
        continue;
      }
      cur.push({ x: x(p.at), y: y(p.value), at: p.at, value: p.value });
    }
    if (cur.length > 1) segments.push(cur);
    // A single isolated sample still deserves a dot.
    const singles = points
      .filter((p) => p.value !== null && p.value !== undefined)
      .map((p) => ({ x: x(p.at), y: y(p.value), at: p.at, value: p.value }));

    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ v: max * f, y: y(max * f) }));

    return { innerW, innerH, max, segments, singles, ticks, t0, t1 };
  }, [points, width, height, unit]);

  if (!geom) {
    return (
      <div
        ref={setRef}
        className="flex items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground"
        style={{ height }}
      >
        No samples in this range
      </div>
    );
  }

  const c = COLORS[color] || COLORS.primary;

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    let best = null;
    for (const p of geom.singles) {
      const d = Math.abs(p.x - px);
      if (!best || d < best.d) best = { d, p };
    }
    setHover(best && best.d < 40 ? best.p : null);
  };

  const fmt = (v) => (unit === '%' ? `${v.toFixed(1)}%` : v.toFixed(2));

  return (
    <div ref={setRef} className="relative">
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
      >
        {geom.ticks.map((t) => (
          <g key={t.v}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={t.y}
              y2={t.y}
              className="stroke-border"
              strokeWidth="1"
              strokeDasharray="2 3"
            />
            <text x={PAD.left - 6} y={t.y + 3} textAnchor="end" className="fill-muted-foreground text-[9px]">
              {unit === '%' ? `${Math.round(t.v)}%` : Math.round(t.v * 100) / 100}
            </text>
          </g>
        ))}

        {geom.segments.map((seg, i) => {
          const line = seg.map((p) => `${p.x},${p.y}`).join(' ');
          const area = `${seg[0].x},${PAD.top + geom.innerH} ${line} ${seg[seg.length - 1].x},${PAD.top + geom.innerH}`;
          return (
            <g key={i}>
              <polygon points={area} fill={c.fill} stroke="none" />
              <polyline
                points={line}
                fill="none"
                stroke={c.stroke}
                strokeWidth="1.75"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          );
        })}

        {geom.singles.length === 1 && (
          <circle cx={geom.singles[0].x} cy={geom.singles[0].y} r="3" fill={c.stroke} />
        )}

        <text x={PAD.left} y={height - 6} className="fill-muted-foreground text-[9px]">
          {formatTime(geom.t0)}
        </text>
        <text x={width - PAD.right} y={height - 6} textAnchor="end" className="fill-muted-foreground text-[9px]">
          {formatTime(geom.t1)}
        </text>

        {hover && (
          <g>
            <line
              x1={hover.x}
              x2={hover.x}
              y1={PAD.top}
              y2={PAD.top + geom.innerH}
              className="stroke-muted-foreground/40"
              strokeWidth="1"
            />
            <circle cx={hover.x} cy={hover.y} r="3.5" fill={c.stroke} />
          </g>
        )}
      </svg>

      {hover && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-md border border-border bg-popover px-2 py-1 text-[11px] shadow-md"
          style={{ left: `${(hover.x / width) * 100}%`, top: `${(hover.y / height) * 100}%` }}
        >
          <p className="font-medium tabular-nums text-foreground">{fmt(hover.value)}</p>
          <p className="whitespace-nowrap text-muted-foreground">{formatTime(hover.at)}</p>
        </div>
      )}
    </div>
  );
}

export default MetricChart;
