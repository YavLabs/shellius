import rateLimit from 'express-rate-limit';

const RATE_LIMIT_MESSAGE = { success: false, error: { code: 429, message: 'Too many requests, please try again later' } };

export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: RATE_LIMIT_MESSAGE,
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: RATE_LIMIT_MESSAGE,
});

/**
 * Stricter limiter for invite/password-reset submission endpoints.
 * 5 requests per 15 minutes per IP.
 */
export const tokenActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: RATE_LIMIT_MESSAGE,
});
