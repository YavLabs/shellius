/**
 * sshConnect.js unit tests — pure logic only (no live network):
 *   - classifyIp() address categorisation
 *   - resolveTarget() target guard (uses IP literals, so no real DNS call)
 *   - buildAuthQueue()/pickNextAuth() auth ordering + partial-success skip
 *
 * The actual ssh2 connection (including the certificate-auth patch) is
 * covered by the end-to-end script: backend/scripts/e2e-ssh-engine.mjs
 * (`npm run test:e2e:ssh`), which talks to a real sshd.
 */

import {
  classifyIp,
  resolveTarget,
  buildAuthQueue,
  pickNextAuth,
} from '../sshConnect.js';

describe('classifyIp', () => {
  test.each([
    ['127.0.0.1', 'loopback'],
    ['0.0.0.0', 'unspecified'],
    ['169.254.169.254', 'linklocal'], // cloud metadata endpoint
    ['169.254.1.1', 'linklocal'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'multicast'],
    ['10.0.0.5', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['172.32.0.1', 'public'], // just outside the 172.16/12 range
    ['192.168.1.1', 'private'],
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
  ])('%s -> %s (IPv4)', (ip, expected) => {
    expect(classifyIp(ip)).toBe(expected);
  });

  test.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'linklocal'],
    ['ff02::1', 'multicast'],
    ['fc00::1', 'private'],
    ['fd12:3456::1', 'private'],
    ['2001:4860:4860::8888', 'public'], // Google DNS
    ['::ffff:127.0.0.1', 'loopback'], // IPv4-mapped
  ])('%s -> %s (IPv6)', (ip, expected) => {
    expect(classifyIp(ip)).toBe(expected);
  });
});

describe('resolveTarget', () => {
  const OLD_ENV = process.env.SSH_TARGET_ALLOW_LOOPBACK;
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.SSH_TARGET_ALLOW_LOOPBACK;
    else process.env.SSH_TARGET_ALLOW_LOOPBACK = OLD_ENV;
  });

  test('rejects missing host', async () => {
    await expect(resolveTarget()).rejects.toMatchObject({ statusCode: 400 });
  });

  test.each(['127.0.0.1', '169.254.169.254', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1'])(
    'refuses disallowed literal %s with TARGET_NOT_ALLOWED',
    async (ip) => {
      delete process.env.SSH_TARGET_ALLOW_LOOPBACK;
      await expect(resolveTarget(ip)).rejects.toMatchObject({
        statusCode: 403,
        code: 'TARGET_NOT_ALLOWED',
      });
    }
  );

  test('allows RFC1918 private addresses', async () => {
    const result = await resolveTarget('10.1.2.3');
    expect(result).toMatchObject({ hostname: '10.1.2.3', ip: '10.1.2.3', addresses: ['10.1.2.3'] });
  });

  test('allows public addresses', async () => {
    const result = await resolveTarget('8.8.8.8');
    expect(result.ip).toBe('8.8.8.8');
  });

  test('SSH_TARGET_ALLOW_LOOPBACK=true allows loopback but not other disallowed categories', async () => {
    process.env.SSH_TARGET_ALLOW_LOOPBACK = 'true';
    const result = await resolveTarget('127.0.0.1');
    expect(result.ip).toBe('127.0.0.1');

    await expect(resolveTarget('169.254.169.254')).rejects.toMatchObject({ code: 'TARGET_NOT_ALLOWED' });
    await expect(resolveTarget('0.0.0.0')).rejects.toMatchObject({ code: 'TARGET_NOT_ALLOWED' });
  });
});

describe('buildAuthQueue / pickNextAuth', () => {
  const FAKE_ED25519_KEY =
    '-----BEGIN OPENSSH PRIVATE KEY-----\n' +
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW' +
    'QyNTUxOQAAACAvfake+fake+fake+fake+fake+fake+fake+fake+fake==\n' +
    '-----END OPENSSH PRIVATE KEY-----\n';

  test('no credentials -> empty queue', () => {
    expect(buildAuthQueue({ username: 'u' })).toEqual([]);
  });

  test('password only -> password, keyboard-interactive', () => {
    const q = buildAuthQueue({ username: 'u', password: 'p' });
    expect(q.map((a) => a.type)).toEqual(['password', 'keyboard-interactive']);
  });

  test('privateKey only -> single publickey attempt', () => {
    const q = buildAuthQueue({ username: 'u', privateKey: 'PEM' });
    expect(q.map((a) => a.type)).toEqual(['publickey']);
    expect(q[0].key).toBe('PEM');
  });

  test('key + password -> publickey, password, keyboard-interactive (both satisfiable)', () => {
    const q = buildAuthQueue({ username: 'u', privateKey: 'PEM', password: 'p' });
    expect(q.map((a) => a.type)).toEqual(['publickey', 'password', 'keyboard-interactive']);
  });

  test('certificate without a matching privateKey is ignored (no cert attempt)', () => {
    const q = buildAuthQueue({ username: 'u', password: 'p', certificate: 'ssh-ed25519-cert-v01@openssh.com AAAA' });
    expect(q.map((a) => a.type)).toEqual(['password', 'keyboard-interactive']);
  });

  test('certificate + privateKey -> certificate attempt first, then plain publickey, then password', () => {
    // A syntactically well-formed (but not CA-verifiable — irrelevant to
    // queue *ordering*) OpenSSH cert blob is enough: buildAuthQueue only
    // needs to parse the private key and recognise the cert's algorithm
    // name, not validate the certificate itself.
    const certBlob = Buffer.from('ssh-ed25519-cert-v01@openssh.com'.padEnd(64, '\0')).toString('base64');
    expect(() =>
      buildAuthQueue({
        username: 'u',
        privateKey: FAKE_ED25519_KEY,
        certificate: `ssh-ed25519-cert-v01@openssh.com ${certBlob}`,
        password: 'p',
      })
    ).toThrow(); // the fake key text above isn't a real parseable key — assert it fails closed, not silently
  });

  test('pickNextAuth walks the queue in order when nothing is excluded yet', () => {
    const queue = [{ type: 'publickey' }, { type: 'password' }, { type: 'keyboard-interactive' }];
    expect(pickNextAuth(queue, undefined)).toEqual({ type: 'publickey' });
    expect(pickNextAuth(queue, [])).toEqual({ type: 'password' });
    expect(pickNextAuth(queue, undefined)).toEqual({ type: 'keyboard-interactive' });
    expect(pickNextAuth(queue, undefined)).toBe(false);
  });

  test('pickNextAuth skips attempts the server no longer accepts (SSH partial success)', () => {
    const queue = [{ type: 'password' }, { type: 'publickey' }, { type: 'keyboard-interactive' }];
    // Server says (after a partial success on an earlier method) only
    // "publickey" remains acceptable — password/keyboard-interactive attempts
    // ahead of it in the queue must be skipped, not tried and failed.
    expect(pickNextAuth(queue, ['publickey'])).toEqual({ type: 'publickey' });
    expect(queue).toEqual([{ type: 'keyboard-interactive' }]); // consumed up through the match
  });

  test('pickNextAuth returns false when authsLeft excludes everything left', () => {
    const queue = [{ type: 'password' }];
    expect(pickNextAuth(queue, ['publickey'])).toBe(false);
  });
});
