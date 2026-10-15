'use strict';
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const config = require('./config');
const redis = require('./redis');
const SlidingWindowLog = require('./limiters/slidingWindowLog');
const TokenBucket = require('./limiters/tokenBucket');
const rateLimit = require('./middleware/rateLimit');
const { apiAuth, adminAuth } = require('./middleware/auth');

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', config.trustProxy);

const path = require('path');
// Security headers. upgrade-insecure-requests only in prod (breaks plain-http localhost in some browsers).
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: { 'upgrade-insecure-requests': config.isProd ? [] : null },
  },
}));
app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : false })); // locked down
app.use(express.json({ limit: '10kb' }));

const swl = new SlidingWindowLog(redis, { limit: 100, windowMs: 60_000 });          // 100 req/min
const bucket = new TokenBucket(redis, { capacity: 20, refillPerSec: 5 });           // burst 20, 5/s
const ipGuard = new TokenBucket(redis, { capacity: 60, refillPerSec: 2, prefix: 'rl:ip:' });

if (config.demoMode) {
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/demo', require('./demo')(redis));
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Layer 1: per-IP guard (stops key brute-forcing) -> Layer 2: auth -> Layer 3: per-client limiter
app.use('/api', rateLimit(ipGuard), apiAuth);
const byClient = (req) => req.client;

app.get('/api/sliding', rateLimit(swl, { keyFn: byClient }), (req, res) =>
  res.json({ algorithm: swl.name, client: req.client, message: 'allowed' }));
app.get('/api/bucket', rateLimit(bucket, { keyFn: byClient }), (req, res) =>
  res.json({ algorithm: bucket.name, client: req.client, message: 'allowed' }));

// Admin: reset a client's counters. Audit-logged. Input validated.
app.post('/admin/reset/:client', adminAuth, async (req, res, next) => {
  try {
    const client = req.params.client;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(client)) return res.status(400).json({ error: 'Invalid client id' });
    await Promise.all([swl.reset(client), bucket.reset(client)]);
    console.log(JSON.stringify({ audit: 'admin.reset', client, ip: req.ip, at: new Date().toISOString() }));
    res.json({ reset: client });
  } catch (e) { next(e); }
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
// Never leak stack traces / debug info in responses
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[error]', err.message);
  res.status(err.status || 500).json({ error: 'Internal error' });
});

module.exports = app;
