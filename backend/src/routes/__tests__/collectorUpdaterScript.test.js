/**
 * collectorUpdaterScript.test.js — the one script in Shellius that downloads
 * code and runs it as root.
 *
 * Every assertion here is about REFUSING. The happy path is exercised for
 * real in the service tests and by hand against a stand-in API; what needs
 * pinning in the build is that no future edit turns a verification failure
 * into a fallback, and that the unit file never acquires a hardening option
 * that silently disables the smoke test.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSTURE = path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'posture');
const UPDATER = path.join(POSTURE, 'shellius-collector-update.sh');
const SCRIPT = readFileSync(UPDATER, 'utf8');
const UNIT = readFileSync(path.join(POSTURE, 'shellius-collector-update.service'), 'utf8');
const TIMER = readFileSync(path.join(POSTURE, 'shellius-collector-update.timer'), 'utf8');

const directives = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith(';') && !l.startsWith('['));
const directive = (text, key) =>
  directives(text).find((l) => l.split('=')[0].trim() === key)?.split('=').slice(1).join('=').trim();

describe('the updater script is valid bash', () => {
  test('parses', () => {
    const res = spawnSync('bash', ['-n', UPDATER], { encoding: 'utf8' });
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
  });
});

describe('verification is a refusal, never a fallback', () => {
  // The failure this prevents: someone "fixes" a host that keeps refusing an
  // update by adding a path that installs it anyway.
  test('every verification failure exits without installing', () => {
    // Each of these messages belongs to a branch that must end the run.
    for (const marker of [
      'no release signing key',
      'digest mismatch',
      'signature is not valid base64',
      'signature does not verify',
      'does not start with a shebang',
    ]) {
      const idx = SCRIPT.indexOf(marker);
      expect(idx).toBeGreaterThan(-1);
      // The branch containing the message must exit before reaching install.
      const after = SCRIPT.slice(idx, idx + 200);
      expect(after).toMatch(/exit 0/);
    }
  });

  test('refuses outright when no signing key is present', () => {
    expect(SCRIPT).toMatch(/if \[ ! -r "\$KEY_FILE" \]/);
    expect(SCRIPT).toContain('refusing to install unverified code');
  });

  test('checks the signature with the host-portable openssl invocation', () => {
    // RSA + `openssl dgst -sha256 -verify` works back to OpenSSL 1.0.2;
    // Ed25519 from the CLI needs pkeyutl -rawin, which is 3.0+.
    expect(SCRIPT).toMatch(/openssl dgst -sha256 -verify/);
    expect(SCRIPT).not.toMatch(/pkeyutl/);
  });

  test('checks the digest as well as the signature', () => {
    expect(SCRIPT).toMatch(/sha256sum/);
  });

  test('bounds the download, so a huge response is never written to disk', () => {
    expect(SCRIPT).toMatch(/--max-filesize/);
  });
});

describe('it only ever touches the collector', () => {
  // A bad collector makes posture go quiet. A bad check-principals decides
  // whether anyone can log into anything.
  test.each([
    'check-principals',
    'sshd_config',
    'shellius_ca.pub',
    'authorized_keys',
    'shellius-heartbeat',
    'shellius-jit',
  ])('never writes %s', (forbidden) => {
    // Allowed in a comment explaining why; never as something the script does.
    const code = SCRIPT.split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toContain(forbidden);
  });

  test('writes exactly one executable path', () => {
    expect(SCRIPT).toContain('COLLECTOR="/usr/local/sbin/shellius-posture-collect"');
  });
});

describe('it is inert on failure', () => {
  test('never exits non-zero', () => {
    // `exit 2` on an unknown CLI flag is the one exception, and it happens
    // before anything is touched.
    const exits = [...SCRIPT.matchAll(/^\s*exit (\d+)/gm)].map((m) => m[1]);
    expect(exits.filter((c) => c !== '0' && c !== '2')).toEqual([]);
  });

  test('keeps the previous collector before replacing it', () => {
    const cp = SCRIPT.indexOf('cp -p "$COLLECTOR" "$PREVIOUS"');
    const mv = SCRIPT.indexOf('mv -f "$STAGED" "$COLLECTOR"');
    expect(cp).toBeGreaterThan(-1);
    expect(mv).toBeGreaterThan(-1);
    expect(cp).toBeLessThan(mv);
  });

  // mktemp -d lands in /tmp, which on most systemd distros is a different
  // filesystem from /usr/local/sbin. `mv` across filesystems is copy-then-
  // unlink onto the LIVE path, not rename(2) — so an interrupted move leaves
  // a truncated collector where a working one used to be.
  test('stages the replacement beside its destination, not in /tmp', () => {
    expect(SCRIPT).toMatch(/mktemp "\$\{COLLECTOR\}\.new\.XXXXXX"/);
    expect(SCRIPT).not.toContain('collector.staged');
  });

  test('checks whether the rollback itself succeeded', () => {
    // Reporting "rolled back" when the rollback failed says the host is safe
    // when it may be running a collector that does not work.
    expect(SCRIPT).toMatch(/if mv -f "\$PREVIOUS" "\$COLLECTOR"; then/);
    expect(SCRIPT).toMatch(/the rollback could not be written/);
  });

  test('rolls back when the new collector fails its smoke run', () => {
    expect(SCRIPT).toMatch(/rolled back to the previous collector/);
    expect(SCRIPT).toMatch(/mv -f "\$PREVIOUS" "\$COLLECTOR"/);
  });

  // Exit 0 with no output is how a broken collector looks to the reporter.
  test('the smoke test requires JSON, not just a zero exit', () => {
    expect(SCRIPT).toMatch(/exited 0 but produced no JSON/);
  });

  test('runs the smoke test as the unprivileged collector account', () => {
    expect(SCRIPT).toMatch(/runuser -u "\$COLLECTOR_USER"/);
  });

  test('does not reinstall the version it already has', () => {
    expect(SCRIPT).toMatch(/already on \$VERSION/);
  });

  // The signature covers the script and nothing else — no nonce, no
  // timestamp. A validly-signed OLDER bundle replayed by whatever sits
  // between the host and the server would verify perfectly.
  test('refuses a version that is not newer than the installed one', () => {
    expect(SCRIPT).toMatch(/version_le/);
    expect(SCRIPT).toMatch(/possible replay/);
  });

  // A missing runuser makes the smoke run fail in a way indistinguishable
  // from a broken collector, so every update would install, roll back, and
  // report a failure that eventually halts the org's rollout.
  test('requires the tools the smoke test needs before installing anything', () => {
    expect(SCRIPT).toMatch(/for tool in runuser timeout/);
  });
});

describe('the systemd units', () => {
  test('the updater runs as root — it has to replace a root-owned file', () => {
    expect(directive(UNIT, 'User')).toBe('root');
    expect(directive(UNIT, 'Type')).toBe('oneshot');
  });

  // Exactly the prohibition shellius-posture.service carries, for exactly the
  // same reason: the smoke run shells out to the collector, which reaches
  // root through setuid sudo. A hardening option that disables setuid would
  // make every smoke test fail and every update roll back — and it would look
  // like a bad collector.
  test.each(['NoNewPrivileges', 'ProtectKernelModules', 'RestrictSUIDSGID', 'DynamicUser'])(
    'never sets %s',
    (key) => {
      expect(directive(UNIT, key)).toBeUndefined();
    }
  );

  test('the timer spreads the fleet out rather than stampeding the API', () => {
    expect(directive(TIMER, 'RandomizedDelaySec')).toBeTruthy();
    expect(Number(directive(TIMER, 'RandomizedDelaySec'))).toBeGreaterThanOrEqual(60);
  });

  test('the timer is installed into timers.target', () => {
    expect(directive(TIMER, 'WantedBy')).toBe('timers.target');
    expect(directive(TIMER, 'Unit')).toBe('shellius-collector-update.service');
  });

  test('the updater has an outer timeout', () => {
    expect(directive(UNIT, 'TimeoutStartSec')).toBeTruthy();
  });
});
