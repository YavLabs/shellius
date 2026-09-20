/**
 * The install scripts are bash emitted from a JS template literal. That is a
 * shape where a stray backtick, an unescaped `$` or a mismatched quote
 * produces a file that is perfectly valid JavaScript and a broken shell
 * script — and the only place it fails is on a customer's host, halfway
 * through an install that has already touched sshd.
 *
 * So: render them and hand them to bash's own parser.
 */
import { execFileSync } from 'child_process';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { __testBuilders } from '../bootstrap.js';

const dir = mkdtempSync(join(tmpdir(), 'shellius-install-'));

const check = (name, script) => {
  const file = join(dir, `${name}.sh`);
  writeFileSync(file, script, 'utf8');
  // Throws with bash's own error (file + line) if the script does not parse.
  execFileSync('bash', ['-n', file], { stdio: 'pipe' });
  return script;
};

describe('generated install scripts are valid bash', () => {
  const args = {
    apiUrl: 'https://shellius.example.com',
    agentToken: 'tok_test',
    caPubKey: 'ssh-ed25519 AAAAC3Nz test@ca',
    hostname: 'host.example.com',
    sshUser: 'ubuntu',
    serverId: 'srv_1',
    orgId: 'org_1',
  };

  it('parses the full installer', () => {
    const script = check('full', __testBuilders.buildUnixInstallScript(args));
    expect(script).toContain('--with-container-scan');
  });

  it('parses the posture-only installer', () => {
    const script = check('posture', __testBuilders.buildPostureOnlyInstallScript(args));
    expect(script).toContain('--with-container-scan');
  });

  it('offers the container scan as opt-IN, never on by default', () => {
    for (const build of [__testBuilders.buildUnixInstallScript, __testBuilders.buildPostureOnlyInstallScript]) {
      const script = build(args);
      // The variable starts empty; only the explicit flag sets it to 1.
      expect(script).toMatch(/CONTAINER_SCAN=""/);
      expect(script).toMatch(/"--with-container-scan" \] && CONTAINER_SCAN=1/);
      // And the grant is only written when it is.
      expect(script).toMatch(/CONTAINER_SCAN" = "1" \]/);
    }
  });
});
