'use strict';
const crypto = require('crypto');

// Atomic in Redis: one ZSET per client, score = timestamp (ms), member = unique id.
// Uses Redis TIME so all app servers share a single clock.
const LUA = `
local key = KEYS[1]
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local member = ARGV[3]
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - 1, 0}
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retry = tonumber(oldest[2]) + window - now
if retry < 1 then retry = 1 end
return {0, 0, retry}
`;

class SlidingWindowLog {
  constructor(redis, { limit, windowMs, prefix = 'rl:swl:' }) {
    this.redis = redis;
    this.limit = limit;
    this.windowMs = windowMs;
    this.prefix = prefix;
    this.name = 'sliding-window-log';
  }
  async consume(id) {
    const member = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const [ok, remaining, retryMs] = await this.redis.eval(
      LUA, 1, this.prefix + id, this.windowMs, this.limit, member
    );
    return { allowed: ok === 1, limit: this.limit, remaining, retryAfterMs: retryMs };
  }
  async reset(id) { return this.redis.del(this.prefix + id); }
}
module.exports = SlidingWindowLog;
