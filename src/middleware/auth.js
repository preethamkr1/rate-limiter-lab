'use strict';
const crypto = require('crypto');
const config = require('../config');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// API key auth on every /api route. Identity (client name) comes from the server-side
// key table, never from anything the client claims.
function apiAuth(req, res, next) {
  const provided = req.get('x-api-key');
  if (provided) {
    for (const [key, name] of config.apiKeys) {
      if (safeEqual(provided, key)) { req.client = name; return next(); }
    }
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

function adminAuth(req, res, next) {
  const provided = req.get('x-admin-token');
  if (config.adminToken && provided && safeEqual(provided, config.adminToken)) return next();
  return res.status(404).json({ error: 'Not found' }); // hide admin surface
}
module.exports = { apiAuth, adminAuth };
