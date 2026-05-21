/**
 * Branded HTML for the Monerium admin dashboard at monerium.domovina.ai/admin.
 *
 * Mirrors the DOMOVINA.ai parent brand:
 *   navy   #002F6C  — primary surface text + chrome
 *   red    #FF0000  — Croatian flag accent
 *   white  #FFFFFF  — surface
 *   muted  #5A6570  — body / labels
 *
 * Layout pattern lifted from sms.domovina.ai/webhook/src/views.ts so admins
 * recognize the same shell across DOMOVINA services. Pages render server-side
 * for the list shell; row/detail data is loaded via JSON on the client so a
 * single page lives long enough to poll without full reloads.
 */

const HEADER_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="36" height="36" aria-hidden="true">
<defs>
<linearGradient id="hdrFlag" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="#FF0000"/><stop offset="33.3%" stop-color="#FF0000"/>
<stop offset="33.3%" stop-color="#FFFFFF"/><stop offset="66.6%" stop-color="#FFFFFF"/>
<stop offset="66.6%" stop-color="#002F6C"/><stop offset="100%" stop-color="#002F6C"/>
</linearGradient>
</defs>
<rect width="512" height="512" rx="32" fill="white"/>
<path d="M72 64H248C354.071 64 440 149.929 440 256C440 362.071 354.071 448 248 448H72V64Z" fill="url(#hdrFlag)"/>
<path d="M168 160H248C301.019 160 344 202.981 344 256C344 309.019 301.019 352 248 352H168V160Z" fill="white"/>
<g stroke="#002F6C" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
<line x1="205" y1="205" x2="295" y2="225"/><line x1="295" y1="225" x2="285" y2="285"/>
<line x1="285" y1="285" x2="205" y2="307"/><line x1="205" y1="307" x2="205" y2="205"/>
<line x1="205" y1="205" x2="245" y2="256"/><line x1="295" y1="225" x2="245" y2="256"/>
<line x1="285" y1="285" x2="245" y2="256"/><line x1="205" y1="307" x2="245" y2="256"/>
</g>
<g fill="#002F6C">
<circle cx="205" cy="205" r="10"/><circle cx="295" cy="225" r="10"/>
<circle cx="205" cy="307" r="10"/><circle cx="285" cy="285" r="10"/>
<circle cx="245" cy="256" r="14"/>
</g>
</svg>`;

const BASE_STYLE = `<style>
:root {
  --navy: #002F6C; --red: #FF0000; --muted: #5A6570;
  --border: #E1E5EA; --surface: #F5F7F9; --bg: #FFFFFF;
  --success: #2E8540; --warning: #B45309; --danger: #B42318;
  font-family: system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--navy); }
a { color: var(--navy); }
.tricolor { display: flex; height: 6px; }
.tricolor span { flex: 1; }
.tricolor .red { background: var(--red); }
.tricolor .navy { background: var(--navy); }
header {
  padding: .9rem 1.5rem; border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
}
header .brand { display: flex; align-items: center; gap: .6rem; }
header .brand .word { font-weight: 800; letter-spacing: .04em; font-size: 1.1rem; }
header .brand .accent { color: var(--red); }
header .badge {
  background: var(--surface); border: 1px solid var(--border);
  padding: .25rem .6rem; border-radius: 1rem; font-size: .8rem;
  color: var(--muted); font-weight: 600;
}
nav.tabs {
  display: flex; gap: .25rem; padding: 0 1.5rem; border-bottom: 1px solid var(--border);
  background: var(--bg); overflow-x: auto;
}
nav.tabs a {
  padding: .65rem 1rem; text-decoration: none; color: var(--muted);
  font-weight: 600; font-size: .92rem; border-bottom: 2px solid transparent;
  white-space: nowrap;
}
nav.tabs a.active { color: var(--navy); border-bottom-color: var(--red); }
nav.tabs a:hover:not(.active) { color: var(--navy); }
main { padding: 1.5rem; max-width: 96rem; margin: 0 auto; }
h1 { font-size: 1.45rem; margin: 0 0 1rem; }
.stats { display: flex; gap: .75rem; flex-wrap: wrap; margin-bottom: 1rem; }
.stat {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: .5rem; padding: .55rem .9rem; min-width: 7rem;
}
.stat .label {
  font-size: .72rem; color: var(--muted); text-transform: uppercase;
  letter-spacing: .05em; font-weight: 700;
}
.stat .value { font-size: 1.35rem; font-weight: 700; }
.stat.ok .value { color: var(--success); }
.stat.warn .value { color: var(--warning); }
.stat.bad .value { color: var(--danger); }
.controls {
  display: flex; gap: .75rem; align-items: center; flex-wrap: wrap;
  margin-bottom: 1rem;
}
.controls label { font-size: .85rem; color: var(--muted); font-weight: 600; }
.controls select, .controls input, .controls button {
  border: 1px solid var(--border); border-radius: .4rem;
  padding: .4rem .75rem; font-size: .9rem; font-family: inherit;
  background: var(--bg); color: var(--navy);
}
.controls button { cursor: pointer; font-weight: 600; }
.controls button:hover:not(:disabled) { background: var(--surface); }
.controls button:disabled { opacity: .4; cursor: not-allowed; }
.controls .auto-on { color: var(--success); font-weight: 700; }
.table-wrap {
  overflow-x: auto; border: 1px solid var(--border); border-radius: .5rem;
  background: var(--bg);
}
table { width: 100%; border-collapse: collapse; font-size: .9rem; }
th, td {
  text-align: left; padding: .55rem .8rem;
  border-bottom: 1px solid var(--border); vertical-align: top;
}
th {
  background: var(--surface); font-weight: 700; color: var(--muted);
  font-size: .76rem; text-transform: uppercase; letter-spacing: .04em;
  white-space: nowrap;
}
tbody tr { cursor: pointer; }
tbody tr:hover { background: var(--surface); }
tbody tr:last-child td { border-bottom: 0; }
.mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
.dim { color: var(--muted); }
.amount { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
.pill {
  display: inline-block; padding: .15rem .55rem; border-radius: 1rem;
  font-size: .72rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: .04em; white-space: nowrap;
}
.pill.ok { background: #E0F1E5; color: var(--success); }
.pill.bad { background: #F8E2E0; color: var(--danger); }
.pill.warn { background: #FDF1E0; color: var(--warning); }
.pill.neutral { background: var(--surface); color: var(--muted); border: 1px solid var(--border); }
.pager {
  display: flex; justify-content: space-between; align-items: center;
  margin-top: 1rem; gap: 1rem; flex-wrap: wrap;
}
.pager .info { color: var(--muted); font-size: .88rem; }
.pager .nav { display: flex; gap: .5rem; align-items: center; }
.pager .nav span { font-size: .88rem; color: var(--muted); padding: 0 .5rem; }
.empty { text-align: center; padding: 2rem; color: var(--muted); }
.detail-grid {
  display: grid; grid-template-columns: 12rem 1fr; gap: .35rem 1rem;
  margin-bottom: 1rem;
}
.detail-grid dt { color: var(--muted); font-size: .82rem; font-weight: 600; padding-top: .15rem; }
.detail-grid dd { margin: 0; font-size: .92rem; word-break: break-word; }
.code-block {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: .5rem; padding: .8rem 1rem; font-size: .82rem;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  white-space: pre-wrap; word-break: break-word; max-height: 30rem; overflow: auto;
  color: #1a1a1a;
}
.code-block.header { max-height: 16rem; }
.section-title {
  font-size: .8rem; color: var(--muted); text-transform: uppercase;
  letter-spacing: .05em; font-weight: 700; margin: 1.25rem 0 .45rem;
}
.back-link { display: inline-block; margin-bottom: .75rem; font-size: .9rem; }
footer {
  margin: 2rem 0 0; padding: 1rem 1.5rem; border-top: 1px solid var(--border);
  color: var(--muted); font-size: .82rem; text-align: center;
}
@media (max-width: 720px) {
  header { padding: .7rem 1rem; }
  nav.tabs { padding: 0 1rem; }
  main { padding: 1rem; }
  th, td { padding: .45rem .55rem; font-size: .82rem; }
  .detail-grid { grid-template-columns: 1fr; gap: .15rem; }
  .detail-grid dt { padding-top: .55rem; }
}
</style>`;

interface ShellOptions {
  title: string;
  tab: 'events' | 'orders' | 'forwards' | 'intents';
  body: string;
}

/// Shared CSS + JS injected once per page: snackbar/toast notification
/// system + audio chime. Used by per-tab JS (currently intents) to fire
/// "💰 Plaćeno!" toasts when polling detects a state transition.
const TOAST_STYLES = `<style>
#toastTray {
  position: fixed; bottom: 1.25rem; right: 1.25rem;
  z-index: 300; display: flex; flex-direction: column-reverse;
  gap: .55rem; max-width: 24rem; pointer-events: none;
}
.toast {
  pointer-events: auto;
  background: var(--navy); color: #fff;
  border-radius: .55rem;
  padding: .65rem .85rem;
  box-shadow: 0 8px 24px rgba(0,0,0,.18);
  display: flex; gap: .65rem; align-items: flex-start;
  animation: toast-in .25s cubic-bezier(.34,1.56,.64,1) both;
  font-size: .9rem;
  border-left: 4px solid var(--success);
}
.toast.paid    { border-left-color: var(--success); }
.toast.expired { border-left-color: var(--danger); }
.toast.info    { border-left-color: #4A90E2; }
.toast .icon { font-size: 1.2rem; line-height: 1; }
.toast .body { flex: 1; line-height: 1.35; }
.toast .body .title { font-weight: 700; margin-bottom: .15rem; }
.toast .body .sub   { opacity: .85; font-size: .8rem; font-family: ui-monospace, monospace; }
.toast .body a      { color: #fff; text-decoration: underline; }
.toast.fading-out { animation: toast-out .3s ease-in both; }
@keyframes toast-in  { from { transform: translateX(120%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
@keyframes toast-out { from { transform: translateX(0); opacity: 1; } to { transform: translateX(120%); opacity: 0; } }
</style>`;

const TOAST_JS = `<script>
window.MPTToast = (function() {
  let audioCtx;
  function ensureTray() {
    let tray = document.getElementById('toastTray');
    if (!tray) {
      tray = document.createElement('div');
      tray.id = 'toastTray';
      document.body.appendChild(tray);
    }
    return tray;
  }
  function ensureAudio() {
    try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); }
    catch {}
  }
  function chime(variant) {
    if (!audioCtx) return;
    try {
      const t0 = audioCtx.currentTime;
      const notes = variant === 'paid' ? [[660, 0, .18], [880, .12, .32]]
                  : variant === 'expired' ? [[440, 0, .25]]
                  : [[523, 0, .15]];
      notes.forEach(spec => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = spec[0];
        gain.gain.setValueAtTime(0, t0 + spec[1]);
        gain.gain.linearRampToValueAtTime(.15, t0 + spec[1] + .02);
        gain.gain.exponentialRampToValueAtTime(.001, t0 + spec[1] + spec[2]);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t0 + spec[1]);
        osc.stop(t0 + spec[1] + spec[2] + .05);
      });
    } catch {}
  }
  function show(opts) {
    const tray = ensureTray();
    const variant = opts.variant || 'info';
    const el = document.createElement('div');
    el.className = 'toast ' + variant;
    el.innerHTML = '<span class="icon">' + (opts.icon || '🔔') + '</span>'
      + '<div class="body">'
      + '<div class="title">' + (opts.title || '') + '</div>'
      + (opts.sub ? '<div class="sub">' + opts.sub + '</div>' : '')
      + '</div>';
    if (opts.href) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => { window.location = opts.href; });
    }
    tray.appendChild(el);
    chime(variant);
    if (navigator.vibrate && variant === 'paid') {
      try { navigator.vibrate([60, 40, 120]); } catch {}
    }
    const dismissMs = opts.dismissMs || 7000;
    setTimeout(() => {
      el.classList.add('fading-out');
      setTimeout(() => el.remove(), 300);
    }, dismissMs);
  }
  // Unlock audio on first user interaction (browser autoplay policy).
  document.addEventListener('click', ensureAudio, { once: true });
  return { show: show };
})();
</script>`;

function renderShell({ title, tab, body }: ShellOptions): string {
  const t = (key: ShellOptions['tab'], label: string, href: string) =>
    `<a href="${href}" class="${tab === key ? 'active' : ''}">${label}</a>`;
  const badgeLabel = tab === 'events' ? 'Webhook audit'
    : tab === 'orders' ? 'Monerium orders'
    : tab === 'forwards' ? 'Safe forwards'
    : 'Payment intents';
  return `<!doctype html>
<html lang="hr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)} — MPT Admin</title>
<meta name="robots" content="noindex,nofollow" />
<meta name="theme-color" content="#002F6C" />
${BASE_STYLE}
${TOAST_STYLES}
</head>
<body>
${TOAST_JS}
<div class="tricolor"><span class="red"></span><span style="background:#FFFFFF"></span><span class="navy"></span></div>
<header>
  <div class="brand">
    ${HEADER_LOGO_SVG}
    <div class="word">MPT · <span class="accent">Mint Pay Transfer</span></div>
  </div>
  <span class="badge">${escapeHtml(badgeLabel)}</span>
</header>
<nav class="tabs">
  ${t('events', 'Webhook eventi', '/admin/')}
  ${t('orders', 'Orders', '/admin/orders')}
  ${t('forwards', 'Safe forwards', '/admin/forwards')}
  ${t('intents', 'Payment intents', '/admin/intents')}
</nav>
<main>${body}</main>
<footer>
  Dio platforme <a href="https://domovina.ai">DOMOVINA.ai</a> ·
  Webhook URL: <span class="mono">https://monerium.domovina.ai/api/monerium/webhook</span>
</footer>
<div class="tricolor"><span class="red"></span><span style="background:#FFFFFF"></span><span class="navy"></span></div>
</body>
</html>`;
}

export function renderEventsPage(): string {
  const body = `
<h1>Webhook eventi</h1>
<div class="stats" id="stats"></div>
<div class="controls">
  <label for="sig">Signature:</label>
  <select id="sig">
    <option value="">Sve</option>
    <option value="1">OK</option>
    <option value="0">FAIL</option>
  </select>
  <label for="sid">SID:</label>
  <input id="sid" placeholder="filtriraj po sid…" style="width:14rem" />
  <label for="size">Po stranici:</label>
  <select id="size">
    <option>25</option><option>50</option><option>100</option><option>200</option>
  </select>
  <button type="button" id="refresh">↻ Osvježi</button>
  <button type="button" id="auto">Auto: OFF</button>
</div>
<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Primljeno</th>
        <th>Tip</th>
        <th>Iznos</th>
        <th>Order</th>
        <th>SID</th>
        <th>Sig</th>
        <th>Napomena</th>
      </tr>
    </thead>
    <tbody id="rows"><tr><td colspan="8" class="empty">Učitavam…</td></tr></tbody>
  </table>
</div>
<div class="pager">
  <div class="info" id="pageInfo"></div>
  <div class="nav">
    <button type="button" id="prev">‹</button>
    <span id="pageLabel">str. 1</span>
    <button type="button" id="next">›</button>
  </div>
</div>
${EVENTS_SCRIPT}`;
  return renderShell({ title: 'Webhook eventi', tab: 'events', body });
}

const EVENTS_SCRIPT = `<script>
let offset = 0, limit = 25, sig = "", sid = "";
let autoTimer = null;

const fmt = function(unix) {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString("hr-HR", { dateStyle: "short", timeStyle: "medium" });
};
const esc = function(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function(c) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
  });
};
const money = function(cents, ccy) {
  if (cents == null) return "—";
  const v = (cents / 100).toFixed(2);
  return v + " " + (ccy ? ccy.toUpperCase() : "");
};

async function load() {
  const tbody = document.getElementById("rows");
  tbody.innerHTML = '<tr><td colspan="8" class="empty">Učitavam…</td></tr>';
  const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (sig) q.set("sig", sig);
  if (sid) q.set("sid", sid);
  let data;
  try {
    const r = await fetch("/admin/api/events?" + q.toString(), { credentials: "same-origin" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    data = await r.json();
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">Greška: ' + esc(e.message) + '</td></tr>';
    return;
  }

  document.getElementById("stats").innerHTML =
    '<div class="stat"><div class="label">Ukupno</div><div class="value">' + data.total_all + '</div></div>' +
    '<div class="stat ok"><div class="label">Sig OK</div><div class="value">' + data.sig_ok_count + '</div></div>' +
    '<div class="stat bad"><div class="label">Sig FAIL</div><div class="value">' + data.sig_fail_count + '</div></div>' +
    '<div class="stat"><div class="label">Različitih SID</div><div class="value">' + data.distinct_sids + '</div></div>';

  if (data.items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">Nema eventova.</td></tr>';
  } else {
    let html = "";
    for (const it of data.items) {
      const sigPill = it.signature_ok
        ? '<span class="pill ok">OK</span>'
        : '<span class="pill bad">FAIL</span>';
      const orderCell = it.order_id
        ? '<span class="mono dim">' + esc(it.order_id.slice(0, 8)) + '…</span>'
        : '<span class="dim">—</span>';
      const sidCell = it.sid_extracted
        ? '<span class="mono">' + esc(it.sid_extracted) + '</span>'
        : '<span class="dim">—</span>';
      html += '<tr onclick="window.location=\\'/admin/events/' + it.id + '\\'">' +
        '<td class="dim mono">#' + it.id + '</td>' +
        '<td>' + esc(fmt(it.received_at)) + '</td>' +
        '<td class="mono">' + esc(it.event_type || "—") + '</td>' +
        '<td class="amount">' + esc(money(it.amount_cents, it.currency)) + '</td>' +
        '<td>' + orderCell + '</td>' +
        '<td>' + sidCell + '</td>' +
        '<td>' + sigPill + '</td>' +
        '<td class="dim">' + esc(it.processing_note || "") + '</td>' +
        '</tr>';
    }
    tbody.innerHTML = html;
  }

  const start = data.total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + limit, data.total);
  document.getElementById("pageInfo").textContent = start + "–" + end + " od " + data.total;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(data.total / limit));
  document.getElementById("pageLabel").textContent = "str. " + page + " / " + pages;
  document.getElementById("prev").disabled = offset === 0;
  document.getElementById("next").disabled = end >= data.total;
}

document.getElementById("sig").addEventListener("change", function(e) {
  sig = e.target.value; offset = 0; load();
});
document.getElementById("sid").addEventListener("input", function(e) {
  sid = e.target.value.trim(); offset = 0;
  clearTimeout(window._sidTimer);
  window._sidTimer = setTimeout(load, 250);
});
document.getElementById("size").addEventListener("change", function(e) {
  limit = Number(e.target.value) || 25; offset = 0; load();
});
document.getElementById("refresh").addEventListener("click", load);
document.getElementById("prev").addEventListener("click", function() { offset = Math.max(0, offset - limit); load(); });
document.getElementById("next").addEventListener("click", function() { offset = offset + limit; load(); });
document.getElementById("auto").addEventListener("click", function(e) {
  if (autoTimer) {
    clearInterval(autoTimer); autoTimer = null;
    e.target.textContent = "Auto: OFF"; e.target.classList.remove("auto-on");
  } else {
    autoTimer = setInterval(load, 5000);
    e.target.textContent = "Auto: 5s"; e.target.classList.add("auto-on");
  }
});

load();
</script>`;

export function renderEventDetailPage(ev: {
  id: number;
  received_at: number;
  event_type: string | null;
  order_id: string | null;
  signature_ok: number;
  sid_extracted: string | null;
  amount_cents: number | null;
  currency: string | null;
  processing_note: string | null;
  payload: string;
  headers_json: string | null;
}): string {
  const sigPill = ev.signature_ok
    ? '<span class="pill ok">OK</span>'
    : '<span class="pill bad">FAIL</span>';
  const amount = ev.amount_cents != null
    ? `${(ev.amount_cents / 100).toFixed(2)} ${(ev.currency ?? '').toUpperCase()}`
    : '—';
  const prettyBody = prettyJson(ev.payload);
  const prettyHeaders = prettyJson(ev.headers_json);
  const sidLink = ev.sid_extracted
    ? `<a class="mono" href="/admin/?sid=${encodeURIComponent(ev.sid_extracted)}">${escapeHtml(ev.sid_extracted)}</a>`
    : '<span class="dim">—</span>';
  const orderLink = ev.order_id
    ? `<a class="mono" href="/admin/orders/${encodeURIComponent(ev.order_id)}">${escapeHtml(ev.order_id)}</a>`
    : '<span class="dim">—</span>';
  const receivedAt = new Date(ev.received_at * 1000).toLocaleString('hr-HR', {
    dateStyle: 'short', timeStyle: 'medium',
  });
  const body = `
<a class="back-link" href="/admin/">← Svi eventi</a>
<h1>Event #${ev.id}</h1>
<dl class="detail-grid">
  <dt>Primljeno</dt><dd>${escapeHtml(receivedAt)}</dd>
  <dt>Tip</dt><dd class="mono">${escapeHtml(ev.event_type ?? '—')}</dd>
  <dt>Signature</dt><dd>${sigPill}</dd>
  <dt>Iznos</dt><dd>${escapeHtml(amount)}</dd>
  <dt>Order ID</dt><dd>${orderLink}</dd>
  <dt>SID</dt><dd>${sidLink}</dd>
  <dt>Napomena</dt><dd>${escapeHtml(ev.processing_note ?? '—')}</dd>
</dl>
<div class="section-title">HTTP headers</div>
<pre class="code-block header">${escapeHtml(prettyHeaders)}</pre>
<div class="section-title">Payload</div>
<pre class="code-block">${escapeHtml(prettyBody)}</pre>`;
  return renderShell({ title: `Event #${ev.id}`, tab: 'events', body });
}

export function renderOrdersPage(): string {
  const body = `
<h1>Monerium orders</h1>
<div class="controls">
  <label for="kind">Smjer:</label>
  <select id="kind">
    <option value="">Sve</option>
    <option value="issue">issue (SEPA → EURe)</option>
    <option value="redeem">redeem (EURe → SEPA)</option>
  </select>
  <button type="button" id="refresh">↻ Osvježi</button>
</div>
<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>Placed</th>
        <th>Smjer</th>
        <th>Stanje</th>
        <th>Iznos</th>
        <th>Counterpart</th>
        <th>Memo / Reference</th>
        <th>ID</th>
      </tr>
    </thead>
    <tbody id="rows"><tr><td colspan="7" class="empty">Učitavam…</td></tr></tbody>
  </table>
</div>
<script>
let kind = "";
const fmt = function(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("hr-HR", { dateStyle: "short", timeStyle: "short" });
};
const esc = function(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function(c) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
  });
};
async function load() {
  const tbody = document.getElementById("rows");
  tbody.innerHTML = '<tr><td colspan="7" class="empty">Učitavam…</td></tr>';
  let data;
  try {
    const r = await fetch("/admin/api/orders", { credentials: "same-origin" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    data = await r.json();
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">Greška: ' + esc(e.message) + '</td></tr>';
    return;
  }
  const items = kind ? data.orders.filter(o => o.kind === kind) : data.orders;
  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">Nema ordera.</td></tr>';
    return;
  }
  let html = "";
  for (const o of items) {
    const statePill = o.state === "processed" ? "ok" : o.state === "rejected" ? "bad" : "warn";
    const memo = (o.memo || o.reference_number || "").slice(0, 80);
    html += '<tr onclick="window.location=\\'/admin/orders/' + encodeURIComponent(o.id) + '\\'">' +
      '<td>' + esc(fmt(o.placed_at)) + '</td>' +
      '<td class="mono">' + esc(o.kind) + '</td>' +
      '<td><span class="pill ' + statePill + '">' + esc(o.state) + '</span></td>' +
      '<td class="amount mono">' + esc(o.amount) + ' ' + esc((o.currency || "").toUpperCase()) + '</td>' +
      '<td class="mono dim">' + esc(o.counterpart_iban || o.counterpart_name || "—") + '</td>' +
      '<td class="mono dim">' + esc(memo) + '</td>' +
      '<td class="dim mono">' + esc(o.id.slice(0, 10)) + '…</td>' +
      '</tr>';
  }
  document.getElementById("rows").innerHTML = html;
}
document.getElementById("kind").addEventListener("change", function(e) { kind = e.target.value; load(); });
document.getElementById("refresh").addEventListener("click", load);
load();
</script>`;
  return renderShell({ title: 'Orders', tab: 'orders', body });
}

export function renderOrderDetailPage(order: {
  id: string;
  kind: string;
  state: string;
  amount: string;
  currency: string;
  address: string | null;
  chain: string | null;
  counterpart_iban: string | null;
  counterpart_name: string | null;
  memo: string | null;
  reference_number: string | null;
  placed_at: string | null;
  processed_at: string | null;
  raw_json: string;
}): string {
  const pretty = prettyJson(order.raw_json);
  const statePill = order.state === 'processed' ? 'ok' : order.state === 'rejected' ? 'bad' : 'warn';
  const body = `
<a class="back-link" href="/admin/orders">← Svi orderi</a>
<h1>Order ${escapeHtml(order.id)}</h1>
<dl class="detail-grid">
  <dt>Smjer</dt><dd class="mono">${escapeHtml(order.kind)}</dd>
  <dt>Stanje</dt><dd><span class="pill ${statePill}">${escapeHtml(order.state)}</span></dd>
  <dt>Iznos</dt><dd class="mono">${escapeHtml(order.amount)} ${escapeHtml((order.currency ?? '').toUpperCase())}</dd>
  <dt>Chain wallet</dt><dd class="mono">${escapeHtml(order.address ?? '—')} ${order.chain ? `<span class="dim">(${escapeHtml(order.chain)})</span>` : ''}</dd>
  <dt>Counterpart IBAN</dt><dd class="mono">${escapeHtml(order.counterpart_iban ?? '—')}</dd>
  <dt>Counterpart ime</dt><dd>${escapeHtml(order.counterpart_name ?? '—')}</dd>
  <dt>Memo</dt><dd class="mono">${escapeHtml(order.memo ?? '—')}</dd>
  <dt>Reference number</dt><dd class="mono">${escapeHtml(order.reference_number ?? '—')}</dd>
  <dt>Placed</dt><dd>${escapeHtml(order.placed_at ?? '—')}</dd>
  <dt>Processed</dt><dd>${escapeHtml(order.processed_at ?? '—')}</dd>
</dl>
<div class="section-title">Raw JSON (last seen)</div>
<pre class="code-block">${escapeHtml(pretty)}</pre>`;
  return renderShell({ title: `Order ${order.id.slice(0, 8)}`, tab: 'orders', body });
}

export function renderForwardsPage(): string {
  const body = `
<h1>Safe forwards (off-chain → on-chain routing)</h1>
<p class="dim" style="margin-top:-.5rem;margin-bottom:1rem;font-size:.9rem">
  Svaki red = jedna EURe forward TX kroz Zodiac Roles Modifier iz
  MPT main-rail Safe-a na destinaciju izvučenu iz Monerium memo polja.
</p>
<div class="controls">
  <label for="status">Status:</label>
  <select id="status">
    <option value="">Svi</option>
    <option value="pending">pending</option>
    <option value="submitted">submitted</option>
    <option value="confirmed">confirmed</option>
    <option value="failed">failed</option>
  </select>
  <button type="button" id="refresh">↻ Osvježi</button>
  <button type="button" id="auto">Auto: OFF</button>
</div>
<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Stvoreno</th>
        <th>Status</th>
        <th>Order</th>
        <th>SID</th>
        <th>Target</th>
        <th>Iznos</th>
        <th>TX</th>
        <th>Napomena</th>
      </tr>
    </thead>
    <tbody id="rows"><tr><td colspan="9" class="empty">Učitavam…</td></tr></tbody>
  </table>
</div>
${FORWARDS_SCRIPT}`;
  return renderShell({ title: 'Forwards', tab: 'forwards', body });
}

const FORWARDS_SCRIPT = `<script>
let status = "", autoTimer = null;
const fmt = (u) => u ? new Date(u*1000).toLocaleString("hr-HR",{dateStyle:"short",timeStyle:"medium"}) : "—";
const esc = (s) => String(s==null?"":s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short = (s,n=10) => s ? s.slice(0,n)+"…" : "—";
const eur = (cents) => cents==null ? "—" : (cents/100).toFixed(2)+" EUR";

async function load() {
  const tbody = document.getElementById("rows");
  tbody.innerHTML = '<tr><td colspan="9" class="empty">Učitavam…</td></tr>';
  const q = new URLSearchParams();
  if (status) q.set("status", status);
  let data;
  try {
    const r = await fetch("/admin/api/forwards?"+q.toString(), {credentials:"same-origin"});
    if (!r.ok) throw new Error("HTTP "+r.status);
    data = await r.json();
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">Greška: '+esc(e.message)+'</td></tr>';
    return;
  }
  if (data.items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">Nema forwards.</td></tr>';
    return;
  }
  let html = "";
  for (const f of data.items) {
    const pill = f.status === "confirmed" ? "ok" : f.status === "failed" ? "bad" : "warn";
    const txCell = f.tx_hash
      ? '<a class="mono" href="https://gnosisscan.io/tx/'+esc(f.tx_hash)+'" target="_blank" rel="noopener">'+esc(short(f.tx_hash,10))+'</a>'
      : '<span class="dim">—</span>';
    html += '<tr>'
      + '<td class="dim mono">#'+f.id+'</td>'
      + '<td>'+esc(fmt(f.created_at))+'</td>'
      + '<td><span class="pill '+pill+'">'+esc(f.status)+'</span></td>'
      + '<td class="mono dim">'+esc(short(f.order_id,10))+'</td>'
      + '<td class="mono">'+esc(f.sid||"—")+'</td>'
      + '<td class="mono"><a href="https://gnosisscan.io/address/'+esc(f.target_address)+'" target="_blank" rel="noopener">'+esc(short(f.target_address,10))+'</a></td>'
      + '<td class="amount">'+esc(eur(f.amount_cents))+'</td>'
      + '<td>'+txCell+'</td>'
      + '<td class="dim">'+esc(f.error||"")+'</td>'
      + '</tr>';
  }
  tbody.innerHTML = html;
}
document.getElementById("status").addEventListener("change", e => { status = e.target.value; load(); });
document.getElementById("refresh").addEventListener("click", load);
document.getElementById("auto").addEventListener("click", e => {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; e.target.textContent="Auto: OFF"; e.target.classList.remove("auto-on"); }
  else { autoTimer = setInterval(load, 5000); e.target.textContent="Auto: 5s"; e.target.classList.add("auto-on"); }
});
load();
</script>`;

export function renderIntentsPage(): string {
  const body = `
<h1>Payment intents</h1>
<p class="dim" style="margin-top:-.5rem;margin-bottom:1rem;font-size:.9rem">
  Svaki red = jedan payment intent. Lifecycle: pending → paid (kad Monerium
  webhook stigne + forward TX succeed-a) ili expired (kad TTL prođe).
  Klikni red za detalje.
</p>
<div class="controls">
  <button type="button" id="newIntent" style="background:var(--navy);color:#fff;font-weight:700;border:none;">
    + Novi intent
  </button>
  <label for="state">Stanje:</label>
  <select id="state">
    <option value="">Sva</option>
    <option value="pending">pending</option>
    <option value="paid">paid</option>
    <option value="expired">expired</option>
  </select>
  <label for="search">Pretraga:</label>
  <input id="search" placeholder="sid ili 0x adresa…" style="width:14rem" />
  <button type="button" id="refresh">↻ Osvježi</button>
  <button type="button" id="auto">Auto: OFF</button>
</div>

<!-- New intent modal (hidden by default) -->
<div id="intentModal" class="modal-overlay" style="display:none">
  <div class="modal-card">
    <div class="modal-head">
      <h2>Novi payment intent</h2>
      <button type="button" class="modal-close" id="modalClose" aria-label="Zatvori">×</button>
    </div>
    <div class="modal-body" id="modalBody">
      <form id="intentForm">
        <label class="form-label">Target adresa (gdje EURe ide nakon mint-a)
          <input type="text" id="f_target" required pattern="^0x[0-9a-fA-F]{40}$"
                 placeholder="0x…40 hex znakova"
                 value="0x6693a7D19486Dc45e9F90Fd2D515d972bBA2d65e" />
        </label>
        <label class="form-label">Iznos (EUR)
          <input type="text" id="f_amount" required pattern="^[0-9]+([.,][0-9]{1,2})?$"
                 placeholder="npr. 0.50" value="0.50" />
        </label>
        <label class="form-label">Label (opcionalno)
          <input type="text" id="f_label" placeholder="npr. test plaćanje" />
        </label>
        <label class="form-label">Istječe za (sekundi)
          <input type="number" id="f_ttl" min="60" max="86400" value="900" />
          <span class="form-hint">60 do 86400 (24h). Default 900 = 15 min.</span>
        </label>
        <div class="form-actions">
          <button type="button" class="btn-secondary" id="modalCancel">Otkaži</button>
          <button type="submit" class="btn-primary" id="modalSubmit">Kreiraj intent</button>
        </div>
      </form>
    </div>
  </div>
</div>

<style>
.modal-overlay {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(0,47,108,.45);
  display: flex; align-items: center; justify-content: center; padding: 1rem;
}
.modal-card {
  background: var(--bg); border-radius: .8rem; padding: 0;
  max-width: 32rem; width: 100%;
  box-shadow: 0 20px 60px rgba(0,0,0,.25);
  max-height: 90vh; overflow-y: auto;
}
.modal-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 1rem 1.4rem; border-bottom: 1px solid var(--border);
}
.modal-head h2 { margin: 0; font-size: 1.15rem; color: var(--navy); }
.modal-close {
  background: none; border: none; font-size: 1.6rem; color: var(--muted);
  cursor: pointer; line-height: 1; padding: 0 .25rem;
}
.modal-close:hover { color: var(--navy); }
.modal-body { padding: 1.2rem 1.4rem 1.4rem; }
.form-label {
  display: block; margin-bottom: 1rem; font-size: .85rem;
  color: var(--muted); font-weight: 600;
}
.form-label input {
  display: block; width: 100%; margin-top: .35rem; padding: .55rem .65rem;
  border: 1px solid var(--border); border-radius: .4rem;
  font-size: .95rem; color: var(--navy); font-family: inherit;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
.form-label input:focus { outline: 2px solid var(--navy); outline-offset: -1px; border-color: var(--navy); }
.form-hint { display: block; margin-top: .25rem; font-size: .75rem; color: var(--muted); font-weight: 400; }
.form-actions { display: flex; gap: .5rem; justify-content: flex-end; margin-top: 1.2rem; }
.btn-primary, .btn-secondary {
  padding: .55rem 1rem; border-radius: .4rem;
  font-size: .9rem; font-weight: 600; font-family: inherit; cursor: pointer;
  border: 1px solid var(--navy);
}
.btn-primary { background: var(--navy); color: #fff; }
.btn-primary:hover:not(:disabled) { background: #001D4A; }
.btn-primary:disabled { background: #8A95A5; border-color: #8A95A5; cursor: not-allowed; }
.btn-secondary { background: var(--bg); color: var(--navy); }
.btn-secondary:hover { background: var(--surface); }
.form-error {
  background: #F8E2E0; color: var(--danger); border: 1px solid var(--danger);
  padding: .55rem .8rem; border-radius: .4rem; margin-bottom: 1rem; font-size: .9rem;
}
.created-card {
  text-align: center; padding: .5rem 0;
}
.created-card .checkmark {
  width: 56px; height: 56px; margin: 0 auto .8rem;
  border-radius: 50%; background: var(--success);
  display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: 1.8rem; font-weight: 700;
}
.created-card h3 { margin: 0 0 .35rem; font-size: 1.1rem; color: var(--navy); }
.created-card .sid { font-family: ui-monospace, monospace; color: var(--muted); margin: 0 0 1rem; font-size: .9rem; }
.created-card .link-row { display: flex; gap: .5rem; justify-content: center; flex-wrap: wrap; }
.created-card .link-row a {
  padding: .55rem 1rem; border-radius: .4rem; text-decoration: none;
  font-size: .9rem; font-weight: 600; border: 1px solid var(--navy);
}
.created-card .link-row a.primary { background: var(--navy); color: #fff; }
.created-card .link-row a.secondary { background: var(--bg); color: var(--navy); }
</style>
<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>Stvoreno</th>
        <th>Stanje</th>
        <th>Iznos</th>
        <th>SID</th>
        <th>Target</th>
        <th>Label</th>
        <th>Istječe</th>
        <th>Plaćeno</th>
        <th>Forward TX</th>
      </tr>
    </thead>
    <tbody id="rows"><tr><td colspan="9" class="empty">Učitavam…</td></tr></tbody>
  </table>
</div>
${INTENTS_SCRIPT}`;
  return renderShell({ title: 'Payment intents', tab: 'intents', body });
}

const INTENTS_SCRIPT = `<script>
let state = '', search = '', autoTimer = null;
// Snapshot of last-seen state per sid — used to detect transitions
// (pending → paid, pending → expired) and fire toast notifications.
// Only populated after the first load to avoid spamming on page open.
let lastSeen = null;
const fmtUnix = (u) => u ? new Date(u*1000).toLocaleString('hr-HR', {dateStyle:'short',timeStyle:'medium'}) : '—';
const esc = (s) => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short = (s,n=10) => s ? s.slice(0,n)+'…' : '—';
const eur = (cents) => cents==null ? '—' : (cents/100).toFixed(2)+' EUR';

function diffAndToast(items) {
  if (lastSeen === null) return; // first load: skip toast, just establish baseline
  for (const it of items) {
    const prev = lastSeen.get(it.sid);
    if (!prev) {
      // Brand-new intent appeared. Only toast if it landed already-paid
      // (rare — usually means it was created from another tab/curl AND
      // paid before our next poll). Otherwise stay quiet on creation.
      if (it.state === 'paid') {
        window.MPTToast.show({
          variant: 'paid', icon: '💰',
          title: 'Plaćeno: ' + ((it.amount_cents / 100).toFixed(2)) + ' EUR',
          sub: 'sid ' + short(it.sid, 12) + ' · ' + short(it.target_address, 10),
          href: it.forward_tx_hash ? 'https://gnosisscan.io/tx/' + it.forward_tx_hash : undefined,
        });
      }
    } else if (prev.state === 'pending') {
      if (it.state === 'paid') {
        window.MPTToast.show({
          variant: 'paid', icon: '💰',
          title: 'Plaćeno: ' + ((it.amount_cents / 100).toFixed(2)) + ' EUR',
          sub: 'sid ' + short(it.sid, 12) + (it.label ? ' · ' + esc(it.label) : ''),
          href: it.forward_tx_hash ? 'https://gnosisscan.io/tx/' + it.forward_tx_hash : undefined,
          dismissMs: 12000,
        });
      } else if (it.state === 'expired') {
        window.MPTToast.show({
          variant: 'expired', icon: '⌛',
          title: 'Isteklo: ' + ((it.amount_cents / 100).toFixed(2)) + ' EUR',
          sub: 'sid ' + short(it.sid, 12) + (it.label ? ' · ' + esc(it.label) : ''),
        });
      }
    }
  }
}

async function load() {
  const tbody = document.getElementById('rows');
  if (lastSeen === null) tbody.innerHTML = '<tr><td colspan="9" class="empty">Učitavam…</td></tr>';
  const q = new URLSearchParams();
  if (state) q.set('state', state);
  if (search) {
    if (search.startsWith('0x')) q.set('target_address', search);
    else q.set('sid', search);
  }
  let data;
  try {
    const r = await fetch('/admin/api/intents?'+q.toString(), {credentials:'same-origin'});
    if (!r.ok) throw new Error('HTTP '+r.status);
    data = await r.json();
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">Greška: '+esc(e.message)+'</td></tr>';
    return;
  }
  // Toast on transitions BEFORE replacing lastSeen.
  diffAndToast(data.items);
  // Rebuild lastSeen for the next diff.
  const next = new Map();
  for (const it of data.items) next.set(it.sid, { state: it.state });
  lastSeen = next;

  if (data.items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">Nema intentova.</td></tr>';
    return;
  }
  let html = '';
  for (const it of data.items) {
    const pill = it.state === 'paid' ? 'ok' : it.state === 'expired' ? 'bad' : 'warn';
    const checkoutLink = '<a href="/checkout/'+esc(it.sid)+'" target="_blank" rel="noopener" class="mono">'+esc(it.sid)+'</a>';
    const targetCell = '<a href="https://gnosisscan.io/address/'+esc(it.target_address)+'" target="_blank" rel="noopener" class="mono dim">'+esc(short(it.target_address,10))+'</a>';
    const txCell = it.forward_tx_hash
      ? '<a class="mono" href="https://gnosisscan.io/tx/'+esc(it.forward_tx_hash)+'" target="_blank" rel="noopener">'+esc(short(it.forward_tx_hash,10))+'</a>'
      : '<span class="dim">—</span>';
    html += '<tr>'
      + '<td>'+esc(fmtUnix(it.created_at))+'</td>'
      + '<td><span class="pill '+pill+'">'+esc(it.state)+'</span></td>'
      + '<td class="amount">'+esc(eur(it.amount_cents))+'</td>'
      + '<td>'+checkoutLink+'</td>'
      + '<td>'+targetCell+'</td>'
      + '<td class="dim">'+esc(it.label||'—')+'</td>'
      + '<td class="dim">'+esc(fmtUnix(it.expires_at))+'</td>'
      + '<td class="dim">'+esc(fmtUnix(it.paid_at))+'</td>'
      + '<td>'+txCell+'</td>'
      + '</tr>';
  }
  document.getElementById('rows').innerHTML = html;
}
document.getElementById('state').addEventListener('change', e => { state = e.target.value; load(); });
document.getElementById('search').addEventListener('input', e => {
  search = e.target.value.trim();
  clearTimeout(window._intSearchTimer);
  window._intSearchTimer = setTimeout(load, 250);
});
document.getElementById('refresh').addEventListener('click', load);
const autoBtn = document.getElementById('auto');
function toggleAuto(on) {
  if (on) {
    autoTimer = setInterval(load, 5000);
    autoBtn.textContent = 'Auto: 5s';
    autoBtn.classList.add('auto-on');
  } else {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
    autoBtn.textContent = 'Auto: OFF';
    autoBtn.classList.remove('auto-on');
  }
}
autoBtn.addEventListener('click', () => toggleAuto(!autoTimer));
// Auto-polling ON by default so the dashboard feels alive — operator can
// turn it off explicitly. Toasts fire only on transitions, not on initial
// load, so opening the page is quiet.
toggleAuto(true);

// ── New intent modal ────────────────────────────────────────────────
const modal = document.getElementById('intentModal');
const modalBody = document.getElementById('modalBody');
const FORM_HTML = modalBody.innerHTML; // snapshot original form for reset

function openModal() {
  modalBody.innerHTML = FORM_HTML;
  wireForm();
  modal.style.display = 'flex';
  // Autofocus first field
  setTimeout(() => { const el = document.getElementById('f_target'); if (el) el.focus(); }, 50);
}
function closeModal() {
  modal.style.display = 'none';
}

function wireForm() {
  const form = document.getElementById('intentForm');
  document.getElementById('modalCancel').addEventListener('click', closeModal);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('modalSubmit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Kreiram…';
    // Remove any previous error
    const prevErr = form.querySelector('.form-error');
    if (prevErr) prevErr.remove();

    const target = document.getElementById('f_target').value.trim();
    const amountRaw = document.getElementById('f_amount').value.trim().replace(',', '.');
    const label = document.getElementById('f_label').value.trim();
    const ttl = parseInt(document.getElementById('f_ttl').value, 10) || 900;

    try {
      const r = await fetch('/api/intents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_address: target,
          amount_eur: amountRaw,
          label: label || undefined,
          expires_in_seconds: ttl,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      showCreated(d);
      load(); // refresh table behind modal
    } catch (err) {
      const errDiv = document.createElement('div');
      errDiv.className = 'form-error';
      errDiv.textContent = 'Greška: ' + esc(err.message);
      form.insertBefore(errDiv, form.firstChild);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Kreiraj intent';
    }
  });
}

function showCreated(d) {
  const ttlMin = Math.round((new Date(d.expires_at).getTime() - Date.now()) / 1000 / 60);
  modalBody.innerHTML = ''
    + '<div class="created-card">'
    + '<div class="checkmark">✓</div>'
    + '<h3>Intent kreiran</h3>'
    + '<p class="sid">SID: ' + esc(d.sid) + ' · ' + esc(d.amount_eur) + ' EUR · TTL ' + ttlMin + ' min</p>'
    + '<div class="link-row">'
    + '<a class="primary" href="' + esc(d.checkout_url) + '" target="_blank" rel="noopener">↗ Otvori checkout</a>'
    + '<a class="secondary" href="' + esc(d.status_url) + '" target="_blank" rel="noopener">JSON status</a>'
    + '</div>'
    + '<div style="margin-top:1rem;text-align:left;background:var(--surface);padding:.8rem 1rem;border-radius:.4rem;font-size:.8rem;font-family:ui-monospace,monospace;color:var(--muted);word-break:break-all">'
    + '<div><b style="color:var(--navy)">memo:</b> ' + esc(d.memo) + '</div>'
    + '<div style="margin-top:.4rem"><b style="color:var(--navy)">amount:</b> ' + esc(d.amount_eur) + ' EUR</div>'
    + '<div style="margin-top:.4rem"><b style="color:var(--navy)">target:</b> ' + esc(d.target_address) + '</div>'
    + '</div>'
    + '<div class="form-actions" style="justify-content:center;margin-top:1.2rem">'
    + '<button type="button" class="btn-secondary" id="createdCloseBtn">Zatvori</button>'
    + '<button type="button" class="btn-primary" id="createdNewBtn">Još jedan</button>'
    + '</div>'
    + '</div>';
  document.getElementById('createdCloseBtn').addEventListener('click', closeModal);
  document.getElementById('createdNewBtn').addEventListener('click', openModal);
}

document.getElementById('newIntent').addEventListener('click', openModal);
document.getElementById('modalClose').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.style.display !== 'none') closeModal(); });

load();
</script>`;

function prettyJson(s: string | null): string {
  if (!s) return '—';
  try { return JSON.stringify(JSON.parse(s), null, 2); }
  catch { return s; }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
}
