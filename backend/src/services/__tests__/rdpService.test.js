/**
 * rdpService.test.js — the RDP connection token, and what it may carry.
 *
 * There were no RDP tests at all before 2.1, which is how the module ended up
 * with six exported functions that nothing called, a token universally
 * described in comments as "a short-lived JWT" when it is an AES-CBC blob,
 * and a `.rdp` file that embedded that blob — password and all — on the
 * user's disk.
 *
 * The properties pinned here are the ones a reviewer would ask about:
 * the token must be opaque, must round-trip exactly as guacamole-lite
 * decrypts it, must expire, and must carry the identity the session row is
 * built from.
 */

import crypto from 'crypto';
import config from '../../config/index.js';
import * as rdpService from '../rdpService.js';

/**
 * `encryptRdpPassword` returns the three Server columns, not a string — the
 * iv/tag pair is vestigial (always '') because the envelope packs them, but
 * the shape is what serverService writes.
 */
const encPw = (plain) => rdpService.encryptRdpPassword(plain).rdpPasswordEncrypted;

/** Decrypt the way guacamole-lite's Crypt.decrypt does. */
function decryptGuacToken(token) {
  const { iv, value } = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    Buffer.from(rdpService.GUAC_CRYPT_KEY),
    Buffer.from(iv, 'base64')
  );
  return JSON.parse(decipher.update(value, 'base64', 'utf8') + decipher.final('utf8'));
}

const server = (over = {}) => ({
  id: 'srv-1',
  hostname: 'win-1.example.com',
  ipAddress: '10.0.0.9',
  port: null,
  rdpPort: null,
  rdpUsername: 'Administrator',
  rdpPasswordEncrypted: encPw('s3cr3t-pw'),
  authMode: 'certificate',
  credential: null,
  ...over,
});

const accessRequest = (over = {}) => ({
  id: 'ar-1',
  orgId: 'org-1',
  requesterId: 'user-1',
  ...over,
});

describe('guacamole connection token', () => {
  test('the key is 32 bytes, as AES-256 requires', () => {
    expect(Buffer.from(rdpService.GUAC_CRYPT_KEY).length).toBe(32);
  });

  test('the key is derived from the JWT secret, not stored separately', () => {
    const expected = crypto
      .createHash('sha256')
      .update(String(config.jwt.secret))
      .digest('hex')
      .slice(0, 32);
    expect(rdpService.GUAC_CRYPT_KEY).toBe(expected);
  });

  test('round-trips through guacamole-lite\'s own format', () => {
    const token = rdpService.encryptGuacToken({ hello: 'world', n: 1 });
    expect(decryptGuacToken(token)).toEqual({ hello: 'world', n: 1 });
  });

  test('a fresh IV is used every time, so the same payload differs', () => {
    const a = rdpService.encryptGuacToken({ same: 'payload' });
    const b = rdpService.encryptGuacToken({ same: 'payload' });
    expect(a).not.toBe(b);
    expect(decryptGuacToken(a)).toEqual(decryptGuacToken(b));
  });

  // The whole point of encrypting it: the browser holds this string.
  test('the password is not readable in the token', () => {
    const token = rdpService.buildRdpToken({ accessRequest: accessRequest(), server: server() });
    expect(token).not.toContain('s3cr3t-pw');
    expect(Buffer.from(token, 'base64').toString('utf8')).not.toContain('s3cr3t-pw');
  });

  test('carries the settings guacd needs', () => {
    const token = rdpService.buildRdpToken({ accessRequest: accessRequest(), server: server() });
    const { connection } = decryptGuacToken(token);
    expect(connection.type).toBe('rdp');
    expect(connection.settings).toMatchObject({
      hostname: '10.0.0.9',
      port: '3389',
      username: 'Administrator',
      password: 's3cr3t-pw',
    });
  });

  test('carries the identity the session row is built from', () => {
    const token = rdpService.buildRdpToken({
      accessRequest: accessRequest({ id: 'ar-9', orgId: 'org-9', requesterId: 'user-9' }),
      server: server({ id: 'srv-9' }),
    });
    const t = decryptGuacToken(token);
    expect(t).toMatchObject({
      orgId: 'org-9',
      serverId: 'srv-9',
      userId: 'user-9',
      accessRequestId: 'ar-9',
    });
  });

  // Without accessRequestId on the token there is no accessRequestId on the
  // Session row, and expiry/revoke could not find the session to close.
  test('accessRequestId is present, which is what lets a revoke close the session', () => {
    const t = decryptGuacToken(
      rdpService.buildRdpToken({ accessRequest: accessRequest(), server: server() })
    );
    expect(t.accessRequestId).toBe('ar-1');
  });

  test('expires five minutes out', () => {
    const before = Date.now();
    const t = decryptGuacToken(
      rdpService.buildRdpToken({ accessRequest: accessRequest(), server: server() })
    );
    expect(t.expiration).toBeGreaterThanOrEqual(before + 5 * 60 * 1000 - 50);
    expect(t.expiration).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 50);
  });

  test('prefers the routable IP over a possibly unresolvable hostname', () => {
    const withIp = decryptGuacToken(
      rdpService.buildRdpToken({ accessRequest: accessRequest(), server: server() })
    );
    expect(withIp.connection.settings.hostname).toBe('10.0.0.9');

    const noIp = decryptGuacToken(
      rdpService.buildRdpToken({ accessRequest: accessRequest(), server: server({ ipAddress: null }) })
    );
    expect(noIp.connection.settings.hostname).toBe('win-1.example.com');
  });

  test('rdpPort wins over port, and 3389 is the floor', () => {
    const explicit = decryptGuacToken(
      rdpService.buildRdpToken({
        accessRequest: accessRequest(),
        server: server({ rdpPort: 3390, port: 22 }),
      })
    );
    expect(explicit.connection.settings.port).toBe('3390');

    const fromPort = decryptGuacToken(
      rdpService.buildRdpToken({ accessRequest: accessRequest(), server: server({ port: 13389 }) })
    );
    expect(fromPort.connection.settings.port).toBe('13389');
  });
});

describe('credential resolution', () => {
  test('encrypt/decrypt round-trips the stored password', () => {
    const fields = rdpService.encryptRdpPassword('hunter2');
    expect(fields.rdpPasswordEncrypted).not.toContain('hunter2');
    expect(rdpService.decryptRdpPassword(fields)).toBe('hunter2');
  });

  test('the iv/tag columns are vestigial — the envelope carries both', () => {
    const fields = rdpService.encryptRdpPassword('hunter2');
    expect(fields.rdpPasswordIv).toBe('');
    expect(fields.rdpPasswordTag).toBe('');
  });

  test('a server with no password decrypts to null rather than throwing', () => {
    expect(rdpService.decryptRdpPassword({ rdpPasswordEncrypted: null })).toBeNull();
  });

  test('a bound Keystore identity takes precedence over the inline password', () => {
    const creds = rdpService.resolveRdpCredentials(
      server({
        authMode: 'credential',
        credential: {
          username: 'svc_rdp',
          passwordEncrypted: encPw('from-keystore'),
        },
      })
    );
    expect(creds).toEqual({ username: 'svc_rdp', password: 'from-keystore' });
  });

  test('an identity with no password yields an empty string, not a crash', () => {
    const creds = rdpService.resolveRdpCredentials(
      server({ authMode: 'credential', credential: { username: 'svc_rdp', passwordEncrypted: null } })
    );
    expect(creds).toEqual({ username: 'svc_rdp', password: '' });
  });

  test('falls back to the inline RDP fields when authMode is not credential', () => {
    const creds = rdpService.resolveRdpCredentials(server());
    expect(creds).toEqual({ username: 'Administrator', password: 's3cr3t-pw' });
  });
});

describe('the dead gateway API is gone', () => {
  // Six exports with no callers, whose comments were nonetheless the
  // canonical description of how RDP worked. Removing them is the point;
  // this test stops them being reintroduced by a merge.
  test.each([
    'createGuacdConnection',
    'encodeInstruction',
    'parseInstructions',
    'issueGatewayToken',
    'verifyGatewayToken',
    'revokeConnection',
  ])('%s is no longer exported', (name) => {
    expect(rdpService[name]).toBeUndefined();
  });
});
