'use strict';

// Atomic in Redis: one HASH per client {tokens, ts}. Tokens refill lazily on each
// request (no background job): tokens = min(capacity, tokens + elapsed * rate).
const LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2]) -- tokens per ms
local cost = tonumber(ARGV[3])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now end
local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + elapsed * rate)
local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil((cost - tokens) / rate)
end
redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', now)
redis.call('PEXPIRE', key, math.ceil(capacity / rate) + 1000)
return {allowed, math.floor(tokens), retry}
`;

class TokenBucket {
  constructor(redis, { capacity, refillPerSec, prefix = 'rl:tb:' }) {
    this.redis = redis;
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.prefix = prefix;
    this.limit = capacity;
    this.name = 'token-bucket';
  }
  async consume(id, cost = 1) {
    const [ok, remaining, retryMs] = await this.redis.eval(
      LUA, 1, this.prefix + id, this.capacity, this.refillPerSec / 1000, cost
    );
    return { allowed: ok === 1, limit: this.capacity, remaining, retryAfterMs: retryMs };
  }
  async reset(id) { return this.redis.del(this.prefix + id); }
}
module.exports = TokenBucket;
