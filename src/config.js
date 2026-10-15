'use strict';
const env = process.env;

function parseKeys(raw) {
  const map = new Map();
  for (const pair of (raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf(':');
    if (i < 1) continue;
    map.set(pair.slice(i + 1), pair.slice(0, i));
  }
  return map; // key -> client name
}

const config = {
  nodeEnv: env.NODE_ENV || 'development',
  isProd: env.NODE_ENV === 'production',
  port: Number(env.PORT) || 3000,
  redisUrl: env.REDIS_URL || 'redis://127.0.0.1:6379',
  apiKeys: parseKeys(env.API_KEYS),
  adminToken: env.ADMIN_TOKEN || '',
  corsOrigins: (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  trustProxy: Number(env.TRUST_PROXY) || 0,
  demoMode: env.DEMO_MODE ? env.DEMO_MODE === '1' : env.NODE_ENV !== 'production',
  failMode: env.FAIL_MODE === 'closed' ? 'closed' : 'open',
};

if (config.isProd && (config.apiKeys.size === 0 || !config.adminToken)) {
  throw new Error('API_KEYS and ADMIN_TOKEN must be set in production');
}
module.exports = config;
