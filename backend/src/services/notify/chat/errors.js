/**
 * Chat delivery failure modes.
 *
 * The same retryable/permanent split the audit sinks use, for the same
 * reason: retrying cannot fix a revoked token or a deleted channel, and not
 * retrying loses a message to a blip.
 */

export class ChatConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChatConfigError';
    this.permanent = true;
  }
}

export class RetryableChatError extends Error {
  constructor(message, { retryAfterMs = null } = {}) {
    super(message);
    this.name = 'RetryableChatError';
    this.retryable = true;
    this.retryAfterMs = retryAfterMs;
  }
}

export class PermanentChatError extends Error {
  constructor(message, { disable = false } = {}) {
    super(message);
    this.name = 'PermanentChatError';
    this.retryable = false;
    /** True when the destination itself is broken, not just this message. */
    this.disable = disable;
  }
}

export default { ChatConfigError, RetryableChatError, PermanentChatError };
