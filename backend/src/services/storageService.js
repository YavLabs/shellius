/**
 * storageService.js
 *
 * Thin wrapper around the MinIO S3-compatible client. Session recordings
 * (asciinema .cast files) are the primary consumer today; other object-
 * storage callers can reuse the same client.
 *
 * Design:
 *   - Lazy client: not created until first use.
 *   - Fails soft on boot (ensureBucket is best-effort so a missing MinIO
 *     doesn't crash the backend — web terminal continues to work without
 *     recording).
 *   - Never logs credentials.
 */

import { Client as MinioClient } from 'minio';
import logger from '../utils/logger.js';

let _client = null;

/**
 * Returns true if MinIO is configured via env vars.
 */
export function isConfigured() {
  const { MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY } = process.env;
  return Boolean(MINIO_ENDPOINT && MINIO_ACCESS_KEY && MINIO_SECRET_KEY);
}

/**
 * Returns the default recordings bucket name.
 */
export function recordingsBucket() {
  return process.env.MINIO_RECORDINGS_BUCKET || 'shellius-recordings';
}

/**
 * Lazily instantiate the MinIO client.
 * Throws a structured 503 if MinIO is not configured.
 */
export function getClient() {
  if (!isConfigured()) {
    const err = new Error('Object storage (MinIO) is not configured');
    err.statusCode = 503;
    err.errorCode = 'STORAGE_NOT_CONFIGURED';
    throw err;
  }
  if (!_client) {
    const { MINIO_ENDPOINT, MINIO_PORT, MINIO_USE_SSL, MINIO_ACCESS_KEY, MINIO_SECRET_KEY } =
      process.env;
    _client = new MinioClient({
      endPoint: MINIO_ENDPOINT,
      port: parseInt(MINIO_PORT || '9000', 10),
      useSSL: MINIO_USE_SSL === 'true',
      accessKey: MINIO_ACCESS_KEY,
      secretKey: MINIO_SECRET_KEY,
    });
    logger.info('storageService: MinIO client initialized', {
      endpoint: MINIO_ENDPOINT,
    });
  }
  return _client;
}

/**
 * Ensure a bucket exists with a deny-public policy. Idempotent.
 * Safe to call on every boot.
 */
export async function ensureBucket(bucket = recordingsBucket()) {
  const client = getClient();
  const exists = await client.bucketExists(bucket);
  if (!exists) {
    await client.makeBucket(bucket, 'us-east-1');
    logger.info('storageService: provisioned bucket', { bucket });

    // Deny-public bucket policy — recordings must only be served via the
    // authenticated backend route, never fetched directly from MinIO.
    const policy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Deny',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${bucket}/*`],
          Condition: { StringNotEquals: { 'aws:PrincipalType': 'Service' } },
        },
      ],
    });
    try {
      await client.setBucketPolicy(bucket, policy);
    } catch (err) {
      // Non-fatal — some MinIO versions reject conditional policies.
      logger.warn('storageService: setBucketPolicy failed (non-fatal)', {
        bucket,
        error: err.message,
      });
    }
  }
  return bucket;
}

/**
 * Upload a stream to MinIO. Returns the ETag on success.
 */
export async function putObjectStream(
  key,
  stream,
  { contentType = 'application/octet-stream', metadata = {}, bucket = recordingsBucket() } = {}
) {
  const client = getClient();
  const metaHeaders = { 'Content-Type': contentType, ...metadata };
  // Pass -1 to let the client compute size from the stream.
  return client.putObject(bucket, key, stream, undefined, metaHeaders);
}

/**
 * Return a readable stream for an object. Caller must pipe / consume it.
 * Throws the MinIO error with `.code === 'NoSuchKey'` if the object is missing.
 */
export async function getObjectStream(key, { bucket = recordingsBucket() } = {}) {
  const client = getClient();
  return client.getObject(bucket, key);
}

export async function statObject(key, { bucket = recordingsBucket() } = {}) {
  const client = getClient();
  return client.statObject(bucket, key);
}

export async function deleteObject(key, { bucket = recordingsBucket() } = {}) {
  const client = getClient();
  return client.removeObject(bucket, key);
}
