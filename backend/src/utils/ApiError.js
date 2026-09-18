/**
 * Operational API error.
 *
 *   new ApiError(404, 'Server not found')
 *   new ApiError(423, 'Account locked', { code: 'ACCOUNT_LOCKED', details: { retryAfterSeconds: 900 } })
 *
 * `code` is a stable machine-readable string the frontend can branch on; when
 * omitted the envelope falls back to the numeric status (legacy behaviour).
 * The third argument may also be the legacy `isOperational` boolean.
 */
class ApiError extends Error {
  constructor(statusCode, message, opts = {}) {
    super(message);
    this.statusCode = statusCode;
    if (typeof opts === 'boolean') {
      this.isOperational = opts;
    } else {
      this.isOperational = opts.isOperational ?? true;
      this.code = opts.code;
      this.details = opts.details;
    }
  }
}

export default ApiError;
