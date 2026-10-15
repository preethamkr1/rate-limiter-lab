'use strict';
const { test, after, before } = require('node:test');
const assert = require('node:assert');
const Redis = require('ioredis');
const SlidingWindowLog = require('../src/limiters/slidingWindowLog');
const TokenBucket = require('../src/limiters/tokenBucket');

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => 't' + Math.random().toString(36).slice(2);

before(async () => { await redis.status === 'ready' || await new Promise((r) => redis.once('ready', r)); await redis.flushdb(); });
after(() => redis.quit());

test('sliding window: allows up to limit then blocks', async () => {
  const l = new SlidingWindowLog(redis, { limit: 3, windowMs: 1000 });
  const id = uid();
  const res = [];
  for (let i = 0; i < 5; i++) res.push(await l.consume(id));
  assert.deepStrictEqual(res.map((r) => r.allowed), [true, true, true, false, false]);
  assert.strictEqual(res[0].remaining, 2);
  assert.ok(res[3].retryAfterMs > 0 && res[3].retryAfterMs <= 1000);
});

test('sliding window: old entries expire and requests are allowed again', async () => {
  const l = new SlidingWindowLog(redis, { limit: 2, windowMs: 300 });
  const id = uid();
  await l.consume(id); await l.consume(id);
  assert.strictEqual((await l.consume(id)).allowed, false);
  await sleep(350);
  assert.strictEqual((await l.consume(id)).allowed, true);
});

test('sliding window: no boundary burst (true sliding, not fixed window)', async () => {
  const l = new SlidingWindowLog(redis, { limit: 2, windowMs: 400 });
  const id = uid();
  await sleep(0);
  await l.consume(id);
  await sleep(250);
  await l.consume(id);
  await sleep(200); // first expired (450ms), second still inside
  assert.strictEqual((await l.consume(id)).allowed, true);
  assert.strictEqual((await l.consume(id)).allowed, false);
});

test('sliding window: concurrent requests never exceed limit (atomicity)', async () => {
  const l = new SlidingWindowLog(redis, { limit: 10, windowMs: 5000 });
  const id = uid();
  const out = await Promise.all(Array.from({ length: 50 }, () => l.consume(id)));
  assert.strictEqual(out.filter((r) => r.allowed).length, 10);
});

test('token bucket: allows burst of capacity then blocks', async () => {
  const b = new TokenBucket(redis, { capacity: 5, refillPerSec: 1 });
  const id = uid();
  const out = [];
  for (let i = 0; i < 7; i++) out.push((await b.consume(id)).allowed);
  assert.deepStrictEqual(out, [true, true, true, true, true, false, false]);
});

test('token bucket: refills over time', async () => {
  const b = new TokenBucket(redis, { capacity: 2, refillPerSec: 10 }); // 1 token / 100ms
  const id = uid();
  await b.consume(id); await b.consume(id);
  const blocked = await b.consume(id);
  assert.strictEqual(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs <= 100);
  await sleep(150);
  assert.strictEqual((await b.consume(id)).allowed, true);
});

test('token bucket: never refills beyond capacity', async () => {
  const b = new TokenBucket(redis, { capacity: 2, refillPerSec: 100 });
  const id = uid();
  await b.consume(id);
  await sleep(200);
  const r = [];
  for (let i = 0; i < 3; i++) r.push((await b.consume(id)).allowed);
  assert.deepStrictEqual(r, [true, true, false]);
});

test('token bucket: concurrent requests never exceed capacity (atomicity)', async () => {
  const b = new TokenBucket(redis, { capacity: 10, refillPerSec: 0.001 });
  const id = uid();
  const out = await Promise.all(Array.from({ length: 50 }, () => b.consume(id)));
  assert.strictEqual(out.filter((r) => r.allowed).length, 10);
});
