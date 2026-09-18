#!/usr/bin/env node
/**
 * scripts/reencrypt.mjs
 *
 * Walks every column in the database that stores an AES-256-GCM encrypted
 * secret and re-encrypts it with the CURRENT SERVER_ENCRYPTION_KEY, writing
 * the versioned (v2:<keyId>:...) envelope. Safe to run at any time — rows
 * already on the current key are skipped — but it is primarily meant to be
 * run right after rotating SERVER_ENCRYPTION_KEY (with the old key moved to
 * SERVER_ENCRYPTION_KEY_PREVIOUS so decrypt() can still read old rows during
 * the run).
 *
 * Usage:
 *   node scripts/reencrypt.mjs --dry-run   # report only, no writes
 *   node scripts/reencrypt.mjs             # re-encrypt in place
 *
 * Also available as: npm run crypto:reencrypt -- --dry-run
 *
 * Never prints plaintext or ciphertext — only counts and error messages.
 */

import prisma from '../src/config/db.js';
import { encrypt, decrypt, isCurrentEnvelope } from '../src/utils/crypto.js';
import logger from '../src/utils/logger.js';

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 200;

/**
 * Declarative list of every DB column holding an AES-256-GCM encrypted
 * secret. Each entry re-encrypts one or more fields on one Prisma model.
 * `fields` are re-encrypted independently (a row may have some fields
 * already on the current key and others not).
 */
const TARGETS = [
  { model: 'caKeyPair', fields: ['encryptedPrivateKey'] },
  { model: 'sshKey', fields: ['privateKeyEncrypted', 'passphraseEncrypted'] },
  { model: 'credential', fields: ['passwordEncrypted'] },
  { model: 'server', fields: ['rdpPasswordEncrypted'] },
  { model: 'ssoConfig', fields: ['clientSecretEncrypted'] },
  { model: 'smtpConfig', fields: ['passwordEncrypted'] },
  { model: 'storageConfig', fields: ['secretKeyEncrypted'] },
  {
    model: 'onboardingCredential',
    fields: ['secretEncrypted', 'passwordEncrypted', 'passphraseEncrypted', 'sudoPasswordEncrypted'],
  },
  { model: 'user', fields: ['mfaTotpSecretEnc', 'mfaTotpPendingEnc'] },
];

// ImportRow does not have a flat encrypted column — the rdpPassword secret
// captured during bulk import lives nested inside the `raw` Json blob under
// `rdpPasswordEnc` (see importService.js:sanitizeRaw). Handled separately
// below since it needs a JSON read-modify-write rather than a plain column.
const IMPORT_ROW_JSON_KEY = 'rdpPasswordEnc';

/** Re-encrypt every declared field on one row. Returns per-field outcome. */
function reencryptRow(row, fields) {
  const data = {};
  const outcome = { changed: false, skipped: [], failed: [] };

  for (const field of fields) {
    const value = row[field];
    if (!value) continue; // nullable field, nothing to do
    if (isCurrentEnvelope(value)) {
      outcome.skipped.push(field);
      continue;
    }
    try {
      const plaintext = decrypt(value);
      data[field] = encrypt(plaintext);
      outcome.changed = true;
    } catch (err) {
      outcome.failed.push({ field, message: err.message });
    }
  }

  return { data, outcome };
}

async function processModel(model, fields) {
  const client = prisma[model];
  if (!client) {
    throw new Error(`Unknown Prisma model: ${model}`);
  }

  const summary = { model, total: 0, reencrypted: 0, alreadyCurrent: 0, failed: 0, failures: [] };

  let cursor;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await client.findMany({
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: Object.fromEntries([['id', true], ...fields.map((f) => [f, true])]),
    });
    if (rows.length === 0) break;

    // Process in small transactions so a mid-batch failure doesn't leave a
    // half-updated batch inconsistent, while still allowing per-row
    // decrypt failures to be recorded without aborting the whole run.
    for (const row of rows) {
      summary.total += 1;
      const { data, outcome } = reencryptRow(row, fields);

      if (outcome.failed.length) {
        summary.failed += 1;
        for (const f of outcome.failed) {
          summary.failures.push({ id: row.id, field: f.field, message: f.message });
        }
      }

      if (outcome.skipped.length && !outcome.changed) {
        summary.alreadyCurrent += 1;
      }

      if (outcome.changed && Object.keys(data).length > 0) {
        if (!DRY_RUN) {
          await prisma.$transaction(async (tx) => {
            await tx[model].update({ where: { id: row.id }, data });
          });
        }
        summary.reencrypted += 1;
      }
    }

    cursor = rows[rows.length - 1].id;
    if (rows.length < BATCH_SIZE) break;
  }

  return summary;
}

/**
 * ImportRow.raw is a Json blob that may embed a single encrypted secret at
 * raw.rdpPasswordEnc. Only rows that actually have that key are touched.
 */
async function processImportRowJson() {
  const summary = { model: 'importRow.raw.rdpPasswordEnc', total: 0, reencrypted: 0, alreadyCurrent: 0, failed: 0, failures: [] };

  let cursor;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await prisma.importRow.findMany({
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, raw: true },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      const value = row.raw?.[IMPORT_ROW_JSON_KEY];
      if (!value || typeof value !== 'string') continue;
      summary.total += 1;

      if (isCurrentEnvelope(value)) {
        summary.alreadyCurrent += 1;
        continue;
      }

      try {
        const plaintext = decrypt(value);
        const newRaw = { ...row.raw, [IMPORT_ROW_JSON_KEY]: encrypt(plaintext) };
        if (!DRY_RUN) {
          await prisma.$transaction(async (tx) => {
            await tx.importRow.update({ where: { id: row.id }, data: { raw: newRaw } });
          });
        }
        summary.reencrypted += 1;
      } catch (err) {
        summary.failed += 1;
        summary.failures.push({ id: row.id, field: IMPORT_ROW_JSON_KEY, message: err.message });
      }
    }

    cursor = rows[rows.length - 1].id;
    if (rows.length < BATCH_SIZE) break;
  }

  return summary;
}

async function main() {
  logger.info(`crypto:reencrypt starting${DRY_RUN ? ' (dry run)' : ''}`);

  const summaries = [];
  for (const { model, fields } of TARGETS) {
    try {
      const summary = await processModel(model, fields);
      summaries.push(summary);
    } catch (err) {
      logger.error(`crypto:reencrypt: fatal error processing model ${model}: ${err.message}`);
      summaries.push({ model, total: 0, reencrypted: 0, alreadyCurrent: 0, failed: 0, failures: [], fatal: err.message });
    }
  }

  try {
    summaries.push(await processImportRowJson());
  } catch (err) {
    logger.error(`crypto:reencrypt: fatal error processing importRow.raw: ${err.message}`);
    summaries.push({ model: 'importRow.raw.rdpPasswordEnc', total: 0, reencrypted: 0, alreadyCurrent: 0, failed: 0, failures: [], fatal: err.message });
  }

  // eslint-disable-next-line no-console
  console.log(`\n=== crypto:reencrypt summary${DRY_RUN ? ' (dry run — no writes made)' : ''} ===`);
  let grandTotal = 0;
  let grandReencrypted = 0;
  let grandFailed = 0;
  for (const s of summaries) {
    grandTotal += s.total;
    grandReencrypted += s.reencrypted;
    grandFailed += s.failed;
    // eslint-disable-next-line no-console
    console.log(
      `  ${s.model.padEnd(20)} total=${s.total} reencrypted=${s.reencrypted} ` +
        `alreadyCurrent=${s.alreadyCurrent} failed=${s.failed}${s.fatal ? ` FATAL=${s.fatal}` : ''}`
    );
    if (s.failures.length) {
      for (const f of s.failures) {
        // Never print the plaintext/ciphertext — only which row+field failed and why.
        // eslint-disable-next-line no-console
        console.log(`      FAILED id=${f.id} field=${f.field} reason=${f.message}`);
      }
    }
  }
  // eslint-disable-next-line no-console
  console.log(`  ---`);
  // eslint-disable-next-line no-console
  console.log(`  TOTAL rows=${grandTotal} reencrypted=${grandReencrypted} failed=${grandFailed}\n`);

  await prisma.$disconnect();
  process.exit(grandFailed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  logger.error(`crypto:reencrypt: unhandled error: ${err.message}`);
  await prisma.$disconnect();
  process.exit(1);
});
