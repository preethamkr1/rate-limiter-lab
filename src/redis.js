'use strict';
const Redis = require('ioredis');
const config = require('./config');

const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 1, // fail fast so the middleware can apply FAIL_MODE
  enableOfflineQueue: false,
});
redis.on('error', (e) => console.error('[redis]', e.message));
redis.whenReady = () =>
  redis.status === 'ready'
    ? Promise.resolve()
    : new Promise((resolve) => redis.once('ready', resolve));

module.exports = redis;
