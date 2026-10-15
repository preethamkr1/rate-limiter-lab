'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

  let cfg = null, selected = null, auto = false;
  const cards = {};       // client -> element refs
  const timers = {};      // client -> interval id
  const rates = {};       // client -> req/sec

  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    return r.json();
  };
  const setStatus = (msg, cls) => { const s = $('status'); s.textContent = msg; s.className = 'status ' + (cls || ''); };
  const algo = () => $('algo').value;
  const burstSize = () => Math.max(1, Math.min(100, parseInt($('burstSize').value, 10) || 20));

  function flash(client, ok) {
    const c = cards[client]; if (!c) return;
    c.root.classList.remove('flash-ok', 'flash-bad'); void c.root.offsetWidth;
    c.root.classList.add(ok ? 'flash-ok' : 'flash-bad');
  }

  async function sendOne(client) {
    try {
      const res = await post('/demo/request', { client, algo: algo() });
      flash(client, Object.values(res).every((r) => r.allowed));
    } catch (e) { setStatus(e.message, 'bad'); }
  }

  async function burst(clients) {
    const n = burstSize();
    setStatus(`firing ${n} concurrent requests x ${clients.length} client(s)…`);
    try {
      const out = await post('/demo/burst', { clients, algo: algo(), count: n });
      // Correctness check: with a fresh limiter, allowed can never exceed the configured limit.
      let violations = 0;
      for (const c of clients) {
        if (out.summary[c].swl && out.summary[c].swl.allowed > cfg.swl.limit + 0) violations++;
        flash(c, Object.values(out.summary[c]).every((s) => s.blocked === 0));
      }
      setStatus(`${out.total} requests in ${out.ms} ms (all in flight at once)` +
        (violations ? ` — ${violations} client(s) exceeded SWL limit (check: limiter was not empty / window rolled)` : ' — limits held under concurrency'),
        violations ? 'bad' : 'good');
    } catch (e) { setStatus(e.message, 'bad'); }
  }

  function setRate(client, rps) {
    rates[client] = rps;
    clearInterval(timers[client]); delete timers[client];
    if (auto && rps > 0) timers[client] = setInterval(() => sendOne(client), 1000 / rps);
  }

  function buildCard(name) {
    const root = el('div', 'card');
    const h = el('h3'); h.append(el('span', '', name)); const tag = el('span', 'muted', ''); h.append(tag);

    const swlRow = el('div', 'row'); const swlLbl = el('div', 'lbl'); const swlName = el('span', '', 'Sliding Window Log'); const swlCount = el('span', '', '');
    swlLbl.append(swlName, swlCount); const track = el('div', 'track'); swlRow.append(swlLbl, track);

    const tbRow = el('div', 'row'); const tbLbl = el('div', 'lbl'); const tbCount = el('span', '', '');
    tbLbl.append(el('span', '', 'Token Bucket'), tbCount); const gauge = el('div', 'gauge'); const fill = el('div', 'fill'); gauge.append(fill); tbRow.append(tbLbl, gauge);

    const counts = el('div', 'counts'); const swlStats = el('span'); const tbStats = el('span'); counts.append(swlStats, tbStats);

    const actions = el('div', 'actions');
    const b1 = el('button', '', 'Send 1'); const b2 = el('button', '', 'Burst');
    const sel = el('select'); [0, 1, 2, 5, 10].forEach((r) => { const o = el('option', '', r ? `${r} req/s` : 'auto: off'); o.value = r; sel.append(o); });
    actions.append(b1, b2, sel);

    b1.addEventListener('click', (e) => { e.stopPropagation(); sendOne(name); });
    b2.addEventListener('click', (e) => { e.stopPropagation(); burst([name]); });
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('change', () => setRate(name, Number(sel.value)));
    root.addEventListener('click', () => { selected = name; updateSelection(); });

    root.append(h, swlRow, tbRow, counts, actions);
    cards[name] = { root, tag, track, swlCount, tbCount, fill, swlStats, tbStats, sel };
    return root;
  }

  function updateSelection() {
    for (const [n, c] of Object.entries(cards)) c.root.classList.toggle('sel', n === selected);
    $('inspTarget').textContent = selected ? `· ${selected}` : '';
  }

  function render(s) {
    for (const name of cfg.clients) {
      const d = s.clients[name], c = cards[name];
      // Sliding window: dot position = age in window (right edge = now, left edge = about to expire)
      c.track.textContent = '';
      for (const age of d.swl.agesMs) {
        const t = el('div', 'tick'); t.style.left = `calc(${(1 - age / cfg.swl.windowMs) * 100}% - 4px)`; c.track.append(t);
      }
      c.track.classList.toggle('full', d.swl.count >= cfg.swl.limit);
      c.swlCount.textContent = `${d.swl.count}/${cfg.swl.limit} in last ${cfg.swl.windowMs / 1000}s`;
      // Token bucket
      const pct = (d.tb.tokens / cfg.tb.capacity) * 100;
      c.fill.style.width = pct + '%';
      c.fill.className = 'fill' + (d.tb.tokens < 1 ? ' empty' : pct < 30 ? ' low' : '');
      c.tbCount.textContent = `${d.tb.tokens.toFixed(1)}/${cfg.tb.capacity} tokens (+${cfg.tb.refillPerSec}/s)`;
      c.swlStats.innerHTML = ''; c.tbStats.innerHTML = '';
      c.swlStats.append('SWL ', el('span', 'ok', d.stats.swl.allowed), ' / ', el('span', 'bad', d.stats.swl.blocked));
      c.tbStats.append('TB ', el('span', 'ok', d.stats.tb.allowed), ' / ', el('span', 'bad', d.stats.tb.blocked));
    }
    if (selected && s.clients[selected]) {
      const d = s.clients[selected];
      const z = d.swl.raw.map((e) => `  ${e.score}  ${e.member}`).join('\n') || '  (empty)';
      $('inspector').textContent =
        `# Sliding Window Log (ZSET)\nKEY ${d.swl.key}\nPTTL ${d.swl.ttl} ms\nZRANGE 0 -1 WITHSCORES\n${z}\n\n` +
        `# Token Bucket (HASH)\nKEY ${d.tb.key}\nPTTL ${d.tb.ttl} ms\nHGETALL\n  tokens ${d.tb.raw.tokens ?? '(none)'}\n  ts     ${d.tb.raw.ts ?? '(none)'}\n` +
        `\n(live tokens after refill: ${d.tb.tokens.toFixed(3)})`;
    }
    const log = $('log'); log.textContent = '';
    for (const e of s.events) {
      const li = el('li', e.allowed ? 'ok' : 'bad');
      const time = new Date(e.t).toLocaleTimeString([], { hour12: false });
      li.textContent = `${time} ${e.client} ${e.algo.toUpperCase()} ` +
        (e.text ? e.text : e.allowed ? `ALLOW rem=${e.remaining}` : `BLOCK retry=${Math.ceil(e.retryAfterMs / 1000)}s`);
      log.append(li);
    }
  }

  function connect() {
    const es = new EventSource('/demo/stream');
    es.onopen = () => { $('dot').classList.add('on'); $('connText').textContent = 'live (SSE)'; };
    es.onmessage = (m) => render(JSON.parse(m.data));
    es.onerror = () => { $('dot').classList.remove('on'); $('connText').textContent = 'reconnecting…'; };
  }

  const CHECKS = [
    ['Rate limiting', 'two Redis-backed algorithms, atomic Lua scripts, per-IP guard + per-client limits'],
    ['Auth on every API route', '/api/* requires x-api-key (timing-safe compare)'],
    ['Never trust the frontend', 'client identity comes from server key table; this dashboard holds no secrets; inputs validated server-side'],
    ['Sanitize user input', 'client ids whitelisted/regex-checked; JSON body capped at 10kb'],
    ['Lock down CORS', 'deny-all by default; explicit CORS_ORIGINS allowlist'],
    ['HTTPS everywhere', 'HSTS via helmet; terminate TLS at proxy (set TRUST_PROXY)'],
    ['Security headers', 'helmet: CSP, HSTS, nosniff, frame-ancestors; x-powered-by removed'],
    ['Debug mode off in prod', 'no stack traces in responses; demo routes disabled when NODE_ENV=production'],
    ['Hide admin pages properly', 'admin route returns 404 without x-admin-token'],
    ['Log admin actions', 'structured audit log on /admin/reset'],
    ['Update vulnerable packages', 'npm run audit (see BUILD_LOG)'],
    ['Not applicable here', 'RLS, parameterized queries, IDOR on DB rows, storage buckets, file uploads, webhooks, CAPTCHA — no DB / uploads / webhooks / public forms in this service'],
  ];

  async function init() {
    cfg = await (await fetch('/demo/config')).json();
    $('legend').textContent =
      `Sliding Window Log: ${cfg.swl.limit} requests per ${cfg.swl.windowMs / 1000}s (each dot = one stored timestamp; dots drift left and expire). ` +
      `Token Bucket: capacity ${cfg.tb.capacity}, refill ${cfg.tb.refillPerSec}/s (bursts allowed, then throttled to refill rate).`;
    const grid = $('grid');
    cfg.clients.forEach((n) => { rates[n] = 0; grid.append(buildCard(n)); });
    selected = cfg.clients[0]; updateSelection();
    for (const [b, t] of CHECKS) { const li = el('li'); li.append(el('b', '', b + ': '), t); $('checks').append(li); }

    $('fireAll').addEventListener('click', () => burst(cfg.clients));
    $('resetBtn').addEventListener('click', async () => { await post('/demo/reset', {}); setStatus('Redis demo state cleared', 'good'); });
    $('autoBtn').addEventListener('click', () => {
      auto = !auto;
      $('autoBtn').textContent = auto ? '■ Stop auto traffic' : '▶ Start auto traffic';
      $('autoBtn').classList.toggle('on', auto);
      if (auto) {
        // sensible default mix: one aggressive client, a few moderate, rest light
        const mix = [10, 5, 2, 2, 1, 1, 1, 0];
        cfg.clients.forEach((n, i) => { cards[n].sel.value = mix[i]; setRate(n, mix[i]); });
      } else cfg.clients.forEach((n) => setRate(n, rates[n]));
    });
    connect();
  }
  init().catch((e) => setStatus('init failed: ' + e.message, 'bad'));
})();
