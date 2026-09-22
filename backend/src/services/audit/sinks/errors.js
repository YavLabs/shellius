/**
 * Two kinds of delivery failure, because they need opposite responses.
 *
 * Retryable — the destination is down, rate-limiting us, or timed out. The
 * cursor stays put and the batch goes again after a backoff. Duplicates at
 * the far end are the accepted cost of never losing an entry.
 *
 * Permanent — the configuration is wrong: a URL that 404s, a bucket that
 * doesn't exist, credentials that are rejected. Retrying forever would just
 * hide it, so the sink is switched off and somebody is told.
 */

export class RetryableSinkError extends Error {
  constructor(message, { retryAfterMs = null, cause = null } = {}) {
    super(message);
    this.name = 'RetryableSinkError';
    this.retryable = true;
    this.retryAfterMs = retryAfterMs;
    if (cause) this.cause = cause;
  }
}

export class PermanentSinkError extends Error {
  constructor(message, { cause = null } = {}) {
    super(message);
    this.name = 'PermanentSinkError';
    this.retryable = false;
    if (cause) this.cause = cause;
  }
}

/** Configuration that is wrong on its face — rejected before it is saved. */
export class SinkConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SinkConfigError';
  }
}

export default { RetryableSinkError, PermanentSinkError, SinkConfigError };
