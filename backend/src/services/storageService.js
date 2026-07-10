/**
 * storageService.js
 *
 * Provider-agnostic object storage. Session recordings (asciinema .cast files)
 * are the primary consumer today; other callers can reuse the same client.
 *
 * Backends:
 *   - 'minio' / 's3' → AWS SDK v3 (@aws-sdk/client-s3). MinIO is just an
 *     S3-compatible endpoint with path-style addressing (forcePathStyle).
 *   - 'azure'        → @azure/storage-blob.
 *
 * Config comes from storageConfigService.getEffective() (DB row overrides env).
 *
 * Design contracts preserved for existing callers:
 *   - isConfigured() → boolean (now async).
 *   - getObjectStream() resolves to a Node Readable that supports .pipe() and
 *     emits 'error'; a missing object throws an error with .code === 'NoSuchKey'.
 *   - putObjectStream(key, stream, { contentType, metadata }) uploads a stream.
 *   - ensureBucket() is idempotent and best-effort (boot must not crash).
 *   - Never logs credentials.
 */

import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketPolicyCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import logger from '../utils/logger.js';
import * as storageConfigService from './storageConfigService.js';

// Cache the built backend keyed by a signature of the effective config so we
// rebuild only when the config actually changes (or is invalidated on save).
let _cache = null; // { sig, backend }

storageConfigService.onInvalidate(() => {
  _cache = null;
});

function notConfiguredError() {
  const err = new Error('Object storage is not configured');
  err.statusCode = 503;
  err.errorCode = 'STORAGE_NOT_CONFIGURED';
  return err;
}

function mapMissing(err) {
  // Normalise "object not found" across SDKs to the contract callers expect.
  const status = err?.$metadata?.httpStatusCode || err?.statusCode;
  const name = err?.name || err?.code;
  if (
    name === 'NoSuchKey' ||
    name === 'NotFound' ||
    name === 'BlobNotFound' ||
    status === 404
  ) {
    err.code = 'NoSuchKey';
  }
  return err;
}

/** Build a full URL endpoint for the S3 SDK from a bare host or URL form. */
function s3Endpoint(cfg) {
  const raw = (cfg.endpoint || '').trim();
  if (!raw) return undefined; // AWS regional endpoint
  if (/^https?:\/\//i.test(raw)) return raw;
  const scheme = cfg.useSsl ? 'https' : 'http';
  return `${scheme}://${raw}`;
}

// --- S3 / MinIO backend ----------------------------------------------------

function makeS3Backend(cfg) {
  const client = new S3Client({
    region: cfg.region || 'us-east-1',
    endpoint: s3Endpoint(cfg),
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
  });
  const defBucket = cfg.bucket;

  // S3 metadata keys must not carry the x-amz-meta- prefix (the SDK adds it).
  const cleanMeta = (metadata = {}) => {
    const out = {};
    for (const [k, v] of Object.entries(metadata)) {
      out[k.replace(/^x-amz-meta-/i, '')] = String(v);
    }
    return out;
  };

  return {
    provider: cfg.provider,
    async ensureBucket(bucket = defBucket) {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (err) {
        const status = err?.$metadata?.httpStatusCode;
        if (status && status !== 404 && status !== 403) {
          // Anything other than missing/forbidden is unexpected — surface it.
          if (err?.name !== 'NotFound' && err?.name !== 'NoSuchBucket') throw err;
        }
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
        logger.info('storageService: provisioned bucket', { bucket });
        // Deny-public policy — recordings served only via the authed backend.
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
          await client.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: policy }));
        } catch (e) {
          logger.warn('storageService: setBucketPolicy failed (non-fatal)', {
            bucket,
            error: e.message,
          });
        }
      }
      return bucket;
    },
    async putObjectStream(key, stream, { contentType, metadata, bucket = defBucket } = {}) {
      const upload = new Upload({
        client,
        params: {
          Bucket: bucket,
          Key: key,
          Body: stream,
          ContentType: contentType || 'application/octet-stream',
          Metadata: cleanMeta(metadata),
        },
      });
      return upload.done();
    },
    async getObjectStream(key, { bucket = defBucket } = {}) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return res.Body; // Node Readable in the Node runtime
      } catch (err) {
        throw mapMissing(err);
      }
    },
    async statObject(key, { bucket = defBucket } = {}) {
      try {
        return await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      } catch (err) {
        throw mapMissing(err);
      }
    },
    async deleteObject(key, { bucket = defBucket } = {}) {
      return client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

// --- Azure Blob backend ----------------------------------------------------

function makeAzureBackend(cfg) {
  // accessKey = account name, secretKey = account key, bucket = container.
  const cred = new StorageSharedKeyCredential(cfg.accessKey, cfg.secretKey);
  const url = cfg.endpoint || `https://${cfg.accessKey}.blob.core.windows.net`;
  const svc = new BlobServiceClient(url, cred);
  const defContainer = cfg.bucket;

  return {
    provider: 'azure',
    async ensureBucket(container = defContainer) {
      const cc = svc.getContainerClient(container);
      await cc.createIfNotExists(); // private access by default
      return container;
    },
    async putObjectStream(key, stream, { contentType, bucket = defContainer } = {}) {
      const cc = svc.getContainerClient(bucket);
      const blob = cc.getBlockBlobClient(key);
      return blob.uploadStream(stream, 4 * 1024 * 1024, 5, {
        blobHTTPHeaders: { blobContentType: contentType || 'application/octet-stream' },
      });
    },
    async getObjectStream(key, { bucket = defContainer } = {}) {
      const cc = svc.getContainerClient(bucket);
      const blob = cc.getBlockBlobClient(key);
      try {
        const dl = await blob.download();
        return dl.readableStreamBody;
      } catch (err) {
        throw mapMissing(err);
      }
    },
    async statObject(key, { bucket = defContainer } = {}) {
      const cc = svc.getContainerClient(bucket);
      const blob = cc.getBlockBlobClient(key);
      try {
        return await blob.getProperties();
      } catch (err) {
        throw mapMissing(err);
      }
    },
    async deleteObject(key, { bucket = defContainer } = {}) {
      const cc = svc.getContainerClient(bucket);
      return cc.getBlockBlobClient(key).deleteIfExists();
    },
  };
}

// --- backend resolution ----------------------------------------------------

function sigOf(cfg) {
  return [
    cfg.provider, cfg.endpoint, cfg.region, cfg.bucket,
    cfg.accessKey, cfg.useSsl, cfg.forcePathStyle,
    cfg.secretKey ? 'k' : '0',
  ].join('|');
}

async function getBackend() {
  const cfg = await storageConfigService.getEffective();
  if (!cfg.configured) throw notConfiguredError();
  const sig = sigOf(cfg);
  if (_cache && _cache.sig === sig) return _cache.backend;
  const backend = cfg.provider === 'azure' ? makeAzureBackend(cfg) : makeS3Backend(cfg);
  _cache = { sig, backend };
  logger.info('storageService: client initialized', {
    provider: cfg.provider,
    bucket: cfg.bucket,
    source: cfg.source,
  });
  return backend;
}

// --- public API (preserved) ------------------------------------------------

/** True if object storage is configured (env or DB). Async. */
export async function isConfigured() {
  const cfg = await storageConfigService.getEffective();
  return Boolean(cfg.configured);
}

/** Effective bucket/container name. Async. */
export async function recordingsBucket() {
  const cfg = await storageConfigService.getEffective();
  return cfg.bucket;
}

export async function ensureBucket(bucket) {
  const backend = await getBackend();
  return backend.ensureBucket(bucket);
}

export async function putObjectStream(key, stream, opts = {}) {
  const backend = await getBackend();
  return backend.putObjectStream(key, stream, opts);
}

export async function getObjectStream(key, opts = {}) {
  const backend = await getBackend();
  return backend.getObjectStream(key, opts);
}

export async function statObject(key, opts = {}) {
  const backend = await getBackend();
  return backend.statObject(key, opts);
}

export async function deleteObject(key, opts = {}) {
  const backend = await getBackend();
  return backend.deleteObject(key, opts);
}
