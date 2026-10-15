# Build log: what, why, verified?

| Piece | File | Why | Verified |
|---|---|---|---|
| Sliding Window Log (Lua) | src/limiters/slidingWindowLog.js | exact limiting, atomic | 4 tests incl. 50-way concurrency |
| Token Bucket (Lua) | src/limiters/tokenBucket.js | burst-friendly, O(1) memory | 4 tests incl. refill, cap, concurrency |
| Middleware | src/middleware/rateLimit.js | 429/Retry-After/headers, fail-open/closed | API tests |
| Auth | src/middleware/auth.js | API key on all /api (timing-safe); admin hidden (404) | API tests |
| App wiring | src/app.js | helmet, CORS allowlist, 10kb body cap, IP guard -> auth -> client limiter | API tests |
| Demo + dashboard | src/demo.js, public/* | virtual concurrent clients, live Redis state via SSE | burst/state tests; curl e2e: 480 requests in 54 ms, each client exactly 10 allowed |
| Dependency audit | `npm audit --omit=dev` | vulnerable packages | 0 vulnerabilities (2026-10-15) |

## Security checklist mapping
Applied: rate limiting, auth on API routes, never trust the frontend, input sanitizing, CORS lockdown, security headers, HTTPS (HSTS; TLS at proxy), debug off in prod, hidden admin, admin audit log, dependency audit.
Not applicable (no DB/uploads/webhooks/forms): RLS, parameterized queries, IDOR on rows, storage buckets, file-upload types, webhook signatures, CAPTCHA.
Not done: a manual/Claude security review of the final code is still yours to run.

## Known limitations
- Dashboard JS was syntax-checked and its backend/SSE verified, but not rendered in a real browser here. Open it once and report any glitch.
- TLS is not terminated by this app (use nginx/Render/Cloudflare).
- IP limiting depends on correct TRUST_PROXY.
- Sliding Window Log stores one entry per request; costly at very high limits.

## Is there a better option?
For production scale, Token Bucket (or GCRA) is usually the better default: O(1) memory, one key. Sliding Window Counter is a near-exact middle ground with O(1) memory. Keep Sliding Window Log for small, strict limits. `rate-limiter-flexible` is a battle-tested library; this project demonstrates the trade-offs.
