/**
 * postureUnit.test.js — the collector's systemd unit, and how the collector
 * reports a privilege failure.
 *
 * The bug: the unit set NoNewPrivileges=true. That sets the kernel's
 * no_new_privs flag, under which setuid is ignored — and the collector's
 * whole privilege model is `sudo -n` through a narrow sudoers grant, with
 * sudo being setuid. Every privileged read failed on every host. Because
 * run_priv() sent sudo's stderr to /dev/null, the only symptom was "Collector
 * degraded … sudo grant missing?", unknown owners and UNKNOWN reachability,
 * with the one sentence that named the cause thrown away.
 *
 * Two things are pinned:
 *   1. the unit never again sets anything that stops sudo gaining privilege;
 *   2. when sudo does refuse, sudo's own words reach the degraded reason.
 */

import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSTURE = path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'posture');
const UNIT = readFileSync(path.join(POSTURE, 'shellius-posture.service'), 'utf8');
const COLLECTOR = path.join(POSTURE, 'shellius-posture-collect.sh');

/** Active directives only — comments may name these settings to explain them. */
const directives = UNIT.split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#') && !l.startsWith(';') && !l.startsWith('['));
const directive = (key) =>
  directives.find((l) => l.split('=')[0].trim() === key)?.split('=').slice(1).join('=').trim();

describe('shellius-posture.service', () => {
  it('runs as the unprivileged collector account, never root', () => {
    expect(directive('User')).toBe('shellius-posture');
  });

  // The collector reaches root ONLY through sudo. Each of these stops a
  // setuid binary gaining privilege — directly, or on older systemd by
  // implying NoNewPrivileges for a unit with a non-root User=.
  it.each([
    ['NoNewPrivileges'],
    ['RestrictSUIDSGID'],
    ['ProtectKernelModules'],
    ['SystemCallFilter'],
    ['DynamicUser'],
  ])('does not set %s, which would disable the sudoers grant', (key) => {
    const v = directive(key);
    expect(v === undefined || /^(no|false|0|off)$/i.test(v)).toBe(true);
  });

  it('does not use CapabilityBoundingSet to strip what sudo needs', () => {
    // An empty or narrowed bounding set removes CAP_SETUID/CAP_SETGID for
    // the whole process tree, which sudo needs to become root.
    expect(directive('CapabilityBoundingSet')).toBeUndefined();
  });

  it('leaves /run writable for the root commands sudo runs', () => {
    // iptables-legacy opens /run/xtables.lock; ProtectSystem=strict makes
    // /run read-only for this whole mount namespace, sudo'd children included.
    expect(directive('ProtectSystem')).not.toBe('strict');
  });

  it('does not hide the homes the pm2 reader looks in', () => {
    expect(directive('ProtectHome')).not.toMatch(/^(true|yes|tmpfs)$/i);
  });

  it('keeps the hardening that costs the collector nothing', () => {
    expect(directive('PrivateTmp')).toBe('true');
    expect(directive('ProtectKernelTunables')).toBe('true');
    expect(directive('MemoryMax')).toBeDefined();
  });
});

describe('collector privilege failure is reported in sudo’s own words', () => {
  const NNP = 'sudo: The "no new privileges" flag is set, which prevents sudo from running as root.';
  let dir;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'posture-nnp-'));
    const stub = (name, body) => {
      const p = path.join(dir, name);
      writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(p, 0o755);
    };
    // Exactly what sudo does under no_new_privs.
    stub('sudo', `echo '${NNP}' >&2; exit 1`);
    // Unprivileged ss succeeds with nothing to report.
    stub('ss', 'exit 0');
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('names the actual cause instead of guessing "sudo grant missing?"', () => {
    const run = spawnSync('bash', [COLLECTOR], {
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir },
      encoding: 'utf8',
      timeout: 30000,
    });
    // The collector exits 2 when ss could not run privileged — expected here.
    const json = JSON.parse(run.stdout);
    const reasons = json.degradedReasons || [];
    const ssReason = reasons.find((r) => r.startsWith("could not run 'ss'"));
    expect(ssReason).toBeDefined();
    expect(ssReason).toContain('no new privileges');
    // Survives JSON encoding with its quotes intact.
    expect(ssReason).toContain('"no new privileges"');
    expect(json.collectorOk).toBe(false);
  });
});

/**
 * The sudoers drop-ins must parse under EVERY sudo the fleet runs — classic
 * sudo and sudo-rs (the default from Ubuntu 25.10). Bootstrap runs
 * `visudo -c` and deletes a file that fails it, so one unsupported line
 * (`Defaults:… !requiretty` is rejected by sudo-rs) silently removes every
 * grant in it and every host goes degraded. Validated with whichever visudo
 * this machine has; skipped when there is none.
 */
describe('sudoers drop-ins', () => {
  const visudo = ['/usr/sbin/visudo', '/sbin/visudo', '/usr/bin/visudo'].find((p) => {
    try {
      readFileSync(p);
      return true;
    } catch {
      return false;
    }
  });
  const files = ['shellius-posture.sudoers', 'shellius-posture-containers.sudoers'];

  it.each(files)('%s has no Defaults lines (not portable across sudo implementations)', (f) => {
    const active = readFileSync(path.join(POSTURE, f), 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'));
    expect(active.some((l) => /^Defaults/.test(l.trim()))).toBe(false);
  });

  (visudo ? it.each(files) : it.skip.each(files))('%s passes visudo -c', (f) => {
    const run = spawnSync(visudo, ['-c', '-f', path.join(POSTURE, f)], { encoding: 'utf8' });
    expect(`${run.stdout}${run.stderr}`).not.toMatch(/invalid|error/i);
    expect(run.status).toBe(0);
  });

  it('grants the INPUT and ruleset reads the firewall parser needs', () => {
    const grant = readFileSync(path.join(POSTURE, 'shellius-posture.sudoers'), 'utf8');
    expect(grant).toMatch(/\/usr\/sbin\/iptables -S INPUT/);
    expect(grant).toMatch(/\/usr\/sbin\/nft list ruleset/);
  });
});
