'use strict';
const config = require('../config');

/**
 * rateLimit(limiter, { keyFn }) -> Express middleware.
 * Sets RateLimit headers and returns 429 + Retry-After when blocked.
 */
module.exports = function rateLimit(limiter, { keyFn } = {}) {
  const getKey = keyFn || ((req) => req.ip);
  return async (req, res, next) => {
    try {
      const r = await limiter.consume(getKey(req));
      res.set('RateLimit-Limit', String(r.limit));
      res.set('RateLimit-Remaining', String(r.remaining));
      if (r.allowed) return next();
      const secs = Math.ceil(r.retryAfterMs / 1000);
      res.set('Retry-After', String(secs));
      return res.status(429).json({ error: 'Too Many Requests', retryAfterSeconds: secs });
    } catch (err) {
      console.error('[ratelimit] store error:', err.message);
      if (config.failMode === 'closed') return res.status(503).json({ error: 'Service unavailable' });
      return next(); // fail-open: availability over strictness
    }
  };
};
