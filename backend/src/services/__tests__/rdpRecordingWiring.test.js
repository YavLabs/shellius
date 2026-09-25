/**
 * rdpRecordingWiring.test.js
 *
 * Recording is switched on by mutating the settings object guacamole-lite
 * hands to `processConnectionSettings`. That rests on an assumption about a
 * third-party library's internals: that by the time the callback runs,
 * `settings.connection` is the FLAT parameter map destined for guacd — not the
 * `{ type, settings }` pair the token was built with.
 *
 * ClientConnection.js does `this.connectionSettings['connection'] =
 * this.mergeConnectionOptions()` before invoking the callback, which is why
 * that holds. This test pins it against the real library, because if a future
 * guacamole-lite reorders those two lines the recording parameters would land
 * somewhere guacd never sees, and RDP sessions would silently stop being
 * recorded with nothing failing anywhere.
 */

import { jest } from '@jest/globals';
import GuacamoleLite from 'guacamole-lite';
import ClientConnection from 'guacamole-lite/lib/ClientConnection.js';
import * as rdpService from '../rdpService.js';
import * as rdpRecordingService from '../rdpRecordingService.js';

const RECORDING_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** A guacamole-lite server built exactly as terminalService builds it. */
function buildServer(processConnectionSettings) {
  return new GuacamoleLite(
    { noServer: true, server: undefined },
    { host: '127.0.0.1', port: 4822 },
    {
      crypt: { cypher: rdpService.GUAC_CRYPT_CYPHER, key: rdpService.GUAC_CRYPT_KEY },
      log: { level: 'ERRORS', stdLog: () => {}, errorLog: () => {} },
    },
    { processConnectionSettings }
  );
}

const fakeWebSocket = () => ({ on: jest.fn(), send: jest.fn(), close: jest.fn(), removeAllListeners: jest.fn() });

/** Run one token through ClientConnection and capture what the callback sees. */
function settingsFor(token, mutate) {
  const server = buildServer((settings, callback) => {
    if (mutate) mutate(settings);
    callback(null, settings);
  });
  let seen = null;
  const original = server.callbacks.processConnectionSettings;
  server.callbacks.processConnectionSettings = (settings, callback) => {
    original(settings, (err, s) => {
      seen = s;
      callback(err, s);
    });
  };
  // eslint-disable-next-line no-new
  new ClientConnection(server.clientOptions, 1, fakeWebSocket(), { token }, server.callbacks);
  return seen;
}

const token = () =>
  rdpService.encryptGuacToken({
    connection: { type: 'rdp', settings: { hostname: '10.0.0.5', port: '3389', username: 'u', password: 'p' } },
    expiration: Date.now() + 60_000,
    orgId: 'org-1',
    serverId: 'srv-1',
    userId: 'usr-1',
    accessRequestId: 'req-1',
  });

describe('what guacamole-lite hands to processConnectionSettings', () => {
  test('settings.connection is the flat parameter map, not { type, settings }', () => {
    const seen = settingsFor(token());
    expect(seen).toBeTruthy();
    // Flat: the RDP parameters are directly on `connection`.
    expect(seen.connection.hostname).toBe('10.0.0.5');
    expect(seen.connection.username).toBe('u');
    // And NOT nested — this is the assumption that matters.
    expect(seen.connection.settings).toBeUndefined();
    expect(seen.connection.type).toBeUndefined();
  });

  test('top-level metadata survives, which is how a session row gets its ids', () => {
    const seen = settingsFor(token());
    expect(seen.orgId).toBe('org-1');
    expect(seen.serverId).toBe('srv-1');
    expect(seen.userId).toBe('usr-1');
    expect(seen.accessRequestId).toBe('req-1');
    expect(seen.expiration).toBeGreaterThan(Date.now());
  });

  test('recording parameters attached in the callback land where guacd reads them', () => {
    const seen = settingsFor(token(), (settings) => {
      Object.assign(settings.connection, rdpRecordingService.recordingParamsFor(RECORDING_ID));
      settings.recordingId = RECORDING_ID;
    });

    expect(seen.connection['recording-path']).toBe(rdpRecordingService.GUACD_RECORDINGS_DIR);
    expect(seen.connection['recording-name']).toBe(`${RECORDING_ID}.guac`);
    expect(seen.connection['create-recording-path']).toBe('true');
    expect(seen.connection['recording-include-keys']).toBe('false');
    // The id itself is metadata: guacd must never be sent it as a parameter.
    expect(seen.recordingId).toBe(RECORDING_ID);
    expect(seen.connection.recordingId).toBeUndefined();
  });

  test('attaching recording does not disturb the connection it is recording', () => {
    const seen = settingsFor(token(), (settings) => {
      Object.assign(settings.connection, rdpRecordingService.recordingParamsFor(RECORDING_ID));
    });
    expect(seen.connection.hostname).toBe('10.0.0.5');
    expect(seen.connection.username).toBe('u');
    expect(seen.connection.port).toBe('3389');
  });
});
