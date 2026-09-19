import { useId, useMemo } from 'react';

/**
 * FlowRing — an organic, lobed ring (think a soft squircle torus) drawn as a
 * thick gradient stroke that slowly morphs between a few shapes, so it looks
 * like it's flowing. Pure SVG: the outline is a smooth closed path through
 * points on r(θ); SMIL <animate> interpolates between keyframe paths (all
 * built from the same number of points, so they morph cleanly). Blur and
 * placement come from CSS (.auth-ring in index.css).
 *
 *   colors  three gradient stops
 *   seed    varies the shape and timing per ring
 *   dur     seconds for one full morph cycle
 *   scale   base size multiplier (AuthShell randomises it per visit)
 */

const POINTS = 48;

// Deterministic pseudo-random from a seed.
function rng(seed) {
  let s = seed * 9301 + 49297;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

// Radius at angle t for one keyframe: a 4-lobed base (the "squircle"
// feel from the reference) plus a couple of slower harmonics for irregularity.
function shape(t, k) {
  return (
    56 +
    k.a4 * Math.cos(4 * t + k.p4) +
    k.a3 * Math.cos(3 * t + k.p3) +
    k.a2 * Math.cos(2 * t + k.p2) +
    k.a5 * Math.sin(5 * t + k.p5)
  );
}

// Closed Catmull-Rom spline through the points, as cubic Béziers.
function pathFor(k) {
  const pts = [];
  for (let i = 0; i < POINTS; i++) {
    const t = (i / POINTS) * Math.PI * 2;
    const r = shape(t, k);
    pts.push([100 + r * Math.cos(t), 100 + r * Math.sin(t)]);
  }
  const f = (n) => n.toFixed(2);
  let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
  for (let i = 0; i < POINTS; i++) {
    const p0 = pts[(i - 1 + POINTS) % POINTS];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % POINTS];
    const p3 = pts[(i + 2) % POINTS];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${f(c1[0])},${f(c1[1])} ${f(c2[0])},${f(c2[1])} ${f(p2[0])},${f(p2[1])}`;
  }
  return `${d} Z`;
}

function keyframes(seed) {
  const r = rng(seed);
  const frames = [];
  for (let i = 0; i < 4; i++) {
    frames.push({
      // Organic, irregular loop: slow 2- and 3-lobe undulations do most of
      // the shaping, with a softer 4-lobe hint from the reference — at random
      // phases, so no ring reads as a square, circle or star.
      a4: 2 + r() * 3,
      p4: r() * Math.PI * 2,
      a3: 4 + r() * 5,
      p3: r() * Math.PI * 2,
      a2: 5 + r() * 7,
      p2: r() * Math.PI * 2,
      a5: r() * 1.5,
      p5: r() * Math.PI * 2,
    });
  }
  const paths = frames.map(pathFor);
  return [...paths, paths[0]]; // loop back to the start
}

export default function FlowRing({ colors, seed = 1, dur = 40, scale = 1, className }) {
  const id = useId().replace(/:/g, '');
  const paths = useMemo(() => keyframes(seed), [seed]);
  // Slow "breathing": each ring grows and shrinks by its own range.
  const breathe = useMemo(() => {
    const r = rng(seed + 101);
    const lo = 0.7 + r() * 0.15;
    const hi = 1.12 + r() * 0.2;
    const mid = 0.9 + r() * 0.1;
    return `1;${hi.toFixed(3)};${mid.toFixed(3)};${lo.toFixed(3)};1`;
  }, [seed]);
  const splines = paths
    .slice(1)
    .map(() => '0.45 0 0.55 1')
    .join(';');
  return (
    <svg viewBox="0 0 200 200" overflow="visible" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={colors[0]} />
          <stop offset="55%" stopColor={colors[1]} />
          <stop offset="100%" stopColor={colors[2]} />
          <animateTransform
            attributeName="gradientTransform"
            type="rotate"
            values="0 0.5 0.5;360 0.5 0.5"
            dur={`${dur * 1.5}s`}
            repeatCount="indefinite"
          />
        </linearGradient>
      </defs>
      <g transform={`translate(100 100) scale(${scale.toFixed(3)})`}>
        <g>
          <animateTransform
            attributeName="transform"
            type="scale"
            values={breathe}
            dur={`${Math.round(dur * 1.3)}s`}
            calcMode="spline"
            keyTimes="0;0.25;0.5;0.75;1"
            keySplines="0.45 0 0.55 1;0.45 0 0.55 1;0.45 0 0.55 1;0.45 0 0.55 1"
            repeatCount="indefinite"
          />
          <g transform="translate(-100 -100)">
      <path d={paths[0]} fill="none" stroke={`url(#g${id})`} strokeWidth="34" strokeLinejoin="round">
        <animate
          attributeName="d"
          values={paths.join(';')}
          dur={`${dur}s`}
          calcMode="spline"
          keyTimes={paths.map((_, i) => (i / (paths.length - 1)).toFixed(3)).join(';')}
          keySplines={splines}
          repeatCount="indefinite"
        />
      </path>
          </g>
        </g>
      </g>
    </svg>
  );
}
