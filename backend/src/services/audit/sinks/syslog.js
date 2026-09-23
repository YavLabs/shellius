/**
 * syslog — RFC 5424 over TCP, optionally TLS.
 *
 * Framing is octet-counting (RFC 6587): `<length> <message>`. This is not a
 * preference — the alternative, newline-terminated framing, corrupts any
 * payload containing a newline, and audit metadata is JSON that can. Getting
 * this wrong is the classic way a syslog integration silently mangles data.
 *
 * Honest limitation, stated in the UI as well as here: a TCP write is not an
 * application acknowledgement. Syslog has no reply, so "delivered" means the
 * bytes were accepted by the socket, not that the collector stored them. The
 * cursor advances only after the whole batch has drained with no error, and
 * a mid-batch failure replays the batch — duplicates at the collector, which
 * is the right side to err on.
 */

import net from 'net';
import tls from 'tls';
import { once } from 'events';
import { SYSLOG_SEVERITY } from '../envelope.js';
import { RetryableSinkError, SinkConfigError } from './errors.js';

export const type = 'syslog';
export const label = 'Syslog (RFC 5424)';
export const streaming = true;
export const secretFields = ['clientKey'];
export const maxBatch = 500;

const CONNECT_TIMEOUT_MS = 10_000;
const DRAIN_TIMEOUT_MS = 30_000;
/** Private Enterprise Number placeholder for the structured-data element. */
const SD_ID = 'shellius@53595';

export function validateConfig(config = {}) {
  const host = String(config.host || '').trim();
  if (!host) throw new SinkConfigError('A host is required');

  const port = Number(config.port ?? 6514);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SinkConfigError('Port must be between 1 and 65535');
  }

  const facility = Number(config.facility ?? 13); // 13 = log audit
  if (!Number.isInteger(facility) || facility < 0 || facility > 23) {
    throw new SinkConfigError('Facility must be between 0 and 23');
  }

  const appName = String(config.appName || 'shellius').trim();
  if (!/^[\x21-\x7e]{1,48}$/.test(appName)) {
    throw new SinkConfigError('App name must be 1-48 printable characters with no spaces');
  }

  return {
    host,
    port,
    tls: config.tls !== false,
    rejectUnauthorized: config.rejectUnauthorized !== false,
    caCert: config.caCert ? String(config.caCert) : null,
    clientCert: config.clientCert ? String(config.clientCert) : null,
    clientKey: config.clientKey ? String(config.clientKey) : null,
    appName,
    facility,
  };
}

export function notReadyReason(config = {}) {
  if (!config.host) return 'No host set';
  return null;
}

/** Escape a structured-data param value per RFC 5424 §6.3.3. */
const sd = (v) => String(v ?? '').replace(/([\\\]"])/g, '\\$1');

/**
 * One RFC 5424 frame, octet-counted.
 * `<PRI>1 TIMESTAMP HOSTNAME APP-NAME PROCID MSGID [SD] BOM<message>`
 */
export function frameFor(envelope, { appName, facility, hostname = 'shellius' }) {
  const severity = SYSLOG_SEVERITY[envelope.severity] ?? SYSLOG_SEVERITY.info;
  const pri = facility * 8 + severity;
  const structured =
    `[${SD_ID} orgId="${sd(envelope.orgId)}" eventId="${sd(envelope.id)}"` +
    ` actor="${sd(envelope.actor?.email || envelope.actor?.id || '-')}"` +
    ` resource="${sd(envelope.resource?.type || '-')}"]`;

  // The BOM tells a collector the message is UTF-8 (RFC 5424 §6.4).
  const message = `﻿${JSON.stringify(envelope)}`;
  const header = `<${pri}>1 ${envelope.occurredAt} ${hostname} ${appName} - ${envelope.action} ${structured} `;
  const payload = Buffer.from(header + message, 'utf8');

  // Octet counting: the byte length, a space, then exactly that many bytes.
  return Buffer.concat([Buffer.from(`${payload.length} `, 'ascii'), payload]);
}

async function connect(config) {
  const options = {
    host: config.host,
    port: config.port,
    ...(config.tls
      ? {
          rejectUnauthorized: config.rejectUnauthorized,
          ...(config.caCert ? { ca: config.caCert } : {}),
          ...(config.clientCert ? { cert: config.clientCert } : {}),
          ...(config.clientKey ? { key: config.clientKey } : {}),
        }
      : {}),
  };

  const socket = config.tls ? tls.connect(options) : net.connect(options);
  socket.setTimeout(CONNECT_TIMEOUT_MS);

  try {
    await Promise.race([
      once(socket, config.tls ? 'secureConnect' : 'connect'),
      once(socket, 'error').then(([err]) => {
        throw err;
      }),
      once(socket, 'timeout').then(() => {
        throw new Error('connection timed out');
      }),
    ]);
  } catch (err) {
    socket.destroy();
    throw new RetryableSinkError(`Could not connect to ${config.host}:${config.port} — ${err.message}`, { cause: err });
  }

  socket.setTimeout(0);
  return socket;
}

/**
 * Write every frame, respecting backpressure. A short-lived connection per
 * batch: simpler than pooling, and a batch is at most a few hundred frames.
 */
async function writeAll(socket, frames) {
  let failure = null;
  const onError = (err) => {
    failure = err;
  };
  socket.on('error', onError);

  try {
    for (const frame of frames) {
      if (failure) throw failure;
      if (!socket.write(frame)) {
        await Promise.race([
          once(socket, 'drain'),
          once(socket, 'error').then(([err]) => {
            throw err;
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('write stalled')), DRAIN_TIMEOUT_MS)),
        ]);
      }
    }
    // Wait for the kernel to accept everything before calling it delivered.
    await new Promise((resolve) => socket.end(resolve));
    if (failure) throw failure;
  } catch (err) {
    throw new RetryableSinkError(`Syslog write failed: ${err.message}`, { cause: err });
  } finally {
    socket.off('error', onError);
    socket.destroy();
  }
}

export async function deliver(config, envelopes, ctx = {}) {
  const frames = envelopes.map((e) => frameFor(e, config));
  const socket = ctx.connectImpl ? await ctx.connectImpl(config) : await connect(config);
  await writeAll(socket, frames);
  return { detail: `${frames.length} frames to ${config.host}:${config.port}` };
}

export async function test(config, ctx = {}) {
  const socket = ctx.connectImpl ? await ctx.connectImpl(config) : await connect(config);
  socket.destroy();
  return {
    ok: true,
    detail: `Connected to ${config.host}:${config.port}. Syslog cannot confirm the collector stored anything.`,
  };
}

export default { type, label, streaming, secretFields, maxBatch, validateConfig, notReadyReason, deliver, test, frameFor };
