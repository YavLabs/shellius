/**
 * s3 — gzipped NDJSON objects in the install's object store.
 *
 * What most compliance teams actually ask for: the log, in a bucket, in a
 * format anything can read. Reuses storageService, which already speaks S3
 * and Azure Blob and accepts a per-call bucket override.
 *
 * The object key is derived from the batch id, so a retried batch overwrites
 * rather than duplicating. That makes this sink effectively exactly-once
 * even though the pipeline as a whole promises at-least-once.
 *
 * Known limit, stated in the UI: storageConfigService is a single global
 * configuration for the install, not per-org, so a sink chooses the bucket
 * and prefix but not the credentials. An org that needs to write with its
 * own credentials should use the webhook sink.
 */

import { Readable } from 'stream';
import { createGzip } from 'zlib';
import * as storageService from '../../storageService.js';
import { RetryableSinkError, PermanentSinkError, SinkConfigError } from './errors.js';

export const type = 's3';
export const label = 'Object storage (S3-compatible)';
export const streaming = true;
export const secretFields = [];
export const maxBatch = 2000;

const SAFE_SEGMENT = /^[a-zA-Z0-9._/-]*$/;

export function validateConfig(config = {}) {
  const bucket = config.bucket ? String(config.bucket).trim() : null;
  const prefix = String(config.prefix ?? 'audit').trim().replace(/^\/+|\/+$/g, '');

  if (prefix && !SAFE_SEGMENT.test(prefix)) {
    throw new SinkConfigError('The prefix may only contain letters, numbers, dots, dashes, underscores and slashes');
  }
  if (bucket && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new SinkConfigError('That is not a valid bucket name');
  }

  return { bucket, prefix: prefix || 'audit' };
}

export function notReadyReason() {
  // The credentials come from the install's storage settings, not from here.
  return storageService.isConfigured() ? null : 'Recording storage is not configured for this install';
}

/** `audit/org=<org>/dt=<YYYY-MM-DD>/<iso>_<batch>.ndjson.gz` */
export function objectKeyFor({ prefix, orgId, from, batchId }) {
  const day = from.toISOString().slice(0, 10);
  const stamp = from.toISOString().replace(/[:.]/g, '-');
  return `${prefix}/org=${orgId}/dt=${day}/${stamp}_${batchId}.ndjson.gz`;
}

async function put(config, key, lines, { orgId, batchId, count }) {
  const source = Readable.from(lines);
  const body = source.pipe(createGzip());

  try {
    await storageService.putObjectStream(key, body, {
      contentType: 'application/gzip',
      bucket: config.bucket || undefined,
      metadata: { orgId: String(orgId), batchId: String(batchId), count: String(count) },
    });
  } catch (err) {
    const message = String(err?.message || '');
    // A missing bucket or rejected credentials will not fix itself.
    if (/NoSuchBucket|AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|not configured/i.test(message)) {
      throw new PermanentSinkError(`Object storage refused the write: ${message}`, { cause: err });
    }
    throw new RetryableSinkError(`Could not write to object storage: ${message}`, { cause: err });
  }
}

export async function deliver(config, envelopes, ctx = {}) {
  const from = envelopes.length ? new Date(envelopes[0].occurredAt) : new Date();
  const key = objectKeyFor({ prefix: config.prefix, orgId: ctx.orgId, from, batchId: ctx.batchId });

  // One JSON document per line — the format every log tool can read, and the
  // one that streams without holding the batch in memory as a single string.
  const lines = envelopes.map((e) => `${JSON.stringify(e)}\n`);

  await put(config, key, lines, { orgId: ctx.orgId, batchId: ctx.batchId, count: envelopes.length });
  return { detail: key, objectKey: key };
}

export async function test(config, ctx = {}) {
  const key = `${config.prefix}/.shellius-sink-test-${ctx.orgId ?? 'org'}`;
  await put(config, key, ['{"test":true}\n'], { orgId: ctx.orgId ?? 'org', batchId: 'test', count: 1 });
  try {
    await storageService.deleteObject(key, { bucket: config.bucket || undefined });
  } catch {
    // Leaving the probe object behind is untidy, not a failure.
  }
  return { ok: true, detail: `Wrote and removed ${key}` };
}

export default { type, label, streaming, secretFields, maxBatch, validateConfig, notReadyReason, deliver, test, objectKeyFor };
