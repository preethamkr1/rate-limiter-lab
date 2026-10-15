'use strict';
// Demo/simulation router (DEMO_MODE only). Simulates N virtual clients hitting both limiters
// concurrently, and exposes live Redis state to the dashboard. Uses its own key prefixes
// ("demo:") so it never touches real limiter keys. Dashboard holds no secrets.
const express = require('express');
const SlidingWindowLog = require('./limiters/slidingWindowLog');
const TokenBucket = require('./limiters/tokenBucket');

const CLIENTS = Array.from({ length: 8 }, (_, i) => `client-${i + 1}`);
const ALGOS = ['swl', 'tb'];
const SWL_CFG = { limit: 10, windowMs: 10_000 };
const TB_CFG = { capacity: 10, refillPerSec: 1 };

module.exports = function demoRouter(redis) {
  const router = express.Router();
  const L = {
    swl: new SlidingWindowLog(redis, { ...SWL_CFG, prefix: 'demo:swl:' }),
    tb: new TokenBucket(redis, { ...TB_CFG, prefix: 'demo:tb:' }),
  };
  const blank = () => Object.fromEntries(CLIENTS.map((c) => [c, { swl: { allowed: 0, blocked: 0 }, tb: { allowed: 0, blocked: 0 } }]));
  let stats = blank();
  let events = [];
  const pushEvent = (e) => { events.push({ t: Date.now(), ...e }); if (events.length > 200) events = events.slice(-200); };

  const algosFor = (a) => (a === 'both' ? ALGOS : ALGOS.includes(a) ? [a] : null);
  const validClients = (list) => Array.isArray(list) && list.length > 0 && list.length <= CLIENTS.length && list.every((c) => CLIENTS.includes(c));

  async function hit(client, algo) {
    const r = await L[algo].consume(client);
    stats[client][algo][r.allowed ? 'allowed' : 'blocked']++;
    return r;
  }

  router.get('/config', (req, res) => res.json({ clients: CLIENTS, swl: SWL_CFG, tb: TB_CFG }));

  router.post('/request', async (req, res, next) => {
    try {
      const { client, algo } = req.body || {};
      const algos = algosFor(algo);
      if (!CLIENTS.includes(client) || !algos) return res.status(400).json({ error: 'Invalid input' });
      const out = {};
      for (const a of algos) {
        const r = await hit(client, a);
        out[a] = r;
        pushEvent({ client, algo: a, allowed: r.allowed, remaining: r.remaining, retryAfterMs: r.retryAfterMs });
      }
      res.json(out);
    } catch (e) { next(e); }
  });

  // Fire `count` requests per client, ALL in flight at once (true concurrency against Redis).
  router.post('/burst', async (req, res, next) => {
    try {
      const { clients, algo } = req.body || {};
      const count = Number(req.body && req.body.count);
      const algos = algosFor(algo);
      if (!validClients(clients) || !algos || !Number.isInteger(count) || count < 1 || count > 100) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      const started = Date.now();
      const tasks = [];
      for (const c of clients) for (const a of algos) for (let i = 0; i < count; i++) tasks.push(hit(c, a).then((r) => ({ c, a, r })));
      const results = await Promise.all(tasks);
      const summary = {};
      for (const { c, a, r } of results) {
        summary[c] = summary[c] || {};
        summary[c][a] = summary[c][a] || { allowed: 0, blocked: 0 };
        summary[c][a][r.allowed ? 'allowed' : 'blocked']++;
      }
      const ms = Date.now() - started;
      for (const c of clients) for (const a of algos) {
        const s = summary[c][a];
        pushEvent({ client: c, algo: a, burst: true, allowed: s.blocked === 0, text: `burst x${count}: ${s.allowed} allowed / ${s.blocked} blocked` });
      }
      res.json({ ms, total: tasks.length, summary });
    } catch (e) { next(e); }
  });

  router.post('/reset', async (req, res, next) => {
    try {
      const keys = CLIENTS.flatMap((c) => [`demo:swl:${c}`, `demo:tb:${c}`]);
      await redis.del(...keys);
      stats = blank(); events = [];
      res.json({ reset: true });
    } catch (e) { next(e); }
  });

  async function snapshot() {
    const [sec, usec] = await redis.time();
    const now = Number(sec) * 1000 + Math.floor(Number(usec) / 1000);
    const p = redis.pipeline();
    for (const c of CLIENTS) {
      p.zrange(`demo:swl:${c}`, 0, -1, 'WITHSCORES');
      p.pttl(`demo:swl:${c}`);
      p.hgetall(`demo:tb:${c}`);
      p.pttl(`demo:tb:${c}`);
    }
    const out = await p.exec();
    const clients = {};
    CLIENTS.forEach((c, i) => {
      const [, z] = out[i * 4], [, zttl] = out[i * 4 + 1], [, h] = out[i * 4 + 2], [, httl] = out[i * 4 + 3];
      const entries = [];
      for (let k = 0; k < z.length; k += 2) entries.push({ member: z[k], score: Number(z[k + 1]) });
      const live = entries.filter((e) => e.score > now - SWL_CFG.windowMs);
      let tokens = TB_CFG.capacity;
      if (h && h.tokens !== undefined) {
        tokens = Math.min(TB_CFG.capacity, Number(h.tokens) + Math.max(0, now - Number(h.ts)) * (TB_CFG.refillPerSec / 1000));
      }
      clients[c] = {
        swl: { count: live.length, agesMs: live.map((e) => now - e.score), key: `demo:swl:${c}`, ttl: zttl, raw: entries },
        tb: { tokens, key: `demo:tb:${c}`, ttl: httl, raw: h || {} },
        stats: stats[c],
      };
    });
    return { now, clients, events: events.slice(-60).reverse() };
  }

  router.get('/state', async (req, res, next) => { try { res.json(await snapshot()); } catch (e) { next(e); } });

  let streams = 0;
  router.get('/stream', (req, res) => {
    if (streams >= 20) return res.status(429).end();
    streams++;
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const tick = async () => {
      try { res.write(`data: ${JSON.stringify(await snapshot())}\n\n`); } catch (e) { /* redis down: skip tick */ }
    };
    tick();
    const timer = setInterval(tick, 300);
    req.on('close', () => { clearInterval(timer); streams--; });
  });

  return router;
};
