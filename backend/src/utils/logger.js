import winston from 'winston';
import config from '../config/index.js';

const { combine, timestamp, colorize, printf, json } = winston.format;

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;

// Field names that *look* secret-ish (contain "key") but are actually
// harmless identifiers/metadata and must NOT be redacted.
const KEY_FIELD_ALLOWLIST = /^(.*key)?(id|type|fingerprint|algorithm|pair|pairid)$/i;
const PUBLIC_KEY_FIELD = /publickey/i;

// Generic secret-bearing field names (password, passphrase, token, ticket,
// authorization header, cookies, etc.) — always redacted regardless of the
// "key" carve-outs above.
const SENSITIVE_FIELD = /pass|secret|token|ticket|authoriz|cookie|privatekey|passphrase/i;

function isSensitiveKey(fieldName) {
  if (typeof fieldName !== 'string') return false;
  if (SENSITIVE_FIELD.test(fieldName)) return true;
  if (/key/i.test(fieldName)) {
    if (PUBLIC_KEY_FIELD.test(fieldName)) return false;
    if (KEY_FIELD_ALLOWLIST.test(fieldName)) return false;
    return true;
  }
  return false;
}

export function redactValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return value;

  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, depth + 1));
  }

  if (value instanceof Error) {
    // Keep Error instances intact (winston relies on them for stack
    // formatting) — errors shouldn't normally carry secrets in .message.
    return value;
  }

  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redactValue(v, depth + 1);
    }
    return out;
  }

  return value;
}

// Redacts sensitive fields in the log metadata object (everything except
// level/message/timestamp). Mutates `info` in place (rather than returning a
// new object) so winston's internal LEVEL/MESSAGE/SPLAT symbols — which
// colorize()/json() rely on — are preserved.
const redactMeta = winston.format((info) => {
  for (const key of Object.keys(info)) {
    if (key === 'level' || key === 'message' || key === 'timestamp') continue;
    info[key] = isSensitiveKey(key) ? REDACTED : redactValue(info[key], 0);
  }
  return info;
});

const devFormat = combine(
  redactMeta(),
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  printf(({ timestamp: ts, level, message, ...meta }) => {
    const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${ts} ${level}: ${message}${extra}`;
  }),
);

const prodFormat = combine(
  redactMeta(),
  timestamp(),
  json(),
);

const logger = winston.createLogger({
  level: config.nodeEnv === 'development' ? 'debug' : 'info',
  format: config.nodeEnv === 'development' ? devFormat : prodFormat,
  transports: [new winston.transports.Console()],
});

export default logger;
