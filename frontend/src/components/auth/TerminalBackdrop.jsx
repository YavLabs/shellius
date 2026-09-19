import { useMemo } from 'react';

/**
 * TerminalBackdrop — alternate auth-page background: faint panes of
 * Shellius-flavoured terminal output drifting upward (brand Sky/Lavender on
 * the indigo + plum bloom), masked clear behind the form. Pure CSS
 * animation (.term-* in index.css); stops for prefers-reduced-motion.
 */

const HOSTS = ['prod-db-01', 'api-02.acme', 'bastion.stark', 'stg-web-01', 'worker-07', 'cache-12.wayne', 'queue-04.stg', 'edge-03.globex'];
const USERS = ['d.kim', 'a.rivera', 'p.sharma', 'j.oconnor', 'm.chen', 'deploy', 'ops'];
const IPS = ['10.20.1.11', '10.20.1.12', '10.44.0.2', '10.31.4.20', '10.42.8.7', '10.45.3.12', '10.22.4.17'];

function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

// Each line: [kind, text]. kind picks the colour (prompt / ok / info / dim).
function linesFor(seed, count) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const out = [];
  for (let i = 0; i < count; i++) {
    const host = pick(HOSTS);
    const user = pick(USERS);
    const ip = pick(IPS);
    const t = `${String(8 + Math.floor(r() * 12)).padStart(2, '0')}:${String(Math.floor(r() * 60)).padStart(2, '0')}:${String(Math.floor(r() * 60)).padStart(2, '0')}`;
    const n = Math.floor(r() * 9);
    if (n === 0) out.push(['prompt', `$ shellius connect ${host}`]);
    else if (n === 1) out.push(['ok', `✓ certificate issued · ed25519 · valid 1h · ${user}@${host}`]);
    else if (n === 2) out.push(['info', `→ access request #${4800 + Math.floor(r() * 90)} approved by ${pick(USERS)}`]);
    else if (n === 3) out.push(['prompt', `$ ssh ${user}@${ip}`]);
    else if (n === 4) out.push(['dim', `${t}  session ${Math.random().toString(16).slice(2, 8)} recorded · ${host}`]);
    else if (n === 5) out.push(['dim', `Last login: ${t} from ${pick(IPS)}`]);
    else if (n === 6) out.push(['info', `[prod] ${host}: check-principals ok (${user})`]);
    else if (n === 7) out.push(['prompt', `$ systemctl status ${pick(['nginx', 'payments-api', 'postgresql', 'redis'])}`]);
    else out.push(['ok', `● active (running) since ${t} · ${host}`]);
  }
  return out;
}

const PANES = [
  { seed: 7, cls: 'term-pane-1' },
  { seed: 19, cls: 'term-pane-2' },
  { seed: 31, cls: 'term-pane-3' },
  { seed: 43, cls: 'term-pane-4' },
];

export default function TerminalBackdrop() {
  const panes = useMemo(() => PANES.map((p) => ({ ...p, lines: linesFor(p.seed, 36) })), []);
  return (
    <div className="term-backdrop absolute inset-0" aria-hidden="true">
      {panes.map((p) => (
        <div key={p.cls} className={`term-pane ${p.cls}`}>
          {/* Content twice, scrolled by exactly half, loops seamlessly. */}
          <div className="term-scroll">
            {[0, 1].map((copy) =>
              p.lines.map(([kind, text], i) => (
                <div key={`${copy}-${i}`} className={`term-line term-${kind}`}>
                  {text}
                </div>
              ))
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
