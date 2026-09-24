/**
 * email_digest — a periodic summary, emailed.
 *
 * The odd one out. The other three sinks stream: they hold a cursor and ship
 * every entry as it settles. This one answers a different question — "what
 * happened yesterday?" — so it works on a time window, ignores the cursor
 * columns, and runs on its own schedule.
 *
 * It shares the AuditSink table anyway, because it shares everything else: a
 * per-org row, an encrypted config blob, a test button, one settings screen
 * and one permission. `streaming: false` is what keeps the two apart, and
 * the worker only picks up streaming types.
 */

import { sendMail } from '../../mailer.js';
import { SinkConfigError, RetryableSinkError, PermanentSinkError } from './errors.js';

export const type = 'email_digest';
export const label = 'Email digest';
export const streaming = false;
export const secretFields = [];
export const maxBatch = 0;

/** Kept well inside what mail servers accept as an attachment. */
export const MAX_DIGEST_ROWS = Number(process.env.AUDIT_DIGEST_MAX_ROWS || 20_000);

export function validateConfig(config = {}) {
  const recipients = (Array.isArray(config.recipients) ? config.recipients : [])
    .map((r) => String(r || '').trim().toLowerCase())
    .filter(Boolean);

  if (recipients.length === 0) throw new SinkConfigError('Add at least one recipient');
  if (recipients.length > 25) throw new SinkConfigError('At most 25 recipients');
  for (const r of recipients) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r)) throw new SinkConfigError(`'${r}' is not an email address`);
  }

  const schedule = config.schedule === 'weekly' ? 'weekly' : 'daily';
  const hour = Number(config.hour ?? 7);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new SinkConfigError('Hour must be between 0 and 23');
  }

  // Weekly used to carry no day at all, so the scheduler's normaliser picked
  // Monday for every weekly digest and nothing said so. A "weekly" setting
  // that silently means one specific day is a setting nobody can trust.
  let dayOfWeek = null;
  if (schedule === 'weekly') {
    dayOfWeek = config.dayOfWeek === undefined || config.dayOfWeek === null ? 1 : Number(config.dayOfWeek);
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      throw new SinkConfigError('Day must be 0 (Sunday) to 6 (Saturday)');
    }
  }

  return {
    recipients,
    schedule,
    hour,
    dayOfWeek,
    format: config.format === 'json' ? 'json' : 'csv',
  };
}

export function notReadyReason(config = {}) {
  if (!config.recipients?.length) return 'No recipients set';
  return null;
}

/** Counts by category, so the email says something without being read in full. */
export function summarize(envelopes) {
  const byCategory = new Map();
  const byActor = new Map();
  let warnings = 0;

  for (const e of envelopes) {
    byCategory.set(e.category, (byCategory.get(e.category) || 0) + 1);
    const who = e.actor?.email || e.actor?.name || e.actor?.id || 'system';
    byActor.set(who, (byActor.get(who) || 0) + 1);
    if (e.severity === 'warning') warnings += 1;
  }

  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  return { total: envelopes.length, warnings, categories: top(byCategory, 10), actors: top(byActor, 10) };
}

export async function deliver(config, envelopes, ctx = {}) {
  const { orgId, periodLabel = 'the last day', attachment = null, truncated = false } = ctx;
  const stats = summarize(envelopes);

  const rows = stats.categories
    .map(([name, n]) => `<tr><td style="padding:4px 12px 4px 0">${name}</td><td style="padding:4px 0">${n}</td></tr>`)
    .join('');

  const html = `
    <p>${stats.total.toLocaleString()} audit entries were recorded in ${periodLabel}${
      stats.warnings ? `, including <strong>${stats.warnings}</strong> worth a second look` : ''
    }.</p>
    <table style="border-collapse:collapse;font-size:14px">${rows}</table>
    ${truncated ? `<p>Only the first ${MAX_DIGEST_ROWS.toLocaleString()} entries are attached. The rest are in Shellius.</p>` : ''}
  `;

  try {
    await sendMail({
      orgId,
      to: config.recipients.join(', '),
      subject: `Shellius audit digest — ${stats.total.toLocaleString()} entries`,
      html,
      text: `${stats.total} audit entries in ${periodLabel}. ${stats.warnings} worth a second look.`,
      ...(attachment ? { attachments: [attachment] } : {}),
    });
  } catch (err) {
    const message = String(err?.message || '');
    if (/no email provider|not configured/i.test(message)) {
      throw new PermanentSinkError(`Email is not configured for this organization: ${message}`, { cause: err });
    }
    throw new RetryableSinkError(`Could not send the digest: ${message}`, { cause: err });
  }

  return { detail: `Sent to ${config.recipients.length} recipient(s)` };
}

export async function test(config, ctx = {}) {
  await deliver(config, [], { ...ctx, periodLabel: 'this test' });
  return { ok: true, detail: `Test digest sent to ${config.recipients.join(', ')}` };
}

export default { type, label, streaming, secretFields, maxBatch, MAX_DIGEST_ROWS, validateConfig, notReadyReason, deliver, test, summarize };
