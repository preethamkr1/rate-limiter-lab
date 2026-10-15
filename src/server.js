'use strict';
const config = require('./config');
const redis = require('./redis');
const app = require('./app');

const start = () =>
  app.listen(config.port, () =>
    console.log(`rate-limiter on http://localhost:${config.port} (${config.nodeEnv}, demo=${config.demoMode})`));

// Wait briefly for Redis; if it's down we still start and let FAIL_MODE decide behaviour.
Promise.race([redis.whenReady(), new Promise((r) => setTimeout(r, 3000))]).then(start);
