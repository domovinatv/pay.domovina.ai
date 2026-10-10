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
main { padding: 1.5rem; }
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
.pill.env-production { background: #E0F1E5; color: var(--success); }
.pill.env-sandbox { background: #FDF1E0; color: var(--warning); border: 1px dashed var(--warning); }
.pill.env-unknown { background: var(--surface); color: var(--muted); border: 1px solid var(--border); }
.tenant-cell { white-space: nowrap; }
.tenant-strip {
  display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .9rem;
  padding: .45rem 1.5rem; border-bottom: 1px solid var(--border);
  background: var(--surface); font-size: .8rem; color: var(--muted);
}
.tenant-strip .scope { font-weight: 600; color: var(--navy); margin-right: .3rem; }
.tenant-strip .tchip { display: inline-flex; align-items: center; gap: .3rem; }
.tenant-strip .tchip .mono { color: var(--navy); }
.tenant-cell .tname { display: block; font-size: .76rem; color: var(--muted); }
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
.nowrap { white-space: nowrap; }
/* Napomena: duga greška (npr. viem revert) ne smije rastegnuti tablicu —
   tri retka, puni tekst u title i na klik. */
td.note { min-width: 16rem; max-width: 34rem; }
td.note .err {
  overflow-wrap: anywhere; white-space: pre-wrap;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
td.note .err.open { display: block; -webkit-line-clamp: unset; }
td.note .actions { display: flex; gap: .4rem; flex-wrap: wrap; margin-top: .35rem; }
td.note .actions button, .reroute-row button { white-space: nowrap; }
.reroute-row > td { background: var(--surface); }
.reroute-row table { width: auto; }
.reroute-row td { white-space: nowrap; padding: .35rem .8rem; }
.back-link { display: inline-block; margin-bottom: .75rem; font-size: .9rem; }
footer {
  margin: 2rem 0 0; padding: 1rem 1.5rem; border-top: 1px solid var(--border);
  color: var(--muted); font-size: .82rem; text-align: center;
}
tr[data-href] { cursor: pointer; }
nav.tabs form.logout { margin-left: auto; display: flex; align-items: center; gap: .5rem; font-size: .8rem; }
nav.tabs form.logout button { font: inherit; padding: .3rem .7rem; border: 1px solid var(--border); background: #fff; color: var(--navy); border-radius: 6px; cursor: pointer; }
main.login { max-width: 26rem; margin: 3rem auto; }
main.login button, a.button {
  display: inline-block; width: 100%; text-align: center; padding: .75rem 1rem; border-radius: 8px;
  border: none; background: var(--navy); color: #fff; font-weight: 700; font-size: 1rem; cursor: pointer; text-decoration: none;
}
a.button.secondary { background: #fff; color: var(--navy); border: 1px solid var(--navy); }
.msg { padding: .6rem .8rem; border-radius: 8px; background: var(--surface); margin: .8rem 0; }
.msg.bad { background: #FEECEB; color: var(--danger); }
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
  tab: 'events' | 'orders' | 'forwards' | 'intents' | 'wallets' | 'sybil' | 'whitelist' | 'tenants' | 'passkeys';
  body: string;
  /// E-mail prijavljenog admina; prikazuje se uz odjavu.
  email?: string;
  /// Kratka napomena u traci tenanta: je li ovaj tab po tenantu ili globalan.
  scope?: string;
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
  // Klikabilni retci (CSP ne dopušta inline onclick): <tr data-href="…">.
  document.addEventListener('click', (e) => {
    const tr = e.target.closest && e.target.closest('tr[data-href]');
    if (tr) window.location.href = tr.dataset.href;
  });
  return { show: show };
})();
</script>`;

function renderShell({ title, tab, body, email, scope }: ShellOptions): string {
  const t = (key: ShellOptions['tab'], label: string, href: string) =>
    `<a href="${href}" class="${tab === key ? 'active' : ''}">${label}</a>`;
  const badgeLabel = tab === 'events' ? 'Webhook audit'
    : tab === 'orders' ? 'Monerium orders'
    : tab === 'forwards' ? 'Safe forwards'
    : tab === 'wallets' ? 'Self-custody wallets'
    : tab === 'sybil' ? 'Sybil dashboard'
    : tab === 'whitelist' ? 'Payout whitelist'
    : tab === 'tenants' ? 'Tenant onboarding'
    : tab === 'passkeys' ? 'Passkeyi'
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
  ${t('wallets', 'Wallets', '/admin/wallets')}
  ${t('sybil', 'Sybil', '/admin/sybil')}
  ${t('whitelist', 'Whitelist', '/admin/whitelist')}
  ${t('tenants', 'Tenanti', '/admin/tenants')}
  ${t('passkeys', 'Passkeyi', '/admin/passkeys')}
  <form method="post" action="/admin/logout" class="logout">
    ${email ? `<span class="dim">${escapeHtml(email)}</span>` : ''}
    <button type="submit">Odjava</button>
  </form>
</nav>
<div class="tenant-strip" id="tenantStrip">
  <span class="scope">${escapeHtml(scope ?? 'Po tenantu')}</span>
  <span id="tenantStripList" class="dim">Tenanti…</span>
</div>
<main>${body}</main>
${TENANT_STRIP_SCRIPT}
<footer>
  Dio platforme <a href="https://domovina.ai">DOMOVINA.ai</a> ·
  Webhook URL: <span class="mono">https://monerium.domovina.ai/api/monerium/webhook</span>
</footer>
<div class="tricolor"><span class="red"></span><span style="background:#FFFFFF"></span><span class="navy"></span></div>
</body>
</html>`;
}

/// Traka ispod tabova na svakoj admin stranici: svi tenanti s Monerium
/// okruženjem (prod/sandbox) i chainom, da se uvijek vidi s čime radiš.
const TENANT_STRIP_SCRIPT = `<script>
(function() {
  const el = document.getElementById("tenantStripList");
  if (!el) return;
  const e = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  fetch("/admin/api/tenant-tags", { credentials: "same-origin" })
    .then((r) => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
    .then((d) => {
      el.className = "";
      el.innerHTML = (d.tenants || []).map((t) => {
        const env = t.monerium_env || "unknown";
        return '<span class="tchip" title="' + e(t.tenant_name || "") + '"><span class="mono">' + e(t.tenant_id) + '</span>' +
          (t.tenant_id === d.default_tenant_id ? ' <span class="dim">(zadani)</span>' : '') +
          ' <span class="pill env-' + e(env) + '">' + e(env === "production" ? "prod" : env) + '</span>' +
          (t.chain && t.chain !== "gnosis" ? ' <span class="dim">' + e(t.chain) + '</span>' : '') + '</span>';
      }).join("");
    })
    .catch(() => { el.textContent = "tenanti nedostupni"; });
})();
</script>`;

/// Tenant id → "prod"/"sandbox" label za selektore na Whitelist i Tenanti.
const TENANT_ENV_JS = `
let tenantEnv = {};
async function loadTenantEnv() {
  try {
    const r = await fetch('/admin/api/tenant-tags', { credentials: 'same-origin' });
    const d = await r.json();
    tenantEnv = {};
    for (const t of d.tenants || []) tenantEnv[t.tenant_id] = t;
  } catch {}
}
const envLabel = (id) => { const t = tenantEnv[id]; if (!t) return '?'; return (t.monerium_env === 'production' ? 'prod' : t.monerium_env) + (t.chain && t.chain !== 'gnosis' ? '/' + t.chain : ''); };
const envPillFor = (id) => { const t = tenantEnv[id]; const v = (t && t.monerium_env) || 'unknown';
  return '<span class="pill env-' + v + '" title="Monerium ' + v + '">' + (v === 'production' ? 'prod' : v) + '</span>'; };
`;

const TENANT_JS = `
const envPill = function(e) {
  const v = e || "unknown";
  const label = v === "production" ? "prod" : v;
  return '<span class="pill env-' + esc(v) + '" title="Monerium ' + esc(v) + '">' + esc(label) + '</span>';
};
const tenantCell = function(it) {
  return '<span class="tenant-cell"><span class="mono">' + esc(it.tenant_id || "—") + '</span>' +
    (it.tenant_name ? '<span class="tname">' + esc(it.tenant_name) + '</span>' : '') + '</span>';
};
// Fills the tenant <select> once from the API's tenant list, keeping the choice.
const fillTenants = function(list) {
  const sel = document.getElementById("tenant");
  if (!sel || !list || sel.dataset.filled) return;
  sel.dataset.filled = "1";
  for (const t of list) {
    const o = document.createElement("option");
    o.value = t.tenant_id;
    o.textContent = t.tenant_id + (t.tenant_name ? " — " + t.tenant_name : "") + " · " + (t.monerium_env === "production" ? "prod" : t.monerium_env);
    sel.appendChild(o);
  }
};
const explorer = function(chain) {
  return chain === "chiado" ? "https://gnosis-chiado.blockscout.com" : "https://gnosisscan.io";
};
`;

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
  <label for="tenant">Tenant:</label>
  <select id="tenant"><option value="">Svi</option></select>
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
        <th>Tenant</th>
        <th>Monerium</th>
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
let offset = 0, limit = 25, sig = "", sid = "", tenant = "";
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
${TENANT_JS}

async function load() {
  const tbody = document.getElementById("rows");
  tbody.innerHTML = '<tr><td colspan="10" class="empty">Učitavam…</td></tr>';
  const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (sig) q.set("sig", sig);
  if (sid) q.set("sid", sid);
  if (tenant) q.set("tenant", tenant);
  let data;
  try {
    const r = await fetch("/admin/api/events?" + q.toString(), { credentials: "same-origin" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    data = await r.json();
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">Greška: ' + esc(e.message) + '</td></tr>';
    return;
  }

  fillTenants(data.tenants);
  document.getElementById("stats").innerHTML =
    '<div class="stat"><div class="label">Ukupno</div><div class="value">' + data.total_all + '</div></div>' +
    '<div class="stat ok"><div class="label">Sig OK</div><div class="value">' + data.sig_ok_count + '</div></div>' +
    '<div class="stat bad"><div class="label">Sig FAIL</div><div class="value">' + data.sig_fail_count + '</div></div>' +
    '<div class="stat"><div class="label">Različitih SID</div><div class="value">' + data.distinct_sids + '</div></div>';

  if (data.items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">Nema eventova.</td></tr>';
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
      html += '<tr data-href="/admin/events/' + it.id + '">' +
        '<td class="dim mono">#' + it.id + '</td>' +
        '<td>' + esc(fmt(it.received_at)) + '</td>' +
        '<td>' + tenantCell(it) + '</td>' +
        '<td>' + envPill(it.monerium_env) + '</td>' +
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
document.getElementById("tenant").addEventListener("change", function(e) {
  tenant = e.target.value; offset = 0; load();
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
}, tag?: { tenant_id: string; tenant_name: string | null; monerium_env: string }): string {
  const tenantRow = tenantDetailRows(tag);
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
  ${tenantRow}
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
  <label for="tenant">Tenant:</label>
  <select id="tenant"><option value="">Svi</option></select>
  <button type="button" id="refresh">↻ Osvježi</button>
</div>
<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>Placed</th>
        <th>Tenant</th>
        <th>Monerium</th>
        <th>Smjer</th>
        <th>Stanje</th>
        <th>Iznos</th>
        <th>Counterpart</th>
        <th>Memo / Reference</th>
        <th>ID</th>
      </tr>
    </thead>
    <tbody id="rows"><tr><td colspan="9" class="empty">Učitavam…</td></tr></tbody>
  </table>
</div>
<script>
let kind = "", tenant = "";
const fmt = function(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("hr-HR", { dateStyle: "short", timeStyle: "short" });
};
const esc = function(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function(c) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
  });
};
${TENANT_JS}
async function load() {
  const tbody = document.getElementById("rows");
  tbody.innerHTML = '<tr><td colspan="9" class="empty">Učitavam…</td></tr>';
  let data;
  try {
    const q = tenant ? "?tenant=" + encodeURIComponent(tenant) : "";
    const r = await fetch("/admin/api/orders" + q, { credentials: "same-origin" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    data = await r.json();
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">Greška: ' + esc(e.message) + '</td></tr>';
    return;
  }
  fillTenants(data.tenants);
  const items = kind ? data.orders.filter(o => o.kind === kind) : data.orders;
  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">Nema ordera.</td></tr>';
    return;
  }
  let html = "";
  for (const o of items) {
    const statePill = o.state === "processed" ? "ok" : o.state === "rejected" ? "bad" : "warn";
    const memo = (o.memo || o.reference_number || "").slice(0, 80);
    html += '<tr data-href="/admin/orders/' + encodeURIComponent(o.id) + '">' +
      '<td>' + esc(fmt(o.placed_at)) + '</td>' +
      '<td>' + tenantCell(o) + '</td>' +
      '<td>' + envPill(o.monerium_env) + '</td>' +
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
document.getElementById("tenant").addEventListener("change", function(e) { tenant = e.target.value; load(); });
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
}, tag?: { tenant_id: string; tenant_name: string | null; monerium_env: string }): string {
  const pretty = prettyJson(order.raw_json);
  const statePill = order.state === 'processed' ? 'ok' : order.state === 'rejected' ? 'bad' : 'warn';
  const body = `
<a class="back-link" href="/admin/orders">← Svi orderi</a>
<h1>Order ${escapeHtml(order.id)}</h1>
<dl class="detail-grid">
  ${tenantDetailRows(tag)}
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
    <option value="blocked">blocked (whitelist)</option>
    <option value="resolved_offrail">resolved_offrail (ručno)</option>
  </select>
  <label for="tenant">Tenant:</label>
  <select id="tenant"><option value="">Svi</option></select>
  <button type="button" id="refresh">↻ Osvježi</button>
  <button type="button" id="auto">Auto: OFF</button>
</div>
<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Stvoreno</th>
        <th>Tenant</th>
        <th>Monerium</th>
        <th>Status</th>
        <th>Order</th>
        <th>SID</th>
        <th>Target</th>
        <th>Iznos</th>
        <th>TX</th>
        <th>Napomena</th>
      </tr>
    </thead>
    <tbody id="rows"><tr><td colspan="11" class="empty">Učitavam…</td></tr></tbody>
  </table>
</div>
${FORWARDS_SCRIPT}`;
  return renderShell({ title: 'Forwards', tab: 'forwards', body });
}

const FORWARDS_SCRIPT = `<script>
let status = "", tenant = "", autoTimer = null;
const fmt = (u) => u ? new Date(u*1000).toLocaleString("hr-HR",{dateStyle:"short",timeStyle:"medium"}) : "—";
const esc = (s) => String(s==null?"":s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short = (s,n=10) => s ? s.slice(0,n)+"…" : "—";
const eur = (cents) => cents==null ? "—" : (cents/100).toFixed(2)+" EUR";
${TENANT_JS}

async function load() {
  const tbody = document.getElementById("rows");
  tbody.innerHTML = '<tr><td colspan="11" class="empty">Učitavam…</td></tr>';
  const q = new URLSearchParams();
  if (status) q.set("status", status);
  if (tenant) q.set("tenant", tenant);
  let data;
  try {
    const r = await fetch("/admin/api/forwards?"+q.toString(), {credentials:"same-origin"});
    if (!r.ok) throw new Error("HTTP "+r.status);
    data = await r.json();
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty">Greška: '+esc(e.message)+'</td></tr>';
    return;
  }
  fillTenants(data.tenants);
  if (data.items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty">Nema forwards.</td></tr>';
    return;
  }
  // Orders that already have a live forward can't be rerouted again.
  // …and neither can one that was paid out by hand outside the rail.
  const live = new Set(data.items
    .filter(f => f.status === "pending" || f.status === "submitted" || f.status === "confirmed"
      || f.status === "resolved_offrail")
    .map(f => f.order_id));
  let html = "";
  for (const f of data.items) {
    const parked = (f.status === "failed" || f.status === "blocked") && !live.has(f.order_id);
    const via = f.memo_prefix === "auto" ? ' <span class="pill warn" title="uplata bez reference, povezana po iznosu i vremenu">auto</span>'
      : f.memo_prefix === "manual" ? ' <span class="pill warn" title="ručno preusmjereno iz admina">ručno</span>'
      : f.memo_prefix === "offrail" ? ' <span class="pill" title="novac pomaknut ručno izvan raila (2/3 vlasnici)">izvan raila</span>' : "";
    const pill = (f.status === "confirmed" || f.status === "resolved_offrail") ? "ok"
      : (f.status === "failed" || f.status === "blocked") ? "bad" : "warn";
    const ex = explorer(f.chain);
    const txCell = f.tx_hash
      ? '<a class="mono" href="'+ex+'/tx/'+esc(f.tx_hash)+'" target="_blank" rel="noopener">'+esc(short(f.tx_hash,10))+'</a>'
      : '<span class="dim">—</span>';
    html += '<tr>'
      + '<td class="dim mono">#'+f.id+'</td>'
      + '<td class="nowrap">'+esc(fmt(f.created_at))+'</td>'
      + '<td>'+tenantCell(f)+'</td>'
      + '<td>'+envPill(f.monerium_env)+'</td>'
      + '<td><span class="pill '+pill+'">'+esc(f.status)+'</span></td>'
      + '<td class="mono dim">'+esc(short(f.order_id,10))+'</td>'
      + '<td class="mono">'+esc(f.sid||"—")+via+'</td>'
      + '<td class="mono"><a href="'+ex+'/address/'+esc(f.target_address)+'" target="_blank" rel="noopener">'+esc(short(f.target_address,10))+'</a></td>'
      + '<td class="amount">'+esc(eur(f.amount_cents))+'</td>'
      + '<td>'+txCell+'</td>'
      + '<td class="dim note">'
        + (f.error ? '<div class="err" title="'+esc(f.error)+'">'+esc(f.error)+'</div>' : '')
        + (parked ? '<div class="actions"><button type="button" class="reroute" data-order="'+esc(f.order_id)+'">Preusmjeri…</button>'
          + '<button type="button" class="offrail" data-order="'+esc(f.order_id)+'">Riješeno ručno…</button></div>' : '')
        + '</td>'
      + '</tr>'
      + (parked ? '<tr class="reroute-row" id="rr-'+esc(f.order_id)+'" style="display:none"><td colspan="11"></td></tr>' : '');
  }
  tbody.innerHTML = html;
}

// Parked payment → pick the intent it paid. Candidates come from the order's
// tenant; the server re-runs the normal forward gate on the pick.
document.getElementById("rows").addEventListener("click", async (e) => {
  const err = e.target.closest(".err");
  if (err) { err.classList.toggle("open"); return; }
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.classList.contains("offrail")) {
    // Novac je već pomaknut ručno (2/3 vlasnici): upiši tx, server ga provjeri on-chain.
    const orderId = btn.dataset.order;
    const row = document.getElementById("rr-"+orderId);
    const cell = row.firstElementChild;
    if (row.style.display !== "none" && cell.dataset.mode === "offrail") { row.style.display = "none"; return; }
    row.style.display = "";
    cell.dataset.mode = "offrail";
    cell.innerHTML = '<div class="dim" style="margin-bottom:.4rem">Tx hash ručnog transfera iz Safe-a (provjerava se na chainu; order se nakon toga više ne može preusmjeriti):</div>'
      + '<input type="text" class="mono offrail-tx" placeholder="0x…64 hex" style="width:40rem;max-width:100%" /> '
      + '<button type="button" class="offrail-go" data-order="'+esc(orderId)+'">Označi riješenim</button> '
      + '<span class="offrail-msg dim"></span>';
    return;
  }
  if (btn.classList.contains("offrail-go")) {
    const cell = btn.closest("td");
    const msg = cell.querySelector(".offrail-msg");
    if (!btn.dataset.armed) { btn.dataset.armed = "1"; btn.textContent = "Potvrdi"; return; }
    btn.disabled = true;
    try {
      const r = await fetch("/admin/api/orders/"+encodeURIComponent(btn.dataset.order)+"/resolved-offrail", {
        method: "POST", credentials: "same-origin",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({tx_hash: cell.querySelector(".offrail-tx").value.trim()}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ("HTTP "+r.status));
      msg.textContent = "Označeno ✓ → " + d.to;
      setTimeout(load, 2500);
    } catch (err) {
      msg.textContent = "Greška: " + err.message;
      btn.disabled = false; delete btn.dataset.armed; btn.textContent = "Označi riješenim";
    }
    return;
  }
  if (btn.classList.contains("reroute")) {
    const orderId = btn.dataset.order;
    const row = document.getElementById("rr-"+orderId);
    const cell = row.firstElementChild;
    if (row.style.display !== "none" && cell.dataset.mode === "reroute") { row.style.display = "none"; return; }
    row.style.display = "";
    cell.dataset.mode = "reroute";
    cell.innerHTML = '<span class="dim">Tražim intente…</span>';
    try {
      const r = await fetch("/admin/api/orders/"+encodeURIComponent(orderId)+"/reroute-candidates", {credentials:"same-origin"});
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || ("HTTP "+r.status));
      if (!d.items.length) { cell.innerHTML = '<span class="dim">Nema otvorenih ni nedavno isteklih intenata tog tenanta (48 h).</span>'; return; }
      let h = '<div class="dim" style="margin-bottom:.4rem">Uplata '+esc(eur(d.amount_cents))+' · '+esc(d.placed_at||"")+' — odaberi intent (isti iznos prvi):</div><table><tbody>';
      for (const i of d.items) {
        const same = i.amount_cents === d.amount_cents;
        h += '<tr>'
          + '<td class="mono">'+esc(i.sid)+'</td>'
          + '<td class="amount">'+(same ? '<b>'+esc(eur(i.amount_cents))+'</b>' : '<span class="pill warn">'+esc(eur(i.amount_cents))+'</span>')+'</td>'
          + '<td>'+esc(i.state)+' · '+esc(fmt(i.created_at))+'</td>'
          + '<td class="mono">'+esc(short(i.target_address,10))+'</td>'
          + '<td class="dim">'+esc(i.label||"")+'</td>'
          + '<td><button type="button" class="reroute-go" data-order="'+esc(orderId)+'" data-sid="'+esc(i.sid)+'">Preusmjeri</button></td>'
          + '</tr>';
      }
      cell.innerHTML = h + '</tbody></table>';
    } catch (err) {
      cell.innerHTML = '<span class="dim">Greška: '+esc(err.message)+'</span>';
    }
  } else if (btn.classList.contains("reroute-go")) {
    // Two-step: first click arms, second click sends.
    if (!btn.dataset.armed) { btn.dataset.armed = "1"; btn.textContent = "Potvrdi → "+btn.dataset.sid; return; }
    btn.disabled = true;
    btn.textContent = "Šaljem…";
    try {
      const r = await fetch("/admin/api/orders/"+encodeURIComponent(btn.dataset.order)+"/reroute", {
        method: "POST", credentials: "same-origin",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({sid: btn.dataset.sid}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ("HTTP "+r.status));
      btn.textContent = "Poslano ✓";
      setTimeout(load, 4000);
    } catch (err) {
      btn.textContent = "Greška: "+err.message;
    }
  }
});
document.getElementById("status").addEventListener("change", e => { status = e.target.value; load(); });
document.getElementById("tenant").addEventListener("change", e => { tenant = e.target.value; load(); });
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
  <label for="tenant">Tenant:</label>
  <select id="tenant"><option value="">Svi</option></select>
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
        <th>Tenant</th>
        <th>Monerium</th>
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
    <tbody id="rows"><tr><td colspan="11" class="empty">Učitavam…</td></tr></tbody>
  </table>
</div>
${INTENTS_SCRIPT}`;
  return renderShell({ title: 'Payment intents', tab: 'intents', body });
}

const INTENTS_SCRIPT = `<script>
let state = '', search = '', tenant = '', autoTimer = null;
// Snapshot of last-seen state per sid — used to detect transitions
// (pending → paid, pending → expired) and fire toast notifications.
// Only populated after the first load to avoid spamming on page open.
let lastSeen = null;
const fmtUnix = (u) => u ? new Date(u*1000).toLocaleString('hr-HR', {dateStyle:'short',timeStyle:'medium'}) : '—';
const esc = (s) => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short = (s,n=10) => s ? s.slice(0,n)+'…' : '—';
const eur = (cents) => cents==null ? '—' : (cents/100).toFixed(2)+' EUR';
${TENANT_JS}

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
  if (lastSeen === null) tbody.innerHTML = '<tr><td colspan="11" class="empty">Učitavam…</td></tr>';
  const q = new URLSearchParams();
  if (state) q.set('state', state);
  if (search) {
    if (search.startsWith('0x')) q.set('target_address', search);
    else q.set('sid', search);
  }
  if (tenant) q.set('tenant', tenant);
  let data;
  try {
    const r = await fetch('/admin/api/intents?'+q.toString(), {credentials:'same-origin'});
    if (!r.ok) throw new Error('HTTP '+r.status);
    data = await r.json();
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty">Greška: '+esc(e.message)+'</td></tr>';
    return;
  }
  fillTenants(data.tenants);
  // Toast on transitions BEFORE replacing lastSeen.
  diffAndToast(data.items);
  // Rebuild lastSeen for the next diff.
  const next = new Map();
  for (const it of data.items) next.set(it.sid, { state: it.state });
  lastSeen = next;

  if (data.items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty">Nema intentova.</td></tr>';
    return;
  }
  let html = '';
  for (const it of data.items) {
    const pill = it.state === 'paid' ? 'ok' : it.state === 'expired' ? 'bad' : 'warn';
    const checkoutLink = '<a href="/checkout/'+esc(it.sid)+'" target="_blank" rel="noopener" class="mono">'+esc(it.sid)+'</a>';
    const ex = explorer(it.chain);
    const targetCell = '<a href="'+ex+'/address/'+esc(it.target_address)+'" target="_blank" rel="noopener" class="mono dim">'+esc(short(it.target_address,10))+'</a>';
    const txCell = it.forward_tx_hash
      ? '<a class="mono" href="'+ex+'/tx/'+esc(it.forward_tx_hash)+'" target="_blank" rel="noopener">'+esc(short(it.forward_tx_hash,10))+'</a>'
      : '<span class="dim">—</span>';
    html += '<tr>'
      + '<td>'+esc(fmtUnix(it.created_at))+'</td>'
      + '<td>'+tenantCell(it)+'</td>'
      + '<td>'+envPill(it.monerium_env)+'</td>'
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
document.getElementById('tenant').addEventListener('change', e => { tenant = e.target.value; lastSeen = null; load(); });
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
      errDiv.textContent = err.message === 'target_not_whitelisted'
        ? 'Adresa nije na payout whitelisti tenanta — dodaj je na kartici Whitelist pa pokušaj ponovno.'
        : 'Greška: ' + esc(err.message);
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

export function renderSybilPage(): string {
  const body = `
<h1>Sybil dashboard</h1>
<p class="dim" style="margin-top:-.5rem;margin-bottom:1rem;font-size:.9rem">
  Telefonski hash-evi koje dijeli 2+ različita walleta. Legitiman ali rijedak
  scenario je migracija wallet-a istog vlasnika (raniji wallet → noviji). Klaster s
  3+ walleta u kratkom vremenskom prozoru je tipičan sybil signal — provjeri u
  drill-downu da li djeluje organski.
</p>
<div class="controls">
  <button type="button" id="refresh">↻ Osvježi</button>
</div>
<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>Phone hash</th>
        <th>Walleti</th>
        <th>Prvo bound</th>
        <th>Zadnja verifikacija</th>
      </tr>
    </thead>
    <tbody id="rows"><tr><td colspan="4" class="empty">Učitavam…</td></tr></tbody>
  </table>
</div>
<div id="drill" style="margin-top:1.5rem"></div>

<script>
function esc(s) { return String(s).replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmt(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0,19).replace("T"," ");
}
function shortHash(h) { return h.slice(0, 10) + "…" + h.slice(-6); }

async function loadClusters() {
  const res = await fetch('/admin/api/sybil');
  if (!res.ok) {
    document.getElementById('rows').innerHTML =
      '<tr><td colspan="4" class="empty">Greška: ' + res.status + '</td></tr>';
    return;
  }
  const data = await res.json();
  const tbody = document.getElementById('rows');
  if (!data.clusters || data.clusters.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">Nema sybil klastera (svi telefoni su unikatni po walletu).</td></tr>';
    return;
  }
  let html = '';
  for (const c of data.clusters) {
    const fb = new Date(c.first_bound_at * 1000).toISOString();
    const lv = new Date(c.latest_verified_at * 1000).toISOString();
    html += '<tr style="cursor:pointer" data-drill="' + esc(c.phone_hash) + '">' +
      '<td class="mono">' + esc(shortHash(c.phone_hash)) + '</td>' +
      '<td><span class="pill warn">' + c.wallet_count + '</span></td>' +
      '<td class="mono dim">' + esc(fmt(fb)) + '</td>' +
      '<td class="mono dim">' + esc(fmt(lv)) + '</td>' +
      '</tr>';
  }
  tbody.innerHTML = html;
}

// CSP bez inline handlera: klik na red klastera ide preko delegiranog listenera.
document.addEventListener('click', (e) => {
  const tr = e.target.closest && e.target.closest('tr[data-drill]');
  if (tr) drill(tr.dataset.drill);
});

async function drill(phoneHash) {
  const res = await fetch('/admin/api/sybil/phone/' + encodeURIComponent(phoneHash));
  const data = await res.json();
  const wallets = data.wallets || [];
  let html = '<h2 style="font-size:1.05rem;color:var(--navy);margin:0 0 .6rem">Walleti dijele ' + esc(shortHash(phoneHash)) + '</h2>';
  html += '<table><thead><tr><th>Credential</th><th>Prvi bind</th><th>Zadnja verif.</th><th>Count</th></tr></thead><tbody>';
  for (const w of wallets) {
    const fb = new Date(w.first_bound_at * 1000).toISOString();
    const lv = new Date(w.latest_verified_at * 1000).toISOString();
    html += '<tr>' +
      '<td class="mono dim">' + esc(w.credential_id.slice(0,10) + '…' + w.credential_id.slice(-6)) + '</td>' +
      '<td class="mono dim">' + esc(fmt(fb)) + '</td>' +
      '<td class="mono dim">' + esc(fmt(lv)) + '</td>' +
      '<td>' + w.verification_count + '</td>' +
      '</tr>';
  }
  html += '</tbody></table>';
  document.getElementById('drill').innerHTML = html;
  document.getElementById('drill').scrollIntoView({ behavior: 'smooth' });
}

document.getElementById('refresh').addEventListener('click', loadClusters);
loadClusters();
</script>`;
  return renderShell({ title: 'Sybil dashboard', tab: 'sybil', body, scope: 'Globalno (wallet.domovina.ai, nije po tenantu)' });
}

export function renderWalletsPage(): string {
  const body = `
<h1>Self-custody wallets</h1>
<p class="dim" style="margin-top:-.5rem;margin-bottom:1rem;font-size:.9rem">
  Svaki red = jedan passkey registriran kroz wallet.domovina.ai. Counterfactual
  Safe adresa je deterministička iz pubkey-a. Kolona "Verifikacije telefona"
  pokazuje sve telefone koje je wallet ikad vezao, sa per-phone count-om i
  vremenskim rasponom prve do zadnje verifikacije. Više brojeva po walletu =
  jači "stvarna osoba" signal.
</p>
<div class="stats" id="stats"></div>
<div class="controls">
  <label for="phone">Filter:</label>
  <select id="phone">
    <option value="">Svi</option>
    <option value="1">Samo s telefonom</option>
  </select>
  <label for="size">Po stranici:</label>
  <select id="size">
    <option>50</option><option>100</option><option>200</option><option>500</option>
  </select>
  <button type="button" id="refresh">↻ Osvježi</button>
  <button type="button" id="auto">Auto: OFF</button>
</div>
<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>Kreirano</th>
        <th>Safe adresa</th>
        <th>Signer</th>
        <th>Verifikacije telefona</th>
        <th>RP</th>
        <th>Credential</th>
      </tr>
    </thead>
    <tbody id="rows">
      <tr><td colspan="6" class="empty">Učitavam…</td></tr>
    </tbody>
  </table>
</div>
<div class="pager">
  <button type="button" id="prev" disabled>← Prethodna</button>
  <span id="pageInfo" class="dim">—</span>
  <button type="button" id="next">Sljedeća →</button>
</div>

<script>
let limit = 50, offset = 0, phoneFilter = "";
let autoTimer = null;

const PHONE_STYLE = document.createElement("style");
PHONE_STYLE.textContent = ".phone-list{display:flex;flex-direction:column;gap:.2rem}" +
  ".phone-line{display:flex;align-items:center;gap:.5rem;font-size:.85rem;line-height:1.3}" +
  ".phone-hash{color:var(--navy)}" +
  ".phone-count{display:inline-block;min-width:1.8rem;padding:.05rem .4rem;border-radius:.7rem;background:var(--surface);border:1px solid var(--border);font-size:.75rem;font-weight:700;color:var(--navy);text-align:center}" +
  ".phone-range{font-size:.75rem}";
document.head.appendChild(PHONE_STYLE);

function esc(s) { return String(s).replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmt(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0,19).replace("T"," ");
}
function shortAddr(a) { return a ? a.slice(0,8) + "…" + a.slice(-4) : "—"; }
function shortCred(a) { return a ? a.slice(0,10) + "…" + a.slice(-4) : "—"; }

async function load() {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (phoneFilter) params.set("phone", phoneFilter);
  const res = await fetch("/admin/api/wallets?" + params.toString());
  if (!res.ok) {
    document.getElementById("rows").innerHTML =
      '<tr><td colspan="6" class="empty">Greška: ' + res.status + '</td></tr>';
    return;
  }
  const data = await res.json();
  const statsEl = document.getElementById("stats");
  const pct = data.total > 0 ? Math.round(data.with_phone * 100 / data.total) : 0;
  statsEl.innerHTML =
    '<div class="stat"><div class="value">' + data.total + '</div><div class="label">Ukupno walleta</div></div>' +
    '<div class="stat"><div class="value">' + data.with_phone + '</div><div class="label">S recovery telefonom</div></div>' +
    '<div class="stat"><div class="value">' + pct + '%</div><div class="label">Conversion</div></div>';

  const tbody = document.getElementById("rows");
  if (!data.rows || data.rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">Nema walleta.</td></tr>';
  } else {
    let html = "";
    for (const w of data.rows) {
      let phoneCell;
      const phones = w.phones || [];
      if (phones.length === 0) {
        phoneCell = '<span class="dim">—</span>';
      } else {
        // Compact per-phone list: short hash + count pill + date range.
        let lines = '';
        for (const p of phones) {
          const range = p.first_bound_at === p.latest_verified_at
            ? esc(fmt(p.first_bound_at).slice(0, 10))
            : esc(fmt(p.first_bound_at).slice(0, 10)) + ' → ' + esc(fmt(p.latest_verified_at).slice(0, 10));
          lines +=
            '<div class="phone-line">' +
              '<span class="phone-hash mono">' + esc(p.phone_hash_short) + '</span>' +
              '<span class="phone-count">' + p.verification_count + '×</span>' +
              '<span class="phone-range mono dim">' + range + '</span>' +
            '</div>';
        }
        phoneCell = '<div class="phone-list">' + lines + '</div>';
      }
      html += '<tr>' +
        '<td class="mono dim">' + esc(fmt(w.created_at)) + '</td>' +
        '<td class="mono"><a href="https://gnosisscan.io/address/' + esc(w.safe_address) +
          '" target="_blank" rel="noreferrer">' + esc(shortAddr(w.safe_address)) + '</a></td>' +
        '<td class="mono dim">' + esc(shortAddr(w.signer_address)) + '</td>' +
        '<td>' + phoneCell + '</td>' +
        '<td class="mono dim">' + esc(w.rp_id) + '</td>' +
        '<td class="mono dim" title="' + esc(w.credential_id) + '">' + esc(shortCred(w.credential_id)) + '</td>' +
        '</tr>';
    }
    tbody.innerHTML = html;
  }

  // Pager
  document.getElementById("prev").disabled = offset === 0;
  document.getElementById("next").disabled = (offset + data.rows.length) >= data.total;
  document.getElementById("pageInfo").textContent =
    (offset + 1) + "–" + (offset + data.rows.length) + " od " + data.total;
}

document.getElementById("phone").addEventListener("change", e => { phoneFilter = e.target.value; offset = 0; load(); });
document.getElementById("size").addEventListener("change", e => { limit = Number(e.target.value); offset = 0; load(); });
document.getElementById("refresh").addEventListener("click", load);
document.getElementById("prev").addEventListener("click", () => { offset = Math.max(0, offset - limit); load(); });
document.getElementById("next").addEventListener("click", () => { offset = offset + limit; load(); });
document.getElementById("auto").addEventListener("click", e => {
  if (autoTimer) {
    clearInterval(autoTimer); autoTimer = null; e.target.textContent = "Auto: OFF";
  } else {
    autoTimer = setInterval(load, 5000); e.target.textContent = "Auto: ON";
  }
});

load();
</script>`;
  return renderShell({ title: 'Self-custody wallets', tab: 'wallets', body, scope: 'Globalno (wallet.domovina.ai, nije po tenantu)' });
}

function tenantDetailRows(tag?: { tenant_id: string; tenant_name: string | null; monerium_env: string }): string {
  if (!tag) return '';
  return `<dt>Tenant</dt><dd><span class="mono">${escapeHtml(tag.tenant_id)}</span>${tag.tenant_name ? ` <span class="dim">— ${escapeHtml(tag.tenant_name)}</span>` : ''}</dd>
  <dt>Monerium</dt><dd><span class="pill env-${escapeHtml(tag.monerium_env)}">${escapeHtml(tag.monerium_env)}</span></dd>`;
}

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

/// Payout-whitelist console (ADR 0016). Everything the operator needs to keep
/// the fail-closed forward gate correct: which addresses a tenant may be paid
/// on, which campaigns exist, and an append-only record of who changed what.
export function renderWhitelistPage(): string {
  const body = `
<h1>Payout whitelist</h1>
<p class="dim" style="margin-top:-.5rem;margin-bottom:1rem;font-size:.9rem">
  EURe napušta MPT Safe <strong>samo</strong> ako adresa (a) odgovara
  odredištu unaprijed kreiranog intenta / registrirane kampanje i (b) stoji na
  ovoj listi. Sve ostalo ostaje parkirano u Safe-u sa statusom
  <span class="mono">blocked</span>. Uklanjanje adrese djeluje odmah — i na
  intente koji su već izdani.
</p>
<div class="controls">
  <label for="tenant">Tenant:</label>
  <select id="tenant"></select>
  <span id="tenantEnvPill"></span>
  <button type="button" id="refresh">↻ Osvježi</button>
  <label for="showRevoked" style="margin-left:1rem">
    <input type="checkbox" id="showRevoked" /> prikaži i opozvane
  </label>
</div>

<h2 style="margin-top:1.5rem">Alert kanal</h2>
<div class="controls">
  <button type="button" id="alertTestBtn">🔔 Pošalji test alert</button>
  <span id="alertTestResult" class="mono"></span>
</div>
<p class="dim" style="margin-top:-.4rem;font-size:.85rem">
  Alerti su fail-open — ako kanal pukne, forwardi i dalje rade, ali obavijest
  tiho izostane. Pokreni ovo nakon svake promjene postavki Telegram grupe.
</p>

<h2 style="margin-top:1.5rem">Provjeri adresu</h2>
<div class="controls">
  <input type="text" id="checkAddr" placeholder="0x…" size="46" class="mono" />
  <button type="button" id="checkBtn">Provjeri</button>
  <span id="checkResult" class="mono"></span>
</div>

<h2 style="margin-top:1.5rem">Dopuštene payout adrese</h2>
<div class="controls">
  <input type="text" id="newAddr" placeholder="0x…" size="46" class="mono" />
  <input type="text" id="newLabel" placeholder="oznaka (npr. kampanjski Safe)" size="30" />
  <button type="button" id="addBtn">+ Dodaj</button>
</div>
<div class="table-wrap">
  <table>
    <thead><tr>
      <th>Adresa</th><th>Oznaka</th><th>Izvor</th><th>Dodano</th><th>Tko</th><th></th>
    </tr></thead>
    <tbody id="addrRows"><tr><td colspan="6" class="empty">Učitavam…</td></tr></tbody>
  </table>
</div>

<h2 style="margin-top:1.5rem">Kampanje (<span class="mono">cmp:</span> QR)</h2>
<div class="controls">
  <input type="text" id="newCampId" placeholder="campaign_id" size="24" class="mono" />
  <input type="text" id="newCampSafe" placeholder="0x… Safe kampanje" size="46" class="mono" />
  <input type="text" id="newCampLabel" placeholder="oznaka" size="24" />
  <button type="button" id="addCampBtn">+ Registriraj</button>
</div>
<div class="table-wrap">
  <table>
    <thead><tr>
      <th>Campaign id</th><th>Safe</th><th>Oznaka</th><th>Registrirano</th><th>Status</th><th></th>
    </tr></thead>
    <tbody id="campRows"><tr><td colspan="6" class="empty">Učitavam…</td></tr></tbody>
  </table>
</div>

<h2 style="margin-top:1.5rem">Audit log</h2>
<div class="table-wrap">
  <table>
    <thead><tr>
      <th>Kad</th><th>Akcija</th><th>Adresa</th><th>Tko</th><th>Detalj</th>
    </tr></thead>
    <tbody id="auditRows"><tr><td colspan="5" class="empty">Učitavam…</td></tr></tbody>
  </table>
</div>
${WHITELIST_SCRIPT}`;
  return renderShell({ title: 'Payout whitelist', tab: 'whitelist', body, scope: 'Po tenantu (odabrani gore)' });
}

const WHITELIST_SCRIPT = `<script>
const fmtU = (u) => u ? new Date(u*1000).toLocaleString('hr-HR',{dateStyle:'short',timeStyle:'medium'}) : '—';
const escW = (s) => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tenantSel = document.getElementById('tenant');
${TENANT_ENV_JS}

async function loadTenants() {
  const r = await fetch('/admin/api/tenants');
  const d = await r.json();
  await loadTenantEnv();
  tenantSel.innerHTML = d.tenants.map(t =>
    '<option value="' + escW(t.id) + '">' + escW(t.id) + ' — ' + escW(t.name) + ' · ' + escW(envLabel(t.id)) +
    ' (' + t.address_count + ' adr, ' + t.campaign_count + ' kmp)' +
    (t.status !== 'active' ? ' ⚠ ' + escW(t.status) : '') + '</option>').join('');
  await loadAll();
}

function tenant() { return tenantSel.value; }

async function loadAddresses() {
  const all = document.getElementById('showRevoked').checked ? '?all=1' : '';
  const r = await fetch('/admin/api/tenants/' + encodeURIComponent(tenant()) + '/addresses' + all);
  const d = await r.json();
  const tb = document.getElementById('addrRows');
  if (!d.addresses.length) { tb.innerHTML = '<tr><td colspan="6" class="empty">Nema adresa</td></tr>'; return; }
  tb.innerHTML = d.addresses.map(a =>
    '<tr' + (a.revoked_at ? ' style="opacity:.45"' : '') + '>' +
    '<td class="mono">' + escW(a.address) + '</td>' +
    '<td>' + escW(a.label) + '</td>' +
    '<td>' + escW(a.source) + '</td>' +
    '<td>' + fmtU(a.created_at) + '</td>' +
    '<td>' + escW(a.created_by) + '</td>' +
    '<td>' + (a.revoked_at
      ? 'opozvano ' + fmtU(a.revoked_at)
      : '<button type="button" data-addr="' + escW(a.address) + '" class="revoke">Ukloni</button>') +
    '</td></tr>').join('');
  tb.querySelectorAll('button.revoke').forEach(b => b.onclick = () => revoke(b.dataset.addr));
}

async function loadCampaigns() {
  const r = await fetch('/admin/api/tenants/' + encodeURIComponent(tenant()) + '/campaigns');
  const d = await r.json();
  const tb = document.getElementById('campRows');
  if (!d.campaigns.length) { tb.innerHTML = '<tr><td colspan="6" class="empty">Nema kampanja</td></tr>'; return; }
  tb.innerHTML = d.campaigns.map(k =>
    '<tr' + (k.revoked_at ? ' style="opacity:.45"' : '') + '>' +
    '<td class="mono">' + escW(k.campaign_id) + '</td>' +
    '<td class="mono">' + escW(k.safe_address) + '</td>' +
    '<td>' + escW(k.label) + '</td>' +
    '<td>' + fmtU(k.created_at) + '</td>' +
    '<td>' + (k.revoked_at ? 'opozvana' : 'aktivna') + '</td>' +
    '<td>' + (k.revoked_at ? '' :
      '<button type="button" data-cid="' + escW(k.campaign_id) + '" class="revokeCamp">Ukloni</button>') +
    '</td></tr>').join('');
  tb.querySelectorAll('button.revokeCamp').forEach(b => b.onclick = () => revokeCamp(b.dataset.cid));
}

async function loadAudit() {
  const r = await fetch('/admin/api/tenants/audit?tenant=' + encodeURIComponent(tenant()) + '&limit=100');
  const d = await r.json();
  const tb = document.getElementById('auditRows');
  if (!d.entries.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">Prazno</td></tr>'; return; }
  tb.innerHTML = d.entries.map(e =>
    '<tr><td>' + fmtU(e.at) + '</td>' +
    '<td class="mono">' + escW(e.action) + '</td>' +
    '<td class="mono">' + escW(e.address) + '</td>' +
    '<td>' + escW(e.actor) + '</td>' +
    '<td class="mono" style="font-size:.75rem">' + escW(e.detail) + '</td></tr>').join('');
}

function loadAll() {
  document.getElementById('tenantEnvPill').innerHTML = envPillFor(tenant());
  return Promise.all([loadAddresses(), loadCampaigns(), loadAudit()]);
}

async function revoke(addr) {
  if (!confirm('Ukloniti ' + addr + ' s whiteliste? Buduće uplate na tu adresu bit će blokirane.')) return;
  const r = await fetch('/admin/api/tenants/' + encodeURIComponent(tenant()) + '/addresses/' + addr, { method: 'DELETE' });
  if (!r.ok) { alert('Greška: ' + await r.text()); return; }
  await loadAll();
}

async function revokeCamp(cid) {
  if (!confirm('Ukloniti kampanju ' + cid + '?')) return;
  const r = await fetch('/admin/api/tenants/' + encodeURIComponent(tenant()) + '/campaigns/' + encodeURIComponent(cid), { method: 'DELETE' });
  if (!r.ok) { alert('Greška: ' + await r.text()); return; }
  await loadAll();
}

document.getElementById('addBtn').onclick = async () => {
  const address = document.getElementById('newAddr').value.trim();
  const label = document.getElementById('newLabel').value.trim();
  const r = await fetch('/admin/api/tenants/' + encodeURIComponent(tenant()) + '/addresses', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: address, label: label }),
  });
  if (!r.ok) { alert('Greška: ' + await r.text()); return; }
  document.getElementById('newAddr').value = '';
  document.getElementById('newLabel').value = '';
  await loadAll();
};

document.getElementById('addCampBtn').onclick = async () => {
  const r = await fetch('/admin/api/tenants/' + encodeURIComponent(tenant()) + '/campaigns', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      campaign_id: document.getElementById('newCampId').value.trim(),
      safe_address: document.getElementById('newCampSafe').value.trim(),
      label: document.getElementById('newCampLabel').value.trim(),
    }),
  });
  if (!r.ok) { alert('Greška: ' + await r.text()); return; }
  document.getElementById('newCampId').value = '';
  document.getElementById('newCampSafe').value = '';
  document.getElementById('newCampLabel').value = '';
  await loadAll();
};

document.getElementById('checkBtn').onclick = async () => {
  const a = document.getElementById('checkAddr').value.trim();
  const out = document.getElementById('checkResult');
  const r = await fetch('/admin/api/tenants/' + encodeURIComponent(tenant()) + '/check/' + a);
  if (!r.ok) { out.textContent = '⚠ ' + (await r.json()).error; return; }
  const d = await r.json();
  out.textContent = d.allowed ? '✓ dopuštena (izvor: ' + d.source + ')' : '✗ NIJE na whitelisti';
};

document.getElementById('alertTestBtn').onclick = async () => {
  const out = document.getElementById('alertTestResult');
  out.textContent = 'šaljem…';
  try {
    const r = await fetch('/admin/api/alert-test', { method: 'POST' });
    const d = await r.json();
    out.textContent = d.ok
      ? '✓ poruka je stigla u Telegram'
      : (d.configured ? '✗ ' + (d.error || 'HTTP ' + d.status) : '✗ secreti nisu postavljeni')
        + (d.hint ? ' — ' + d.hint : '');
  } catch (e) {
    out.textContent = '✗ ' + e.message;
  }
};

document.getElementById('refresh').onclick = loadAll;
document.getElementById('showRevoked').onchange = loadAddresses;
tenantSel.onchange = loadAll;
loadTenants();
</script>`;

/// Tenant onboarding (ADR 0017). Talks to /admin/api/tenants/* — secrets are
/// write-only: the API never returns them, the form only shows "postavljeno".
export function renderTenantsPage(): string {
  const body = `
<h1>Tenanti</h1>
<p class="dim" style="margin-top:-.5rem;margin-bottom:1rem;font-size:.9rem">
  Svaki tenant osim ITalka ima <strong>svoj</strong> Monerium račun, IBAN, prihvatni Safe,
  router EOA i webhook (ADR 0017). Redoslijed: kreiraj → rail → router ključ → batch
  <span class="mono">safe-tx/007</span> na Safeu tenanta → webhook → whitelist → verify → aktiviraj.
  Promjena raila traži da tenant nije aktivan.
</p>

<h2>Novi tenant</h2>
<div class="controls">
  <input id="nId" placeholder="id (npr. zupa-sv-marko)" size="22" class="mono" />
  <input id="nName" placeholder="naziv" size="26" />
  <input id="nBen" placeholder="primatelj na nalogu (default = naziv)" size="30" />
  <input id="nIban" placeholder="IBAN" size="26" class="mono" />
  <input id="nBic" placeholder="BIC" size="11" class="mono" />
  <button type="button" id="createBtn">+ Kreiraj</button>
</div>

<h2 style="margin-top:1.5rem">Tenant</h2>
<div class="controls">
  <select id="tSel"></select>
  <span id="tEnvPill"></span>
  <span id="tStatus" class="mono"></span>
  <button type="button" data-act="activate">Aktiviraj</button>
  <button type="button" data-act="suspend">Suspendiraj</button>
  <button type="button" data-act="resume">Nastavi</button>
</div>

<h2 style="margin-top:1.5rem">Rail</h2>
<div class="table-wrap"><table><tbody id="railRows"><tr><td class="empty">—</td></tr></tbody></table></div>
<div class="controls" style="flex-wrap:wrap;gap:.5rem;margin-top:.75rem">
  <select id="rEnv"><option>production</option><option>sandbox</option></select>
  <select id="rChain"><option>gnosis</option><option>chiado</option></select>
  <input id="rClient" placeholder="Monerium client_id" size="38" class="mono" />
  <input id="rSecret" placeholder="client_secret (prazno = zadrži)" size="30" type="password" />
  <input id="rProfile" placeholder="profile_id" size="38" class="mono" />
  <input id="rSafe" placeholder="prihvatni Safe 0x…" size="46" class="mono" />
  <input id="rRoles" placeholder="Roles Modifier 0x…" size="46" class="mono" />
  <input id="rRoleKey" placeholder="role_key 0x…(64)" size="46" class="mono" />
  <input id="rEure" placeholder="EURe (samo chiado)" size="46" class="mono" />
  <input id="rCap" placeholder="kapica u centima (strogo <)" size="24" />
  <input id="rOutUrl" placeholder="outbound webhook https://… (opc.)" size="40" />
  <input id="rOutSecret" placeholder="outbound secret (prazno = zadrži)" size="30" type="password" />
  <button type="button" id="saveRail">Spremi rail</button>
</div>
<div class="controls" style="margin-top:.75rem">
  <button type="button" id="routerBtn">Generiraj router EOA</button>
  <button type="button" id="webhookBtn">Registriraj Monerium webhook</button>
  <button type="button" id="verifyBtn">Verify</button>
  <span id="actResult" class="mono"></span>
</div>

<h2 style="margin-top:1.5rem">Verify izvještaj</h2>
<div class="table-wrap"><table>
  <thead><tr><th>Provjera</th><th>OK</th><th>Detalj</th></tr></thead>
  <tbody id="verifyRows"><tr><td colspan="3" class="empty">Još nije pokrenut.</td></tr></tbody>
</table></div>
${TENANTS_SCRIPT}`;
  return renderShell({ title: 'Tenanti', tab: 'tenants', body, scope: 'Po tenantu (odabrani dolje)' });
}

const TENANTS_SCRIPT = `<script>
${TENANT_ENV_JS}
const $t = (id) => document.getElementById(id);
const escT = (s) => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const say = (msg, ok) => { $t('actResult').textContent = msg; $t('actResult').style.color = ok ? '#1b8f3a' : '#c62828'; };

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let d = {};
  try { d = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, d };
}

async function loadTenants(select) {
  const { d } = await api('GET', '/admin/api/tenants');
  await loadTenantEnv();
  $t('tSel').innerHTML = (d.tenants || []).map(t =>
    '<option value="' + escT(t.id) + '">' + escT(t.id) + ' — ' + escT(t.name) + ' · ' + escT(envLabel(t.id)) + ' [' + escT(t.status) + ']</option>').join('');
  if (select) $t('tSel').value = select;
  await loadRail();
}

function row(k, v) { return '<tr><th style="text-align:left;width:14rem">' + escT(k) + '</th><td class="mono">' + v + '</td></tr>'; }

async function loadRail() {
  const id = $t('tSel').value;
  if (!id) return;
  $t('tEnvPill').innerHTML = envPillFor(id);
  const { d } = await api('GET', '/admin/api/tenants/' + encodeURIComponent(id) + '/rail');
  $t('tStatus').textContent = d.legacy ? 'ITalk — rail iz env (nije ovdje)' : ('status: ' + (d.status || '?'));
  const r = d.rail;
  if (!r) { $t('railRows').innerHTML = '<tr><td class="empty">' + (d.legacy ? 'Zadani tenant koristi env.' : 'Rail još nije upisan.') + '</td></tr>'; $t('verifyRows').innerHTML = '<tr><td colspan="3" class="empty">—</td></tr>'; return; }
  const yes = (b) => b ? '✅ postavljeno' : '❌ nedostaje';
  $t('railRows').innerHTML = [
    row('Monerium', escT(r.monerium_env) + ' · ' + escT(r.chain) + ' · client ' + escT(r.client_id) + ' · secret ' + yes(r.has_client_secret)),
    row('Profil', escT(r.profile_id)),
    row('Prihvatni Safe', escT(r.receiving_safe)),
    row('Roles Modifier / uloga', escT(r.roles_modifier || '—') + ' · ' + escT(r.role_key || '—')),
    row('Router EOA', escT(r.router_address || '—') + ' · ključ ' + yes(r.has_router_key)),
    row('Webhook', yes(r.has_webhook_secret) + ' · pretplata ' + escT(r.webhook_subscription_id || '—')),
    row('Outbound webhook', escT(r.outbound_webhook_url || 'nema (tenant nema merchant evente)')),
    row('Kapica', r.max_forward_cents ? '&lt; ' + (r.max_forward_cents/100).toFixed(2) + ' EUR' : '❌ nije upisana'),
    row('Verificiran', r.verified_at ? new Date(r.verified_at*1000).toLocaleString('hr-HR') : '❌ ne'),
  ].join('');
  $t('rEnv').value = r.monerium_env; $t('rChain').value = r.chain; $t('rClient').value = r.client_id || '';
  $t('rProfile').value = r.profile_id || ''; $t('rSafe').value = r.receiving_safe || ''; $t('rRoles').value = r.roles_modifier || '';
  $t('rRoleKey').value = r.role_key || ''; $t('rEure').value = r.eure_contract || ''; $t('rCap').value = r.max_forward_cents || '';
  $t('rOutUrl').value = r.outbound_webhook_url || '';
  renderVerify(r.verify_report && r.verify_report.checks);
}

function renderVerify(checks) {
  if (!checks || !checks.length) { $t('verifyRows').innerHTML = '<tr><td colspan="3" class="empty">Još nije pokrenut.</td></tr>'; return; }
  $t('verifyRows').innerHTML = checks.map(c => '<tr><td class="mono">' + escT(c.key) + '</td><td>' + (c.ok ? '✅' : '❌') + '</td><td class="mono">' + escT(c.detail) + '</td></tr>').join('');
}

$t('tSel').addEventListener('change', loadRail);

$t('createBtn').addEventListener('click', async () => {
  const body = { id: $t('nId').value, name: $t('nName').value, beneficiary_name: $t('nBen').value, iban: $t('nIban').value, bic: $t('nBic').value };
  const { ok, d } = await api('POST', '/admin/api/tenants', body);
  say(ok ? 'Kreiran ' + d.tenant_id + ' (onboarding)' : 'Greška: ' + d.error, ok);
  if (ok) await loadTenants(d.tenant_id);
});

$t('saveRail').addEventListener('click', async () => {
  const id = $t('tSel').value;
  const body = {
    monerium_env: $t('rEnv').value, chain: $t('rChain').value, client_id: $t('rClient').value,
    client_secret: $t('rSecret').value, profile_id: $t('rProfile').value, receiving_safe: $t('rSafe').value,
    roles_modifier: $t('rRoles').value, role_key: $t('rRoleKey').value, eure_contract: $t('rEure').value,
    max_forward_cents: $t('rCap').value, outbound_webhook_url: $t('rOutUrl').value, outbound_webhook_secret: $t('rOutSecret').value,
  };
  const { ok, d } = await api('PUT', '/admin/api/tenants/' + encodeURIComponent(id) + '/rail', body);
  $t('rSecret').value = ''; $t('rOutSecret').value = '';
  say(ok ? 'Rail spremljen — verify treba ponoviti.' : 'Greška: ' + d.error, ok);
  await loadRail();
});

$t('routerBtn').addEventListener('click', async () => {
  const id = $t('tSel').value;
  let res = await api('POST', '/admin/api/tenants/' + encodeURIComponent(id) + '/rail/router-key');
  if (res.status === 409 && res.d.error === 'router_exists' && confirm('Router već postoji (' + res.d.router_address + '). Rotacija traži NOVI batch 007 na Safeu tenanta. Rotirati?')) {
    res = await api('POST', '/admin/api/tenants/' + encodeURIComponent(id) + '/rail/router-key?rotate=1');
  }
  say(res.ok ? 'Router: ' + res.d.router_address + ' — upiši ga u batch 007' : 'Greška: ' + res.d.error, res.ok);
  await loadRail();
});

$t('webhookBtn').addEventListener('click', async () => {
  const id = $t('tSel').value;
  const { ok, d } = await api('POST', '/admin/api/tenants/' + encodeURIComponent(id) + '/rail/webhook');
  say(ok ? 'Webhook: ' + d.url + ' (' + d.subscription_id + ')' : 'Greška: ' + d.error + ' ' + (d.detail || ''), ok);
  await loadRail();
});

$t('verifyBtn').addEventListener('click', async () => {
  const id = $t('tSel').value;
  say('Provjeravam…', true);
  const { d } = await api('POST', '/admin/api/tenants/' + encodeURIComponent(id) + '/rail/verify');
  renderVerify(d.checks);
  say(d.ok ? 'Sve provjere prošle — tenant se može aktivirati.' : (d.error ? 'Greška: ' + d.error : 'Neke provjere nisu prošle.'), Boolean(d.ok));
  await loadRail();
});

document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
  const id = $t('tSel').value;
  const act = b.getAttribute('data-act');
  if (!confirm(act + ' ' + id + '?')) return;
  const { ok, d } = await api('POST', '/admin/api/tenants/' + encodeURIComponent(id) + '/' + act);
  say(ok ? id + ' → ' + d.status : 'Greška: ' + d.error, ok);
  await loadTenants(id);
}));

loadTenants();
</script>`;

// ---- Prijava i passkeyi (preneseno iz bank-push-gateway views.tsx) ----------

export function renderLoginPage(opts: { next: string; error?: string; accessConfigured: boolean }): string {
  const next = escapeHtml(opts.next);
  return `<!doctype html>
<html lang="hr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Prijava — MPT Admin</title>
<meta name="robots" content="noindex,nofollow" />
<meta name="theme-color" content="#002F6C" />
${BASE_STYLE}
</head>
<body>
<div class="tricolor"><span class="red"></span><span style="background:#FFFFFF"></span><span class="navy"></span></div>
<header>
  <div class="brand">
    ${HEADER_LOGO_SVG}
    <div class="word">MPT · <span class="accent">Mint Pay Transfer</span></div>
  </div>
</header>
<main class="login">
  <h1>Prijava</h1>
  ${opts.error ? `<div class="msg bad">${escapeHtml(opts.error)}</div>` : ''}
  <div id="msg" class="msg" hidden></div>
  <p><button id="passkey-login" type="button" data-next="${next}">Prijava passkeyem</button></p>
  ${opts.accessConfigured
    ? `<p><a class="button secondary" href="/admin/sso?next=${encodeURIComponent(opts.next)}">Prijava preko Cloudflare Accessa (OTP na e-mail)</a></p>`
    : '<p class="dim">Cloudflare Access nije konfiguriran.</p>'}
  <p class="dim">Prvi passkey se upisuje nakon prijave preko Accessa (Passkeyi → Dodaj passkey).</p>
</main>
<script src="/admin/static/passkey.js"></script>
</body>
</html>`;
}

export function renderPasskeysPage(opts: {
  email: string;
  passkeys: Array<{ id: string; label: string; created_at: string; last_used_at: string | null }>;
}): string {
  const rows = opts.passkeys.length === 0
    ? '<tr><td colspan="4" class="empty">Još nema passkeya. Dodaj prvi ispod.</td></tr>'
    : opts.passkeys.map((p) => `<tr>
        <td>${escapeHtml(p.label)}</td>
        <td class="mono">${escapeHtml(p.created_at)}</td>
        <td class="mono">${escapeHtml(p.last_used_at ?? '—')}</td>
        <td><form method="post" action="/admin/passkeys/${encodeURIComponent(p.id)}/delete">
          <button type="submit">Ukloni</button></form></td>
      </tr>`).join('');
  const body = `
<h1>Passkeyi za ${escapeHtml(opts.email)}</h1>
<div id="msg" class="msg" hidden></div>
<div class="table-wrap">
  <table>
    <thead><tr><th>Oznaka</th><th>Upisan</th><th>Zadnja uporaba</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>
<h2>Dodaj passkey</h2>
<form id="passkey-register" class="controls">
  <label>Oznaka uređaja
    <input type="text" name="label" placeholder="npr. MacBook / Apple Passwords" maxlength="80" required />
  </label>
  <button type="submit">Dodaj passkey</button>
</form>
<p class="dim">Passkey vrijedi samo za ovu domenu. Access ostaje drugi put ulaska i služi za oporavak
ako izgubiš sve passkeye.</p>
<script src="/admin/static/passkey.js"></script>`;
  return renderShell({ title: 'Passkeyi', tab: 'passkeys', body, email: opts.email, scope: 'Globalno (admin pristup)' });
}
