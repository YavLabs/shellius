/**
 * postureCollector.test.js — the REAL collector script, run against stubbed
 * commands and a fixture /proc, with its JSON validated by the API's own
 * ingest schema.
 *
 * Why this exists: the collector and the API drifted apart three ways and
 * nothing noticed, because each side was only ever tested on its own —
 *   - listeners recovered from the NAT table were sent as source "nat", which
 *     the API's schema did not allow, so a host whose sudo grant worked had
 *     EVERY snapshot refused (400) and "stopped reporting";
 *   - firewall rules were sent beside `firewall` instead of inside it, and
 *     the API dropped every one of them;
 *   - the owner reference was sent as `ownerId`; the API reads `ownerRef`.
 * Every test here ends in `validate()`: whatever else changes, a snapshot
 * the API would refuse fails the build.
 */

import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { postureSchema, normalizePostureSnapshot } from '../hosts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COLLECTOR = path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'posture', 'shellius-posture-collect.sh');

// The only real programs the collector gets. Anything else it looks for
// (ss, iptables, nft, ufw, docker, systemctl, …) exists only if a test stubs
// it — a developer's own firewall must never leak into a fixture.
const REAL_TOOLS = [
  'bash', 'awk', 'sed', 'grep', 'tr', 'cat', 'head', 'tail', 'sort', 'paste', 'cut', 'mktemp', 'rm',
  'date', 'readlink', 'stat', 'id', 'wc', 'basename', 'env', 'xargs', 'find', 'uniq', 'python3',
];

function which(tool) {
  for (const dir of ['/usr/bin', '/bin', '/usr/local/bin']) {
    const p = path.join(dir, tool);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * @param {object} fx
 * @param {Record<string,string>} fx.stubs  command name -> bash body
 * @param {Record<string,object>} fx.procs  pid -> { comm, cmdline[], ppid, uid, cgroup }
 * @param {Record<string,string>} [fx.files] relative path (under the sandbox) -> content
 */
function runCollector({ stubs = {}, procs = {}, files = {}, realProc = false }) {
  const root = mkdtempSync(path.join(tmpdir(), 'posture-collector-'));
  try {
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    for (const tool of REAL_TOOLS) {
      const real = which(tool);
      if (real) symlinkSync(real, path.join(bin, tool));
    }
    const allStubs = {
      // sudo -n <cmd…> → run the (stubbed) command directly.
      sudo: '[ "$1" = "-n" ] && shift\nexec "$@"',
      hostname: 'echo fixture-host',
      logger: 'exit 0',
      ...stubs,
    };
    for (const [name, body] of Object.entries(allStubs)) {
      const p = path.join(bin, name);
      writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(p, 0o755);
    }

    const proc = path.join(root, 'proc');
    mkdirSync(proc);
    for (const [pid, p] of Object.entries(procs)) {
      const d = path.join(proc, String(pid));
      mkdirSync(d);
      writeFileSync(path.join(d, 'comm'), `${p.comm}\n`);
      writeFileSync(path.join(d, 'cmdline'), `${(p.cmdline || [p.comm]).join('\0')}\0`);
      writeFileSync(path.join(d, 'status'), `Name:\t${p.comm}\nPPid:\t${p.ppid ?? 1}\nUid:\t${p.uid ?? 1000}\t${p.uid ?? 1000}\t${p.uid ?? 1000}\t${p.uid ?? 1000}\n`);
      writeFileSync(path.join(d, 'cgroup'), `${p.cgroup || '0::/system.slice/unknown.service'}\n`);
    }

    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(root, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content);
    }

    const res = spawnSync(path.join(bin, 'bash'), [COLLECTOR], {
      env: {
        PATH: bin,
        ...(realProc ? {} : { SHELLIUS_POSTURE_PROC: proc }),
        PM2_HOME: files['pm2/pids/.keep'] !== undefined ? path.join(root, 'pm2') : '',
        HOME: root,
        LANG: 'C',
      },
      encoding: 'utf8',
      timeout: 60000,
    });
    let json = null;
    try {
      json = JSON.parse(res.stdout);
    } catch {
      /* asserted below */
    }
    const sudoLog = existsSync(path.join(root, 'sudo.log')) ? readFileSync(path.join(root, 'sudo.log'), 'utf8') : '';
    return { json, stdout: res.stdout, stderr: res.stderr, status: res.status, root, sudoLog };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The API's verdict on this snapshot — exactly what POST /api/hosts/posture does. */
function validate(json) {
  const { error, value } = postureSchema.validate(json, { abortEarly: false, stripUnknown: true });
  if (error) throw new Error(`API would refuse this snapshot: ${error.details.map((d) => d.message).join('; ')}`);
  return normalizePostureSnapshot(value);
}

const ss = (lines) => `cat <<'EOF'\n${lines.join('\n')}\nEOF`;

describe('posture collector ↔ ingest contract', () => {
  it('a Docker host with a NAT-only publish produces a snapshot the API accepts', () => {
    const { json, stderr } = runCollector({
      stubs: {
        ss: ss([
          'tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=800,fd=3))',
          'tcp LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:* users:(("docker-proxy",pid=900,fd=4))',
        ]),
        iptables: [
          'case "$*" in',
          '  "-t nat -S") printf "%s\\n" "-P PREROUTING ACCEPT" "-A DOCKER ! -i docker0 -p tcp -m tcp --dport 8080 -j DNAT --to-destination 172.17.0.2:80" "-A DOCKER ! -i docker0 -p tcp -m tcp --dport 9000 -j DNAT --to-destination 172.17.0.3:9000" ;;',
          '  "-S INPUT") printf "%s\\n" "-P INPUT ACCEPT" ;;',
          '  *) exit 1 ;;',
          'esac',
        ].join('\n'),
      },
      procs: {
        800: { comm: 'sshd', cmdline: ['sshd:', '/usr/sbin/sshd', '-D'], ppid: 1, uid: 0, cgroup: '0::/system.slice/ssh.service' },
        900: { comm: 'docker-proxy', cmdline: ['/usr/bin/docker-proxy', '-proto', 'tcp', '-host-port', '8080', '-container-ip', '172.17.0.2', '-container-port', '80'], ppid: 1, uid: 0 },
      },
    });
    expect(json).not.toBeNull();
    expect(stderr).toBe('');
    const snap = validate(json);

    expect(snap.agentVersion).toBe('1.1.1');
    // The NAT-only publish is present, with the source the API used to refuse.
    const nat = snap.listeners.find((l) => l.port === 9000);
    expect(nat).toMatchObject({ source: 'nat', containerPort: 9000 });
    // The docker-proxy port is not double-counted as a NAT row.
    expect(snap.listeners.filter((l) => l.port === 8080)).toHaveLength(1);
    // An empty INPUT with policy ACCEPT is a certain answer, not "unparsed".
    expect(snap.firewall).toMatchObject({ engine: 'iptables', active: false, defaultIncoming: 'allow', parsed: true });
    expect(snap.collectorOk).toBe(true);
  });

  it('firewall rules arrive INSIDE firewall, and owner refs as ownerRef', () => {
    const { json } = runCollector({
      stubs: {
        ss: ss(['tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=800,fd=3))']),
        iptables: [
          'case "$*" in',
          '  "-S INPUT") printf "%s\\n" "-P INPUT DROP" "-A INPUT -i lo -j ACCEPT" "-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT" "-A INPUT -m conntrack --ctstate INVALID -j DROP" "-A INPUT -p icmp -j ACCEPT" "-A INPUT -j f2b-sshd" "-A INPUT -i docker0 -j ACCEPT" "-A INPUT -p tcp -m tcp --dport 22 -j ACCEPT" "-A INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT" "-A INPUT -s 10.0.0.0/8 -p tcp -m tcp --dport 5432 -j ACCEPT" ;;',
          '  *) exit 1 ;;',
          'esac',
        ].join('\n'),
      },
      procs: {
        800: { comm: 'sshd', cmdline: ['/usr/sbin/sshd', '-D'], ppid: 1, uid: 0, cgroup: '0::/system.slice/ssh.service' },
      },
    });
    const snap = validate(json);
    expect(json.firewallRules).toBeUndefined();
    expect(snap.firewall).toMatchObject({ engine: 'iptables', active: true, defaultIncoming: 'deny', parsed: true });
    expect(snap.firewall.rules).toEqual([
      { port: '22', proto: 'tcp', action: 'ALLOW', from: 'Anywhere', family: 'any' },
      { port: '80,443', proto: 'tcp', action: 'ALLOW', from: 'Anywhere', family: 'any' },
      { port: '5432', proto: 'tcp', action: 'ALLOW', from: '10.0.0.0/8', family: 'any' },
    ]);
    const sshd = snap.listeners.find((l) => l.port === 22);
    expect(sshd).toMatchObject({ ownerKind: 'systemd', ownerName: 'ssh.service', ownerRef: 'ssh.service', process: 'sshd' });
  });

  it('an INPUT rule it cannot evaluate withholds the verdict and says why — as a note', () => {
    const { json } = runCollector({
      stubs: {
        ss: ss(['tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=800,fd=3))']),
        iptables: [
          'case "$*" in',
          '  "-S INPUT") printf "%s\\n" "-P INPUT ACCEPT" "-A INPUT -j INPUT_custom" ;;',
          '  "-t nat -S") printf "%s\\n" "-P PREROUTING ACCEPT" ;;',
          '  *) exit 1 ;;',
          'esac',
        ].join('\n'),
      },
      procs: { 800: { comm: 'sshd', ppid: 1, uid: 0, cgroup: '0::/system.slice/ssh.service' } },
    });
    const snap = validate(json);
    expect(snap.firewall.parsed).toBe(false);
    // A limitation of the host, not a fault: a note, and the collector is OK
    // — reinstalling could never change how this host's firewall is built.
    expect(snap.collectorOk).toBe(true);
    expect(snap.degradedReasons).toEqual([]);
    expect(snap.notes.join(' ')).toMatch(/cannot evaluate \(jumps to chain 'INPUT_custom'\)/);
  });

  it('a native nftables firewall is read from the ruleset', () => {
    const ruleset = [
      'table inet filter {',
      '\tchain input {',
      '\t\ttype filter hook input priority filter; policy drop;',
      '\t\tct state established,related accept',
      '\t\tiif "lo" accept',
      '\t\ttcp dport { 22, 443 } accept',
      '\t\tudp dport 51820 accept',
      '\t}',
      '}',
    ].join('\n');
    const { json } = runCollector({
      stubs: {
        ss: ss(['tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=800,fd=3))']),
        nft: `case "$*" in\n  "list ruleset") cat <<'EOF'\n${ruleset}\nEOF\n ;;\n  *) exit 1 ;;\nesac`,
        iptables: 'exit 1',
      },
      procs: { 800: { comm: 'sshd', ppid: 1, uid: 0, cgroup: '0::/system.slice/ssh.service' } },
    });
    const snap = validate(json);
    expect(snap.firewall).toMatchObject({ engine: 'nftables', active: true, defaultIncoming: 'deny', parsed: true });
    expect(snap.firewall.rules.map((r) => `${r.proto}/${r.port}/${r.action}`)).toEqual(['tcp/22,443/ALLOW', 'udp/51820/ALLOW']);
  });

  it('pm2 app launched through `infisical run -- npm start` is attributed to pm2, by name', () => {
    const pm2Home = 'pm2';
    const { json } = runCollector({
      stubs: {
        ss: ss(['tcp LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=320,fd=20))']),
      },
      procs: {
        100: { comm: 'PM2 v5.3.1: God', cmdline: ['PM2 v5.3.1: God Daemon (__PM2__)'], ppid: 1, uid: 1000, cgroup: '0::/user.slice/user-1000.slice/session-3.scope' },
        200: { comm: 'infisical', cmdline: ['infisical', 'run', '--env=prod', '--', 'npm', 'start'], ppid: 100, uid: 1000, cgroup: '0::/user.slice/user-1000.slice/session-3.scope' },
        300: { comm: 'npm', cmdline: ['npm', 'start'], ppid: 200, uid: 1000, cgroup: '0::/user.slice/user-1000.slice/session-3.scope' },
        310: { comm: 'sh', cmdline: ['sh', '-c', 'node server.js'], ppid: 300, uid: 1000, cgroup: '0::/user.slice/user-1000.slice/session-3.scope' },
        320: { comm: 'node', cmdline: ['node', '/srv/api/server.js'], ppid: 310, uid: 1000, cgroup: '0::/user.slice/user-1000.slice/session-3.scope' },
      },
      files: { [`${pm2Home}/pids/api-gateway-3.pid`]: '200\n', [`${pm2Home}/pids/.keep`]: '' },
    });
    const snap = validate(json);
    const app = snap.listeners.find((l) => l.port === 3000);
    expect(app.ownerKind).toBe('pm2');
    expect(app.ownerName).toBe('api-gateway');
    expect(app.ownerRef).toMatch(/^#3@/);
    expect(app.ownerDetail).toContain('node /srv/api/server.js');
    expect(app.ownerDetail).toContain('via infisical run → npm start');
    // The launcher's arguments (which can carry tokens) are never reported.
    expect(app.ownerDetail).not.toContain('--env=prod');
  });

  it('without a readable pid file, the pm2 app is named after what pm2 ran, skipping launchers', () => {
    const { json } = runCollector({
      stubs: { ss: ss(['tcp LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=320,fd=20))']) },
      procs: {
        100: { comm: 'PM2 v5.3.1: God', cmdline: ['PM2 v5.3.1: God Daemon (/nonexistent/.pm2)'], ppid: 1, uid: 1000 },
        200: { comm: 'doppler', cmdline: ['doppler', 'run', '--', 'node', 'server.js'], ppid: 100, uid: 1000 },
        320: { comm: 'node', cmdline: ['node', '/srv/api/server.js'], ppid: 200, uid: 1000 },
      },
    });
    const app = validate(json).listeners.find((l) => l.port === 3000);
    expect(app).toMatchObject({ ownerKind: 'pm2', ownerName: 'server.js' });
    expect(app.ownerDetail).toContain('via doppler run');
  });

  it('a process started by hand in an SSH session is not called a service', () => {
    const { json } = runCollector({
      stubs: { ss: ss(['tcp LISTEN 0 511 0.0.0.0:8000 0.0.0.0:* users:(("python3",pid=500,fd=3))']) },
      procs: {
        450: { comm: 'bash', cmdline: ['-bash'], ppid: 1, uid: 1000, cgroup: '0::/user.slice/user-1000.slice/session-12.scope' },
        500: { comm: 'python3', cmdline: ['python3', '-m', 'http.server'], ppid: 450, uid: 1000, cgroup: '0::/user.slice/user-1000.slice/session-12.scope' },
      },
    });
    const l = validate(json).listeners.find((x) => x.port === 8000);
    expect(l.ownerKind).toBe('process');
    expect(l.ownerName).toBe('python3');
    expect(l.ownerDetail).toMatch(/login session \(session-12\) — not supervised/);
  });

  it('a failing sudo grant is degraded with sudo’s own words, and still accepted', () => {
    const { json } = runCollector({
      stubs: {
        sudo: 'echo "sudo: a password is required" >&2; exit 1',
        ss: ss(['tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*']),
        iptables: 'exit 1',
      },
    });
    const snap = validate(json);
    expect(snap.collectorOk).toBe(false);
    expect(snap.degradedReasons[0]).toMatch(/could not run 'ss'.*: sudo: a password is required/);
    for (const r of snap.degradedReasons) expect(r.length).toBeLessThanOrEqual(500);
  });
});

describe('ingest normalisation of collectors already in the field (<= 1.0.0)', () => {
  it('folds firewallRules into firewall.rules, ownerId into ownerRef, and scanner into agentVersion', () => {
    const legacy = {
      schemaVersion: 1,
      scanner: 'shellius-posture-collect/1.0.0',
      collectedAt: new Date().toISOString(),
      collectorOk: true,
      degradedReason: null,
      firewall: { engine: 'ufw', active: true, defaultIncoming: 'deny' },
      listeners: [
        { proto: 'tcp', bind: '0.0.0.0', port: 9000, containerPort: 9000, ownerKind: 'docker', ownerName: 'runtime:172.17.0.3:9000', ownerId: '-', source: 'nat' },
      ],
      firewallRules: [{ port: '22', proto: 'tcp', action: 'ALLOW', from: 'Anywhere', engine: 'ufw' }],
    };
    const snap = validate(legacy);
    expect(snap.firewall.rules).toEqual([{ port: '22', proto: 'tcp', action: 'ALLOW', from: 'Anywhere', family: 'any' }]);
    expect(snap.listeners[0]).toMatchObject({ source: 'nat', ownerRef: '-' });
    expect(snap.listeners[0].ownerId).toBeUndefined();
    expect(snap.agentVersion).toBe('1.0.0');
    expect(snap.firewallRules).toBeUndefined();
  });
});

describe('collector 1.1.1 — what dev-demos-03 showed', () => {
  // grep's own command line contains its pattern, so searching every
  // /proc/*/cmdline for "God Daemon (" matched grep itself, whose entry was
  // gone by the time it was read: "line 328: /proc/<pid>/cmdline: No such
  // file or directory" on every run. Only the REAL /proc reproduces it.
  it('prints nothing on stderr when scanning the real /proc', () => {
    const { json, stderr } = runCollector({
      realProc: true,
      stubs: { ss: 'exit 0', iptables: 'case "$*" in "-S INPUT") echo "-P INPUT ACCEPT";; "-t nat -S") echo "-P PREROUTING ACCEPT";; *) exit 1;; esac' },
    });
    expect(json).not.toBeNull();
    expect(stderr).toBe('');
  });

  it('asks systemctl without sudo, once per unit — not once per socket through sudo', () => {
    const { json, sudoLog } = runCollector({
      stubs: {
        // Log every sudo call, then run it.
        sudo: '[ "$1" = "-n" ] && shift\necho "$*" >> "$HOME/sudo.log"\nexec "$@"',
        systemctl: 'case "$*" in "show -p FragmentPath --value clickhouse-server.service") echo /lib/systemd/system/clickhouse-server.service;; *) exit 0;; esac',
        ss: ss([
          'tcp LISTEN 0 4096 0.0.0.0:8123 0.0.0.0:* users:(("clickhouse-serv",pid=700,fd=3))',
          'tcp LISTEN 0 4096 0.0.0.0:9000 0.0.0.0:* users:(("clickhouse-serv",pid=700,fd=4))',
          'tcp LISTEN 0 4096 0.0.0.0:9009 0.0.0.0:* users:(("clickhouse-serv",pid=700,fd=5))',
        ]),
        iptables: 'case "$*" in "-S INPUT") echo "-P INPUT ACCEPT";; "-t nat -S") echo "-P PREROUTING ACCEPT";; *) exit 1;; esac',
      },
      procs: { 700: { comm: 'clickhouse-serv', ppid: 1, uid: 110, cgroup: '0::/system.slice/clickhouse-server.service' } },
    });
    const snap = validate(json);
    expect(snap.listeners.filter((l) => l.sourcePath === '/lib/systemd/system/clickhouse-server.service')).toHaveLength(3);
    expect(sudoLog).not.toContain('systemctl');
  });

  it('a Docker host is not "degraded" for being a Docker host', () => {
    const { json } = runCollector({
      stubs: {
        ss: ss(['tcp LISTEN 0 4096 0.0.0.0:5432 0.0.0.0:* users:(("postgres",pid=900,fd=3))']),
        iptables: 'case "$*" in "-S INPUT") echo "-P INPUT ACCEPT";; "-t nat -S") echo "-P PREROUTING ACCEPT";; *) exit 1;; esac',
      },
      procs: { 900: { comm: 'postgres', ppid: 1, uid: 999, cgroup: `0::/system.slice/docker-${'a'.repeat(64)}.scope` } },
    });
    const snap = validate(json);
    expect(snap.collectorOk).toBe(true);
    expect(snap.degradedReasons).toEqual([]);
    expect(snap.notes.join(' ')).toMatch(/container id could not be resolved/);
  });
});
