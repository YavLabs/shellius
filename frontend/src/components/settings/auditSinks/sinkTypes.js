import { Webhook, HardDrive, Radio, Mail } from 'lucide-react';

/**
 * Audit sink catalogue for Administration → Audit sinks. Mirrors the backend
 * adapters (backend/src/services/audit/sinks/*.js) field-for-field. `secret:
 * true` fields are write-only: the API returns { set } for them and keeps
 * the stored value when the field is left blank on edit — exactly like the
 * email providers (services/email/providers).
 *
 * Field: { key, label, kind: 'text'|'number'|'password'|'textarea'|'select'|
 *          'switch'|'json'|'emails', options?, placeholder?, required?,
 *          secret?, help?, showIf?(values) }
 *
 * 'json' and 'emails' are text-entry kinds whose stored shape isn't a plain
 * string (an object, an array) — parseHeadersInput/parseRecipientsInput
 * below convert the textarea to and from that shape.
 */

export const SINK_TYPES = [
  {
    type: 'webhook',
    label: 'Webhook (HTTP POST)',
    icon: Webhook,
    description: 'Batched JSON POST to any HTTP collector — Splunk HEC, Datadog, Panther, or your own endpoint.',
    streaming: true,
    help:
      'Requires https. Each batch is signed with the signing secret (HMAC-SHA256) if one is set, and carries a stable batch id as an idempotency key — delivery is at-least-once, so a receiver should dedupe on it.',
    defaults: { timeoutMs: 15000 },
    fields: [
      { key: 'url', label: 'URL', kind: 'text', placeholder: 'https://collector.example.com/hooks/shellius', required: true },
      { key: 'signingSecret', label: 'Signing secret', kind: 'password', secret: true, help: 'Lets the receiver verify a batch really came from Shellius.' },
      { key: 'headers', label: 'Extra headers', kind: 'json', placeholder: '{"Authorization": "Bearer …"}', help: 'Optional JSON object, sent with every request.' },
      { key: 'timeoutMs', label: 'Timeout (ms)', kind: 'number', placeholder: '15000', help: '1,000–120,000.' },
    ],
  },
  {
    type: 's3',
    label: 'Object storage (S3-compatible)',
    icon: HardDrive,
    description: 'Gzipped NDJSON objects, written to the object store this install already uses for recordings.',
    streaming: true,
    help:
      "Credentials come from the install's storage settings, not from here — this sink can only be pointed at a bucket and prefix. An org that needs to write with its own credentials should use a webhook instead.",
    defaults: { prefix: 'audit' },
    fields: [
      { key: 'bucket', label: 'Bucket', kind: 'text', placeholder: "Defaults to the install's recording bucket" },
      { key: 'prefix', label: 'Prefix', kind: 'text', placeholder: 'audit' },
    ],
  },
  {
    type: 'syslog',
    label: 'Syslog (RFC 5424)',
    icon: Radio,
    description: 'RFC 5424 messages over TCP or TLS, for a SIEM syslog collector.',
    streaming: true,
    help:
      'A TCP write is not an acknowledgement: syslog has no reply, so "delivered" only means the bytes were accepted by the socket, not that the collector stored them.',
    defaults: { port: 6514, tls: true, rejectUnauthorized: true, appName: 'shellius', facility: 13 },
    fields: [
      { key: 'host', label: 'Host', kind: 'text', placeholder: 'siem.example.com', required: true },
      { key: 'port', label: 'Port', kind: 'number', placeholder: '6514' },
      { key: 'tls', label: 'Use TLS', kind: 'switch' },
      { key: 'rejectUnauthorized', label: 'Verify server certificate', kind: 'switch', showIf: (v) => v.tls !== false },
      { key: 'caCert', label: 'CA certificate (PEM)', kind: 'textarea', help: 'Optional — only needed for a private CA.', showIf: (v) => v.tls !== false },
      { key: 'clientCert', label: 'Client certificate (PEM)', kind: 'textarea', help: 'Optional — for mutual TLS.', showIf: (v) => v.tls !== false },
      { key: 'clientKey', label: 'Client private key (PEM)', kind: 'textarea', secret: true, help: 'Optional — for mutual TLS.', showIf: (v) => v.tls !== false },
      { key: 'appName', label: 'App name', kind: 'text', placeholder: 'shellius' },
      { key: 'facility', label: 'Facility', kind: 'number', placeholder: '13', help: '0–23. 13 = log audit.' },
    ],
  },
  {
    type: 'email_digest',
    label: 'Email digest',
    icon: Mail,
    description: 'A periodic summary email — not a stream.',
    streaming: false,
    help: 'This is a schedule, not a live feed: it carries no cursor, lag or retry state the way the other three sinks do.',
    defaults: { schedule: 'daily', hour: 7, format: 'csv' },
    fields: [
      { key: 'recipients', label: 'Recipients', kind: 'emails', required: true, placeholder: 'security@example.com, oncall@example.com' },
      {
        key: 'schedule',
        label: 'Schedule',
        kind: 'select',
        options: [
          { value: 'daily', label: 'Daily' },
          { value: 'weekly', label: 'Weekly' },
        ],
      },
      { key: 'hour', label: 'Hour (UTC)', kind: 'number', placeholder: '7', help: '0–23.' },
      {
        key: 'format',
        label: 'Attachment format',
        kind: 'select',
        options: [
          { value: 'csv', label: 'CSV' },
          { value: 'json', label: 'JSON' },
        ],
      },
    ],
  },
];

export function getSinkType(type) {
  return SINK_TYPES.find((t) => t.type === type) || null;
}

/** The fields of `type` that apply given the current form `values` (showIf). */
export function visibleFieldsFor(type, values = {}) {
  const def = getSinkType(type);
  return (def?.fields || []).filter((f) => !f.showIf || f.showIf(values || {}));
}

// ---------------------------------------------------------------------------
// Status + lag — how the list badges a sink.
// ---------------------------------------------------------------------------

/**
 * A sink's headline state, worst first: a permanent/repeated failure that
 * switched it off, then simply off, then failing but still retrying, then
 * healthy. `disabledReason` always wins — a disabled sink stays disabled
 * even if `isActive` hasn't been flipped in whatever payload is passed in.
 */
export function sinkStatus(sink) {
  if (!sink) return { tone: 'neutral', label: 'Unknown' };
  if (sink.disabledReason) return { tone: 'danger', label: 'Disabled' };
  if (!sink.isActive) return { tone: 'neutral', label: 'Off' };
  if (sink.consecutiveFailures > 0) {
    return { tone: 'warning', label: `Failing (${sink.consecutiveFailures}×)` };
  }
  return { tone: 'success', label: 'Active' };
}

/**
 * "N entries behind" for a streaming sink's `lag` (how many audit rows past
 * its cursor haven't shipped yet), or null when there's nothing to show
 * (digest sinks, or a sink that isn't active).
 */
export function formatLag(lag) {
  if (lag === null || lag === undefined) return null;
  if (lag <= 0) return 'Up to date';
  return `${lag.toLocaleString()} ${lag === 1 ? 'entry' : 'entries'} behind`;
}

/** Delivery.status ('ok' | 'failed') → badge tone + label. */
export function deliveryStatusBadge(status) {
  if (status === 'ok') return { tone: 'success', label: 'Delivered' };
  if (status === 'failed') return { tone: 'danger', label: 'Failed' };
  return { tone: 'neutral', label: status || 'Unknown' };
}

// ---------------------------------------------------------------------------
// 'json' field (webhook headers) — textarea <-> object
// ---------------------------------------------------------------------------

export function parseHeadersInput(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { headers: {}, error: null };
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { headers: null, error: 'Headers must be valid JSON, e.g. {"Authorization": "Bearer …"}' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { headers: null, error: 'Headers must be a JSON object of name/value pairs' };
  }
  return { headers: parsed, error: null };
}

export function headersToText(headers) {
  if (!headers || typeof headers !== 'object' || Object.keys(headers).length === 0) return '';
  return JSON.stringify(headers, null, 2);
}

// ---------------------------------------------------------------------------
// 'emails' field (digest recipients) — textarea <-> string[]
// ---------------------------------------------------------------------------

export function parseRecipientsInput(text) {
  return [
    ...new Set(
      String(text || '')
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
}

export function recipientsToText(list) {
  return Array.isArray(list) ? list.join(', ') : '';
}

export default {
  SINK_TYPES,
  getSinkType,
  visibleFieldsFor,
  sinkStatus,
  formatLag,
  deliveryStatusBadge,
  parseHeadersInput,
  headersToText,
  parseRecipientsInput,
  recipientsToText,
};
