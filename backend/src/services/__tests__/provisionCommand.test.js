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
  SUDO_PASSWORD_REQUIRED,
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
