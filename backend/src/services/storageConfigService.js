import prisma from '../config/db.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';

/**
 * storageConfigService
 *
 * Resolves the effective object-storage configuration for the application.
 * Storage is a GLOBAL singleton (scope = "global") configured by a super_admin,
 * because the storage client is needed at boot (ensureBucket) where there is no
 * org context. A DB row (when present + active) fully overrides env vars; with
 * no row we fall back to env so existing MINIO_* deployments keep working.
 *
 * Providers: 'minio' (S3-compatible self-hosted), 's3' (AWS), 'azure' (Blob).
 */

const SCOPE = 'global';
const DEFAULT_BUCKET = 'shellius-recordings';

function envProvider() {
  const p = (process.env.STORAGE_PROVIDER || '').trim().toLowerCase();
  if (p === 's3' || p === 'minio' || p === 'azure') return p;
  // Back-compat: a configured MINIO_ENDPOINT implies the minio provider.
  if (process.env.MINIO_ENDPOINT) return 'minio';
  return null;
}

/**
 * Build the effective config purely from env vars (no DB row present).
 */
function fromEnv() {
  const provider = envProvider();
  if (!provider) {
    return { provider: 'minio', configured: false, source: 'none' };
  }

  if (provider === 'azure') {
    const accessKey = process.env.AZURE_STORAGE_ACCOUNT || null;
    const secretKey = process.env.AZURE_STORAGE_KEY || null;
    const bucket = process.env.AZURE_STORAGE_CONTAINER || DEFAULT_BUCKET;
    const endpoint = process.env.AZURE_BLOB_ENDPOINT || null;
    return {
      provider, endpoint, region: null, bucket, accessKey, secretKey,
      useSsl: true, forcePathStyle: false, isActive: true,
      configured: Boolean(accessKey && secretKey), source: 'env',
    };
  }

  if (provider === 's3') {
    const accessKey = process.env.STORAGE_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID || null;
    const secretKey = process.env.STORAGE_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY || null;
    const region = process.env.STORAGE_REGION || process.env.AWS_REGION || 'us-east-1';
    const bucket = process.env.STORAGE_BUCKET || DEFAULT_BUCKET;
    const endpoint = process.env.STORAGE_ENDPOINT || null; // blank = AWS regional endpoint
    return {
      provider, endpoint, region, bucket, accessKey, secretKey,
      useSsl: true, forcePathStyle: Boolean(endpoint), isActive: true,
      configured: Boolean(accessKey && secretKey && bucket), source: 'env',
    };
  }

  // minio (S3-compatible)
  const accessKey = process.env.MINIO_ACCESS_KEY || null;
  const secretKey = process.env.MINIO_SECRET_KEY || null;
  const endpoint = process.env.MINIO_ENDPOINT || null;
  const bucket =
    process.env.MINIO_RECORDINGS_BUCKET || process.env.MINIO_BUCKET || DEFAULT_BUCKET;
  const useSsl =
    process.env.MINIO_USE_SSL === 'true' || /^https:\/\//i.test(endpoint || '');
  return {
    provider, endpoint, region: process.env.MINIO_REGION || 'us-east-1', bucket,
    accessKey, secretKey, useSsl, forcePathStyle: true, isActive: true,
    configured: Boolean(endpoint && accessKey && secretKey), source: 'env',
  };
}

/**
 * Returns the effective storage config, DB row winning over env.
 * Includes the decrypted `secretKey` — callers must never expose it.
 */
export async function getEffective() {
  let row = null;
  try {
    row = await prisma.storageConfig.findUnique({ where: { scope: SCOPE } });
  } catch (err) {
    // Table may not exist yet (pre-migration) — fall back to env silently.
    logger.debug?.('storageConfigService: storageConfig lookup failed, using env', {
      error: err.message,
    });
  }

  if (!row || !row.isActive) {
    return fromEnv();
  }

  const secretKey = row.secretKeyEncrypted ? decrypt(row.secretKeyEncrypted) : null;
  const bucket = row.bucket || DEFAULT_BUCKET;
  return {
    provider: row.provider,
    endpoint: row.endpoint || null,
    region: row.region || null,
    bucket,
    accessKey: row.accessKey || null,
    secretKey,
    useSsl: row.useSsl,
    forcePathStyle: row.forcePathStyle,
    isActive: row.isActive,
    configured: Boolean(
      row.provider === 'azure'
        ? row.accessKey && secretKey
        : row.accessKey && secretKey && bucket
    ),
    source: 'db',
  };
}

/** Public-safe view of the effective config (no secret material). */
export async function getPublic() {
  const eff = await getEffective();
  const { secretKey, ...rest } = eff;
  return { ...rest, hasSecretKey: Boolean(secretKey) };
}

/**
 * Upsert the global storage config. Encrypts the secret key when provided;
 * preserves the existing encrypted secret when omitted on update.
 */
export async function upsert(data) {
  const {
    provider, endpoint, region, bucket, accessKey, secretKey,
    useSsl, forcePathStyle, isActive,
  } = data;

  if (!['minio', 's3', 'azure'].includes(provider)) {
    throw new ApiError(400, 'provider must be one of: minio, s3, azure');
  }

  const existing = await prisma.storageConfig.findUnique({ where: { scope: SCOPE } });

  const payload = {
    provider,
    endpoint: endpoint || null,
    region: region || null,
    bucket: bucket || null,
    accessKey: accessKey || null,
    useSsl: useSsl ?? false,
    forcePathStyle: forcePathStyle ?? (provider === 'minio'),
    isActive: isActive ?? true,
  };

  if (secretKey) {
    payload.secretKeyEncrypted = encrypt(secretKey);
  } else if (!existing) {
    payload.secretKeyEncrypted = null;
  }
  // On update without a new secret: leave secretKeyEncrypted unchanged.

  const row = existing
    ? await prisma.storageConfig.update({ where: { scope: SCOPE }, data: payload })
    : await prisma.storageConfig.create({ data: { scope: SCOPE, ...payload } });

  logger.info('storageConfigService.upsert: storage config saved', { provider });
  invalidate();
  return maskRow(row);
}

/** Delete the DB row, reverting to env defaults. */
export async function remove() {
  await prisma.storageConfig.deleteMany({ where: { scope: SCOPE } });
  invalidate();
  logger.info('storageConfigService.remove: storage config deleted');
}

export function maskRow(row) {
  if (!row) return null;
  const { secretKeyEncrypted, ...rest } = row;
  return { ...rest, hasSecretKey: !!secretKeyEncrypted };
}

// --- client cache invalidation hook (wired by storageService) ---
let _invalidate = () => {};
export function onInvalidate(fn) {
  _invalidate = typeof fn === 'function' ? fn : () => {};
}
function invalidate() {
  try {
    _invalidate();
  } catch (err) {
    logger.warn('storageConfigService: invalidate hook failed', { error: err.message });
  }
}
