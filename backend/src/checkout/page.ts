import qrcode from 'qrcode-generator';

import type { PaymentIntentRow } from '../intents/db';

/// Server-side render of the EPC text as an inline SVG. Keeps the HTML
/// fully self-contained (no client-side library, no CDN dependency, no
/// JS required to display the QR — only to handle status polling).
function renderQrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  // Scalable inline SVG — sized by CSS in the wrap element below.
  return qr.createSvgTag({ scalable: true, margin: 2 });
}

/// Buyer-facing checkout page. Server-renders once with the snapshot, then
/// client polls /api/intents/<sid> every 2s for state changes.
///
/// Branded in DOMOVINA palette (navy #002F6C + red #FF0000 + Croatian
/// tricolor stripes) to match admin + sms.domovina.ai patterns. EPC QR
/// rendered client-side via inline qrjs2 (~3KB) so the page is fully
/// self-contained and embeddable as an iframe.
///
/// UX flow mirrors otp.domovina.ai's SMS verification:
///   pending → countdown + pulse animation
///   paid    → success overlay modal + chime + vibration
///   expired → expired overlay with retry CTA

export function renderCheckoutPage(intent: PaymentIntentRow): string {
  const sid = intent.sid;
  const amount = (intent.amount_cents / 100).toFixed(2);
  const target = intent.target_address;
  const memo = `mpt:${target}?sid=${sid}`;
  // EPC text computed inline since the buyer's QR scan needs the text.
  // Kept short here; intentResponseJson in api.ts shares the same builder.
  const epcLines = [
    'BCD', '002', '1', 'SCT', 'LHVBEE22',
    'ITalk d.o.o.',
    'EE7077770001629211 28'.replace(/\s+/g, ''),
    `EUR${amount}`,
    'OTHR',
    memo,
  ];
  const epcText = epcLines.join('\n');
  // Embed initial snapshot into the page so JS doesn't need to fetch on load.
  const initialState = {
    sid,
    state: intent.state,
    amount_eur: amount,
    target_address: target,
    label: intent.label ?? null,
    memo,
    epc_qr_data: epcText,
    expires_at_unix: intent.expires_at,
    paid_at: intent.paid_at,
    forward_tx_hash: intent.forward_tx_hash,
  };

  return `<!doctype html>
<html lang="hr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Plaćanje · MPT</title>
<meta name="robots" content="noindex,nofollow" />
<meta name="theme-color" content="#002F6C" />
<style>
:root {
  --navy: #002F6C; --red: #FF0000; --muted: #5A6570;
  --border: #E1E5EA; --surface: #F5F7F9; --bg: #FFFFFF;
  --success: #2E8540; --warning: #B45309; --danger: #B42318;
  font-family: system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--navy); min-height: 100vh; }
body { display: flex; flex-direction: column; }
.tricolor { display: flex; height: 6px; }
.tricolor span { flex: 1; }
.tricolor .red { background: var(--red); }
.tricolor .white { background: var(--bg); }
.tricolor .navy { background: var(--navy); }
header { padding: 1rem 1.5rem; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: .65rem; }
header .word { font-weight: 800; letter-spacing: .04em; font-size: 1.05rem; }
header .word .accent { color: var(--red); }
main { flex: 1; padding: 1.5rem 1.25rem; max-width: 38rem; margin: 0 auto; width: 100%; }
h1 { font-size: 1.5rem; margin: 0 0 .4rem; }
.lede { color: var(--muted); margin: 0 0 1.5rem; line-height: 1.5; font-size: .98rem; }
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: .8rem; padding: 1.4rem 1.4rem 1.6rem;
}
.qr-wrap {
  display: flex; flex-direction: column; align-items: center;
  gap: .8rem; margin: 0 0 1rem;
}
#qrBox {
  width: 240px; height: 240px; padding: .9rem;
  background: white; border: 1px solid var(--border); border-radius: .5rem;
  display: flex; align-items: center; justify-content: center;
}
#qrBox svg { width: 100%; height: 100%; display: block; image-rendering: pixelated; shape-rendering: crispEdges; }
.qr-hint { font-size: .85rem; color: var(--muted); text-align: center; line-height: 1.4; max-width: 22rem; }
.amount-block { text-align: center; margin: .25rem 0 1rem; }
.amount {
  font-size: 2.4rem; font-weight: 800; color: var(--navy);
  letter-spacing: .02em; line-height: 1;
}
.amount-label { font-size: .8rem; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; margin-top: .25rem; }
.detail-rows { font-size: .88rem; }
.detail-rows .row {
  display: flex; justify-content: space-between; gap: 1rem;
  padding: .5rem 0; border-bottom: 1px solid var(--border);
}
.detail-rows .row:last-child { border-bottom: 0; }
.detail-rows .label { color: var(--muted); }
.detail-rows .value { color: var(--navy); font-weight: 600; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; word-break: break-all; text-align: right; }
.status-bar {
  margin: .8rem 0 .25rem; padding: .55rem .75rem;
  border-radius: .5rem; display: flex; align-items: center; gap: .55rem;
  font-size: .9rem; font-weight: 600;
}
.status-bar.pending { background: #FDF1E0; color: var(--warning); border: 1px solid #E8B96E; }
.status-bar.paid { background: #E0F1E5; color: var(--success); border: 1px solid var(--success); }
.status-bar.expired { background: #F8E2E0; color: var(--danger); border: 1px solid var(--danger); }
.pulse-dot {
  width: 10px; height: 10px; border-radius: 50%; background: currentColor;
  animation: pulse-anim 1.4s ease-in-out infinite;
}
@keyframes pulse-anim {
  0%, 100% { opacity: .35; transform: scale(.8); }
  50%      { opacity: 1; transform: scale(1.15); }
}
.countdown { font-variant-numeric: tabular-nums; }
.success-overlay {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0,47,108,.55);
  display: flex; align-items: center; justify-content: center; padding: 1rem;
  animation: fade-in .25s ease-out;
}
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
.success-modal {
  background: var(--bg); border-radius: .9rem; padding: 2rem 1.75rem 1.5rem;
  max-width: 24rem; width: 100%; text-align: center;
  box-shadow: 0 20px 60px rgba(0,0,0,.3);
  animation: success-pop .5s cubic-bezier(.34,1.56,.64,1);
}
@keyframes success-pop {
  0% { transform: scale(.6); opacity: 0; }
  100% { transform: scale(1); opacity: 1; }
}
.success-modal .check {
  width: 72px; height: 72px; margin: 0 auto 1rem;
  border-radius: 50%; background: var(--success);
  display: flex; align-items: center; justify-content: center;
  animation: check-pop .5s cubic-bezier(.34,1.56,.64,1) .1s both;
}
@keyframes check-pop {
  0% { transform: scale(0); }
  100% { transform: scale(1); }
}
.success-modal .check svg { width: 42px; height: 42px; }
.success-modal .check svg path {
  stroke-dasharray: 36; stroke-dashoffset: 36;
  animation: check-draw .4s ease-out .35s forwards;
}
@keyframes check-draw { to { stroke-dashoffset: 0; } }
.success-modal h2 { margin: 0 0 .4rem; font-size: 1.5rem; color: var(--navy); }
.success-modal .sub { margin: 0 0 1.2rem; color: var(--muted); font-size: .95rem; line-height: 1.45; }
.success-modal .sub strong { color: var(--navy); }
.success-modal .tx-link {
  display: inline-block; margin-top: .4rem;
  padding: .55rem 1rem; font-size: .85rem; font-weight: 600;
  color: var(--navy); background: var(--surface);
  border: 1px solid var(--border); border-radius: .45rem;
  text-decoration: none;
}
.success-modal .tx-link:hover { background: #EDF0F4; }
footer {
  padding: 1rem 1.25rem; border-top: 1px solid var(--border);
  color: var(--muted); font-size: .8rem; text-align: center;
}
footer a { color: var(--navy); text-decoration: none; font-weight: 600; }
@media (max-width: 480px) {
  header { padding: .75rem 1rem; }
  main { padding: 1rem; }
  h1 { font-size: 1.25rem; }
  .card { padding: 1rem; }
  #qrBox { width: 200px; height: 200px; padding: .7rem; }
  .amount { font-size: 2rem; }
}
</style>
</head>
<body>
<div class="tricolor"><span class="red"></span><span class="white"></span><span class="navy"></span></div>
<header>
  <div class="word">MPT · <span class="accent">Mint Pay Transfer</span></div>
</header>
<main>
  <h1 id="title">Skenirajte za plaćanje</h1>
  <p class="lede" id="lede">Otvorite Revolut ili banku, skenirajte EPC QR kod i potvrdite plaćanje. Stranica će se automatski ažurirati kad uplata stigne.</p>
  <div class="card">
    <div class="qr-wrap">
      <div id="qrBox">${renderQrSvg(epcText)}</div>
      <p class="qr-hint">EPC SEPA Credit Transfer (Revolut iOS, Erste, PBZ, OTP, RBA — sve podržavaju ovaj format)</p>
    </div>
    <div class="amount-block">
      <div class="amount" id="amount">— EUR</div>
      <div class="amount-label" id="amountLabel">Iznos za plaćanje</div>
    </div>
    <div class="status-bar pending" id="statusBar">
      <span class="pulse-dot"></span>
      <span id="statusText">Čekamo uplatu — istječe za <span class="countdown" id="countdown">—</span></span>
    </div>
    <div class="detail-rows">
      <div class="row"><span class="label">Primatelj wallet</span><span class="value" id="targetVal">—</span></div>
      <div class="row"><span class="label">SEPA reference</span><span class="value" id="memoVal">—</span></div>
      <div class="row"><span class="label">IBAN</span><span class="value">EE70 7777 0001 6292 1128</span></div>
      <div class="row"><span class="label">Primatelj</span><span class="value">ITalk d.o.o.</span></div>
      <div class="row"><span class="label">Sesija</span><span class="value" id="sidVal">—</span></div>
    </div>
  </div>
</main>
<div id="successOverlay" class="success-overlay" style="display:none" role="dialog" aria-modal="true" aria-labelledby="successTitle">
  <div class="success-modal">
    <div class="check" aria-hidden="true">
      <svg viewBox="0 0 36 36" fill="none">
        <path d="M9 18.5l6 6 12-12" stroke="#FFFFFF" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <h2 id="successTitle">Plaćeno!</h2>
    <p class="sub"><strong id="successAmount">—</strong> EURe stiglo je na primateljev Gnosis wallet.</p>
    <a id="txLink" class="tx-link" href="#" target="_blank" rel="noopener">Pogledaj transakciju na Gnosisscanu →</a>
  </div>
</div>
<footer>
  Dio platforme <a href="https://domovina.ai">DOMOVINA.ai</a> · Plaćanje obrađuje MPT (Mint Pay Transfer)
</footer>
<div class="tricolor"><span class="red"></span><span class="white"></span><span class="navy"></span></div>

<script>
const INITIAL = ${JSON.stringify(initialState)};
const SID = INITIAL.sid;
let audioCtx;

function $(id) { return document.getElementById(id); }

function ensureAudio() {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); }
  catch {}
}
function playChime() {
  if (!audioCtx) return;
  try {
    const t0 = audioCtx.currentTime;
    [[660, 0, .18], [880, .12, .32]].forEach(spec => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = spec[0];
      gain.gain.setValueAtTime(0, t0 + spec[1]);
      gain.gain.linearRampToValueAtTime(.2, t0 + spec[1] + .02);
      gain.gain.exponentialRampToValueAtTime(.001, t0 + spec[1] + spec[2]);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0 + spec[1]);
      osc.stop(t0 + spec[1] + spec[2] + .05);
    });
  } catch {}
}

function fmtCountdown(secs) {
  if (secs <= 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function shortAddr(a) { return a ? a.slice(0, 8) + '…' + a.slice(-6) : '—'; }

function applyState(s) {
  $('amount').textContent = s.amount_eur + ' EUR';
  $('targetVal').textContent = shortAddr(s.target_address);
  $('targetVal').setAttribute('title', s.target_address);
  $('memoVal').textContent = s.memo;
  $('sidVal').textContent = s.sid;

  if (s.state === 'pending') {
    const bar = $('statusBar');
    bar.className = 'status-bar pending';
    const remaining = Math.max(0, s.expires_at_unix - Math.floor(Date.now() / 1000));
    $('statusText').innerHTML = 'Čekamo uplatu — istječe za <span class="countdown" id="countdown">' + fmtCountdown(remaining) + '</span>';
  } else if (s.state === 'paid') {
    const bar = $('statusBar');
    bar.className = 'status-bar paid';
    $('statusText').innerHTML = '<span style="font-size:1.1em">✓</span> Uplata potvrđena — EURe na on-chain destinaciji';
    showSuccess(s);
  } else if (s.state === 'expired') {
    const bar = $('statusBar');
    bar.className = 'status-bar expired';
    $('statusText').innerHTML = '<span style="font-size:1.1em">⌛</span> Sesija je istekla. Ako ste već platili, javite primatelju — EURe će svejedno stići.';
  }
}

function showSuccess(s) {
  if ($('successOverlay').style.display !== 'none') return;
  $('successAmount').textContent = ((s.amount_received_cents != null ? s.amount_received_cents : (parseFloat(s.amount_eur) * 100)) / 100).toFixed(2);
  if (s.forward_tx_hash) {
    $('txLink').href = 'https://gnosisscan.io/tx/' + s.forward_tx_hash;
  } else {
    $('txLink').style.display = 'none';
  }
  $('successOverlay').style.display = 'flex';
  ensureAudio();
  playChime();
  if (navigator.vibrate) { try { navigator.vibrate([60, 40, 120]); } catch {} }
}

// Countdown ticker
let countdownInterval = setInterval(() => {
  if (INITIAL.state !== 'pending') return;
  const el = $('countdown');
  if (!el) return;
  const remaining = Math.max(0, INITIAL.expires_at_unix - Math.floor(Date.now() / 1000));
  el.textContent = fmtCountdown(remaining);
  if (remaining === 0) {
    // local UX flip; server cron will catch up authoritatively
    INITIAL.state = 'expired';
    applyState(INITIAL);
    clearInterval(countdownInterval);
  }
}, 1000);

// Polling. Phase 2 will swap to EventSource('/api/intents/<sid>/stream')
// and fall back to this on 404.
async function poll() {
  try {
    const r = await fetch('/api/intents/' + SID, { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    // Mirror the snapshot fields into the same shape applyState expects.
    const flat = {
      sid: d.sid,
      state: d.state,
      amount_eur: d.amount_eur,
      target_address: d.target_address,
      memo: d.memo,
      expires_at_unix: Math.floor(new Date(d.expires_at).getTime() / 1000),
      forward_tx_hash: d.forward_tx_hash,
      amount_received_cents: d.amount_received_cents,
    };
    if (d.state !== INITIAL.state) {
      INITIAL.state = d.state;
      INITIAL.forward_tx_hash = d.forward_tx_hash;
      INITIAL.amount_received_cents = d.amount_received_cents;
      applyState(flat);
    }
    if (d.state === 'paid' || d.state === 'expired') {
      clearInterval(pollInterval);
    }
  } catch {}
}

let pollInterval = INITIAL.state === 'pending' ? setInterval(poll, 2000) : null;

// User gesture handler to unlock audio on first interaction.
document.addEventListener('click', ensureAudio, { once: true });

// Bootstrap — QR rendered server-side, just initialize state UI.
applyState(INITIAL);
</script>
</body>
</html>`;
}

