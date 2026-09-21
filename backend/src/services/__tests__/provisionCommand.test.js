/**
 * provisionCommand.test.js — how the installer is launched, and how a sudo
 * password problem is recognised.
 *
 * The bug these pin: with no sudo password the command was
 * `curl … | sudo bash` on a pty. sudo printed "[sudo] password for ithadmin:"
 * and waited — forever. Nothing errored, the SSH stream never closed, the
 * promise never settled, and the bulk-install UI spun under a heading that
 * eventually said "Install finished". A certificate install hits this by
 * construction: it has no password to give.
 */

import {
  buildInstallCommand,
  looksLikePasswordPrompt,
  looksLikeSudoRefusal,
  looksLikeWrongSudoPassword,
  redactSecret,
  SUDO_PASSWORD_REQUIRED,
  SUDO_PASSWORD_INCORRECT,
} from '../provisionService.js';

const URL = 'https://shellius.example/api/bootstrap/install.sh?token=abc';

describe('buildInstallCommand', () => {
  it('never lets sudo prompt when there is no password to give', () => {
    const cmd = buildInstallCommand({ sshUser: 'ithadmin', sudoPassword: '', bootstrapUrl: URL });
    // -n: fail immediately instead of printing a prompt and waiting.
    expect(cmd).toMatch(/\| sudo -n bash$/);
    expect(cmd).not.toMatch(/\| sudo bash/);
  });

  it('feeds a supplied password on stdin, never on the command line', () => {
    const cmd = buildInstallCommand({ sshUser: 'ithadmin', sudoPassword: 'hunter2', bootstrapUrl: URL });
    expect(cmd).toContain('sudo -S bash');
    expect(cmd).not.toContain('hunter2');
  });

  it('runs straight through bash as root', () => {
    const cmd = buildInstallCommand({ sshUser: 'root', sudoPassword: '', bootstrapUrl: URL });
    expect(cmd).toBe(`curl -fsSL '${URL}' | bash`);
    expect(cmd).not.toContain('sudo');
  });
});

describe('looksLikePasswordPrompt', () => {
  it('recognises the prompt that hung the install', () => {
    expect(looksLikePasswordPrompt('[sudo] password for ithadmin: ')).toBe(true);
  });
  it('recognises sudo-rs\'s prompt', () => {
    expect(looksLikePasswordPrompt('[sudo: authenticate] Password: ')).toBe(true);
  });
  it('recognises a bare Password: prompt at a line start', () => {
    expect(looksLikePasswordPrompt('Installing…\nPassword:')).toBe(true);
  });
  it('does not fire on ordinary output that mentions passwords', () => {
    expect(looksLikePasswordPrompt('[shellius] Writing password policy docs')).toBe(false);
    expect(looksLikePasswordPrompt('')).toBe(false);
    expect(looksLikePasswordPrompt(undefined)).toBe(false);
  });
});

describe('looksLikeSudoRefusal', () => {
  // What `sudo -n` actually prints when it needs a password.
  it.each([
    'sudo: a password is required',
    'sudo: a terminal is required to read the password; either use the -S option',
    'sudo: no tty present and no askpass program specified',
    'sudo-rs: interactive authentication is required',
  ])('recognises %s', (line) => {
    expect(looksLikeSudoRefusal(line)).toBe(true);
  });

  it('does not treat other sudo errors as a missing password', () => {
    // Not in sudoers is a different fix — a password will not help.
    expect(looksLikeSudoRefusal('ithadmin is not in the sudoers file.')).toBe(false);
  });
});

it('exposes a stable code the UI branches on', () => {
  expect(SUDO_PASSWORD_REQUIRED).toBe('SUDO_PASSWORD_REQUIRED');
});

describe('sudo password handling on the pty', () => {
  it('redacts the sudo password wherever the pty echoes it back', () => {
    expect(redactSecret('hunter2\r', 'hunter2')).toBe('••••••••\r');
    expect(redactSecret('[sudo] password for ubuntu: hunter2', 'hunter2')).toBe('[sudo] password for ubuntu: ••••••••');
    expect(redactSecret('nothing to hide', 'hunter2')).toBe('nothing to hide');
    expect(redactSecret('no secret given', '')).toBe('no secret given');
  });

  it.each([
    'Sorry, try again.',
    'sudo: 1 incorrect password attempt',
    'sudo: 3 incorrect password attempts',
    // sudo-rs, the default sudo from Ubuntu 25.10
    'sudo-rs: Authentication failed, try again.',
    'sudo-rs: Incorrect authentication attempt',
    'sudo-rs: maximum 3 incorrect authentication attempts',
  ])('recognises a refused password: %s', (line) => {
    expect(looksLikeWrongSudoPassword(line)).toBe(true);
  });

  it('does not mistake a missing password for a wrong one', () => {
    expect(looksLikeWrongSudoPassword('sudo: a password is required')).toBe(false);
  });

  it('has a code distinct from "none given"', () => {
    expect(SUDO_PASSWORD_INCORRECT).toBe('SUDO_PASSWORD_INCORRECT');
    expect(SUDO_PASSWORD_INCORRECT).not.toBe(SUDO_PASSWORD_REQUIRED);
  });
});
