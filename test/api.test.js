'use strict';
process.env.API_KEYS = 'alice:key-alice,bob:key-bob';
process.env.ADMIN_TOKEN = 'admin-secret';
process.env.CORS_ORIGINS = '';
const { test, after, before } = require('node:test');
const assert = require('node:assert');
const redis = require('../src/redis');
const app = require('../src/app');

let server, base;
before(async () => {
  await redis.whenReady();
  await redis.flushdb();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await redis.quit(); });

const get = (p, h = {}) => fetch(base + p, { headers: h });

test('/health is public', async () => assert.strictEqual((await get('/health')).status, 200));

test('/api requires an API key', async () => {
  assert.strictEqual((await get('/api/sliding')).status, 401);
  assert.strictEqual((await get('/api/sliding', { 'x-api-key': 'wrong' })).status, 401);
});

test('valid key works and sets rate-limit headers', async () => {
  const r = await get('/api/sliding', { 'x-api-key': 'key-alice' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('ratelimit-limit'), '100');
  assert.ok(r.headers.get('ratelimit-remaining'));
});

test('security headers present, x-powered-by absent', async () => {
  const r = await get('/health');
  assert.ok(r.headers.get('x-content-type-options'));
  assert.ok(r.headers.get('strict-transport-security'));
  assert.strictEqual(r.headers.get('x-powered-by'), null);
});

test('CORS: no origin allowed by default', async () => {
  const r = await get('/health', { Origin: 'https://evil.example' });
  assert.strictEqual(r.headers.get('access-control-allow-origin'), null);
});

test('token bucket route returns 429 + Retry-After after burst', async () => {
  const codes = [];
  let last;
  for (let i = 0; i < 25; i++) { last = await get('/api/bucket', { 'x-api-key': 'key-bob' }); codes.push(last.status); }
  const okCount = codes.filter((c) => c === 200).length;
  assert.ok(okCount >= 20 && okCount <= 22, `burst 20 + small refill, got ${okCount}`);
  assert.ok(codes.includes(429));
  assert.ok(Number(last.headers.get('retry-after')) >= 1);
});

test('limits are per client (alice unaffected by bob)', async () => {
  assert.strictEqual((await get('/api/bucket', { 'x-api-key': 'key-alice' })).status, 200);
});

test('admin route is hidden without token, works with it, validates input', async () => {
  const no = await fetch(base + '/admin/reset/bob', { method: 'POST' });
  assert.strictEqual(no.status, 404);
  const bad = await fetch(base + '/admin/reset/bo$b', { method: 'POST', headers: { 'x-admin-token': 'admin-secret' } });
  assert.strictEqual(bad.status, 400);
  const ok = await fetch(base + '/admin/reset/bob', { method: 'POST', headers: { 'x-admin-token': 'admin-secret' } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await get('/api/bucket', { 'x-api-key': 'key-bob' })).status, 200);
});

test('demo: concurrent burst never exceeds limits (SWL 10, TB capacity 10)', async () => {
  await fetch(base + '/demo/reset', { method: 'POST' });
  const r = await fetch(base + '/demo/burst', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clients: ['client-1', 'client-2'], algo: 'both', count: 50 }),
  });
  const j = await r.json();
  for (const c of ['client-1', 'client-2']) {
    assert.strictEqual(j.summary[c].swl.allowed, 10);
    assert.ok(j.summary[c].tb.allowed >= 10 && j.summary[c].tb.allowed <= 11); // +refill during burst
  }
});

test('demo: rejects invalid input', async () => {
  const post = (b) => fetch(base + '/demo/burst', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  assert.strictEqual((await post({ clients: ['../etc'], algo: 'swl', count: 5 })).status, 400);
  assert.strictEqual((await post({ clients: ['client-1'], algo: 'swl', count: 99999 })).status, 400);
  assert.strictEqual((await post({ clients: ['client-1'], algo: 'nope', count: 5 })).status, 400);
});

test('demo: state exposes live redis data', async () => {
  const s = await (await get('/demo/state')).json();
  assert.ok(s.clients['client-1'].swl.count >= 0);
  assert.ok(s.clients['client-1'].tb.tokens <= 10);
});
