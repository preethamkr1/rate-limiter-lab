# Redis Rate Limiter (Node.js)

Express middleware that protects APIs from excessive requests, using **Redis** for shared, low-latency state and two algorithms:

| | Sliding Window Log | Token Bucket |
|---|---|---|
| Redis structure | ZSET of timestamps | HASH `{tokens, ts}` |
| Accuracy | Exact (no boundary burst) | Approximate rate, allows bursts |
| Memory per client | O(limit) | O(1) |
| Best for | Strict quotas (login, paid tiers) | Public APIs tolerating short bursts |

Both run as **atomic Lua scripts** (no races across concurrent requests or multiple app servers) and use Redis `TIME` as the single clock.

## Run locally
```bash
docker run -d -p 6379:6379 redis:7     # or install redis and run redis-server
npm install
cp .env.example .env                   # edit keys
export $(grep -v '^#' .env | xargs)
npm start                              # http://localhost:3000 -> live dashboard
npm test                               # needs Redis on :6379 (runs FLUSHDB!)
```
The dashboard (`/`) is on when `DEMO_MODE=1` (default outside production): 8 virtual clients, concurrent bursts, auto traffic, live Redis inspector.

## API
- `GET /api/sliding` (100 req/min per client), `GET /api/bucket` (burst 20, 5/s): header `x-api-key`
- `POST /admin/reset/:client`: header `x-admin-token`
- Responses carry `RateLimit-Limit` / `RateLimit-Remaining`; blocked requests get `429` + `Retry-After`.

## Config
See `.env.example`. `FAIL_MODE=open|closed` decides behaviour if Redis is down. Behind a proxy set `TRUST_PROXY=1`.

> `npm test` runs `FLUSHDB` on the connected Redis. Use a throwaway instance.
