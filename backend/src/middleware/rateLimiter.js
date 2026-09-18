import rateLimit from 'express-rate-limit';
import redis from '../config/redis.js';
import logger from '../utils/logger.js';

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

/**
 * Redis-backed per-user (falls back to per-IP when unauthenticated) rate
 * limiter — for endpoints `express-rate-limit`'s in-memory store can't scope
 * correctly across multiple backend processes, and where we specifically
 * want to key on the authenticated user rather than the client IP (shared
 * NAT / office IPs would otherwise share one bucket). Fails open (allows the
 * request) if Redis is unreachable — availability over strictness for a
 * defense-in-depth control.
 *
 * @param {object} opts
 * @param {string} opts.keyPrefix     - Redis key namespace, e.g. 'rl:qc-ticket'
 * @param {number} opts.windowSeconds - fixed window size
 * @param {number} opts.max           - max requests per window per key
 */
export function userRateLimiter({ keyPrefix, windowSeconds, max }) {
  return async function rateLimitByUser(req, res, next) {
    const id = req.user?.userId || req.ip || 'anonymous';
    const key = `${keyPrefix}:${id}`;
    try {
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, windowSeconds);
      }
      if (count > max) {
        res.set('Retry-After', String(windowSeconds));
        return res.status(429).json(RATE_LIMIT_MESSAGE);
      }
      return next();
    } catch (err) {
      logger.warn('rateLimiter: userRateLimiter Redis error — failing open', { keyPrefix, error: err.message });
      return next();
    }
  };
}

/**
 * Device-auth /poll is legitimately called every `interval` seconds
 * (default 5s => ~12/min) by the TUI client until the request resolves, so
 * it needs a higher ceiling than authLimiter while still bounding brute
 * force / DoS against the deviceCode lookup.
 */
export const deviceAuthPollLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: RATE_LIMIT_MESSAGE,
});
