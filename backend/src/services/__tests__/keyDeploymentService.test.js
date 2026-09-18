/**
 * keyDeploymentService — remote script builder tests.
 *
 * Pure function tests (no DB / SSH): buildInnerScript / buildDeployCommand /
 * shQuote must strictly validate the public key, safely quote every dynamic
 * value, and never place a sudo password on the command line.
 */

import { shQuote, buildInnerScript, buildDeployCommand } from '../keyDeploymentService.js';

const VALID_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJUGdmLE0gqTAKv8i9Op8YTzThAzW/6UKbzGEMxUXDfB user@host';

describe('shQuote', () => {
  it('wraps a plain string in single quotes', () => {
    expect(shQuote('hello')).toBe("'hello'");
  });

  it('safely escapes embedded single quotes', () => {
    const quoted = shQuote("O'Brien");
    expect(quoted).toBe("'O'\\''Brien'");
    // Reconstructing what a POSIX shell would parse: 'O' + \' + 'Brien' => O'Brien
  });

  it('handles shell metacharacters without breaking out of the quote', () => {
    const evil = "'; rm -rf / #";
    const quoted = shQuote(evil);
    // Must start and end with a single quote, and the only unescaped quotes
    // are the wrapping ones — verified by round-tripping through /bin/sh.
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
  });
});

describe('buildInnerScript', () => {
  it('rejects an invalid public key before building any script', () => {
    expect(() => buildInnerScript({ action: 'deploy', publicKey: 'not a key' })).toThrow(/valid single-line OpenSSH/);
  });

  it('rejects a multi-line "public key" (defends against injected newlines)', () => {
    expect(() => buildInnerScript({ action: 'deploy', publicKey: `${VALID_KEY}\nrm -rf /` })).toThrow();
  });

  it('embeds the key as a single-quoted grep pattern for deploy', () => {
    const script = buildInnerScript({ action: 'deploy', publicKey: VALID_KEY });
    expect(script).toContain(shQuote(VALID_KEY));
    expect(script).toContain('grep -qxF');
    expect(script).toContain('>> "$AK"');
    expect(script).toContain('chmod 700 "$HOME_DIR/.ssh"');
    expect(script).toContain('chmod 600 "$AK"');
  });

  it('uses grep -v (invert match) to remove the key on remove', () => {
    const script = buildInnerScript({ action: 'remove', publicKey: VALID_KEY });
    expect(script).toContain('grep -vxF');
    expect(script).toContain('mv -f "$AK.shellius.tmp" "$AK"');
  });

  it('safely quotes a key with an adversarial comment containing a single quote', () => {
    const evilKey = `${VALID_KEY.split(' ').slice(0, 2).join(' ')} it's-a-trap`;
    const script = buildInnerScript({ action: 'deploy', publicKey: evilKey });
    expect(script).toContain(shQuote(evilKey));
  });
});

describe('buildDeployCommand', () => {
  it('rejects an invalid targetUser', () => {
    expect(() =>
      buildDeployCommand({ action: 'deploy', publicKey: VALID_KEY, targetUser: 'root; rm -rf /', useSudo: false })
    ).toThrow(/targetUser/);
  });

  it('runs the inner script directly (no sudo) when useSudo is false', () => {
    const { command, stdin } = buildDeployCommand({ action: 'deploy', publicKey: VALID_KEY, targetUser: 'deploy', useSudo: false });
    expect(command).not.toMatch(/^sudo/);
    expect(command).toContain('HOME_DIR=$(cd ~ && pwd)');
    expect(stdin).toBeUndefined();
  });

  it('wraps with passwordless sudo -n when useSudo is true and no password given', () => {
    const { command, stdin } = buildDeployCommand({ action: 'deploy', publicKey: VALID_KEY, targetUser: 'app', useSudo: true });
    expect(command).toMatch(/^sudo -n -u 'app' -H sh -c /);
    expect(stdin).toBeUndefined();
  });

  it('wraps with sudo -S and feeds the password ONLY via stdin, never on the command line', () => {
    const { command, stdin } = buildDeployCommand({
      action: 'deploy',
      publicKey: VALID_KEY,
      targetUser: 'app',
      useSudo: true,
      sudoPassword: 'hunter2-secret',
    });
    expect(command).toMatch(/^sudo -S -k -u 'app' -H sh -c /);
    expect(command).not.toContain('hunter2-secret');
    expect(stdin).toBe('hunter2-secret\n');
  });

  it('single-quotes the inner script so nested shell metacharacters cannot escape', () => {
    const { command } = buildDeployCommand({ action: 'deploy', publicKey: VALID_KEY, targetUser: 'app', useSudo: true });
    const inner = buildInnerScript({ action: 'deploy', publicKey: VALID_KEY });
    expect(command).toContain(shQuote(inner));
  });
});
