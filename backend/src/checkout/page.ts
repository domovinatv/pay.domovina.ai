import qrcode from 'qrcode-generator';

import type { PaymentIntentRow } from '../intents/db';
import type { StageResult } from '../intents/stage';

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

/// Serialize a value for safe embedding inside an inline <script>. Plain
/// JSON.stringify does NOT escape `<`, so any attacker-controlled string in
/// the payload (e.g. `label`, settable via the UNAUTHENTICATED POST
/// /api/intents) containing `</script>` would break out of the tag → stored
/// XSS on the payments origin. Escaping `<`, `>`, `&` and the JS-only line
/// terminators U+2028/U+2029 makes the output inert while staying valid JSON.
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/// Buyer-facing checkout page. Server-renders once with the snapshot, then
/// client polls /api/intents/<sid> every 2s and re-renders the timeline.
///
/// Honest per-stage timeline ("gdje su moji novci"):
///   - vertical steps, each naming the current CUSTODIAN of the money
///   - markers distinguish proof from assumption: ✓ proven, animated dot
///     in-progress, hollow circle waiting (blind), ⚠ failed
///   - the user→bank→SEPA window is BLIND (no Monerium order exists yet),
///     so that step shows only elapsed time + progressively-revealed
///     expectation copy — never fake progress
///   - success overlay fires on `settled` (forward mined on-chain, or
///     direct mint processed), not merely on broadcast
export function renderCheckoutPage(
  intent: PaymentIntentRow,
  status: StageResult,
): string {
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
    expires_at_unix: intent.expires_at,
    paid_at: intent.paid_at,
    forward_tx_hash: intent.forward_tx_hash,
    amount_received_cents: intent.amount_received_cents,
    status,
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

/* ---- Vertical status timeline ---- */
.timeline { margin: 1rem 0 .5rem; padding: .25rem 0; }
.tl-step { display: flex; gap: .8rem; position: relative; }
.tl-rail { display: flex; flex-direction: column; align-items: center; width: 26px; flex: none; }
.tl-marker {
  width: 22px; height: 22px; border-radius: 50%; flex: none;
  display: flex; align-items: center; justify-content: center;
  font-size: .8rem; font-weight: 800; background: var(--bg);
  border: 2px solid var(--border); color: var(--muted);
}
.tl-step.proven .tl-marker { background: var(--success); border-color: var(--success); color: #fff; }
.tl-step.in_progress .tl-marker { border-color: var(--warning); color: var(--warning); }
.tl-step.in_progress .tl-marker::after {
  content: ''; width: 9px; height: 9px; border-radius: 50%;
  background: var(--warning); animation: pulse-anim 1.4s ease-in-out infinite;
}
.tl-step.failed .tl-marker { background: var(--danger); border-color: var(--danger); color: #fff; }
.tl-line { width: 2px; flex: 1; min-height: 14px; background: var(--border); }
.tl-step.proven .tl-line { background: var(--success); }
.tl-step:last-child .tl-line { display: none; }
.tl-body { padding: 0 0 1rem; flex: 1; min-width: 0; }
.tl-title { font-size: .92rem; font-weight: 700; line-height: 22px; }
.tl-step.waiting .tl-title { color: var(--muted); font-weight: 600; }
.tl-custodian { font-size: .78rem; color: var(--muted); margin-top: .1rem; }
.tl-note { font-size: .84rem; color: var(--navy); line-height: 1.45; margin-top: .35rem; }
.tl-note .soft { color: var(--muted); }
.tl-note a { color: var(--navy); font-weight: 600; }
.tl-note .reassure {
  display: block; margin-top: .4rem; padding: .55rem .7rem;
  background: #FDF6EC; border: 1px solid #E8B96E; border-radius: .45rem;
  color: var(--warning); font-size: .82rem; line-height: 1.45;
}
.tl-tx { font-size: .78rem; margin-top: .25rem; }
.tl-tx a { color: var(--navy); font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
.elapsed { font-variant-numeric: tabular-nums; font-weight: 700; }

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
.detail-rows { font-size: .88rem; }
.detail-rows .row {
  display: flex; justify-content: space-between; gap: 1rem;
  padding: .5rem 0; border-bottom: 1px solid var(--border);
}
.detail-rows .row:last-child { border-bottom: 0; }
.detail-rows .label { color: var(--muted); }
.detail-rows .value { color: var(--navy); font-weight: 600; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; word-break: break-all; text-align: right; }
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
  <p class="lede" id="lede">Otvorite Revolut ili banku, skenirajte EPC QR kod i potvrdite plaćanje. Stranica prati svaki korak uplate — od vaše banke do primatelja.</p>
  <div class="card">
    <div class="qr-wrap" id="qrWrap">
      <div id="qrBox">${renderQrSvg(epcText)}</div>
      <p class="qr-hint">EPC SEPA Credit Transfer (Revolut iOS, Erste, PBZ, OTP, RBA — sve podržavaju ovaj format)</p>
    </div>
    <div class="amount-block">
      <div class="amount" id="amount">— EUR</div>
      <div class="amount-label" id="amountLabel">Iznos za plaćanje</div>
    </div>
    <div id="statusArea"></div>
    <div class="timeline" id="timeline"></div>
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
const INITIAL = ${jsonForScript(initialState)};
const SID = INITIAL.sid;
// Elapsed clock: server-authoritative offset + local ticking between polls.
const LOADED_AT = Math.floor(Date.now() / 1000);
let serverElapsed = (INITIAL.status && INITIAL.status.elapsed_seconds) || 0;
let latest = INITIAL;
let audioCtx;

function $(id) { return document.getElementById(id); }

// Stage→copy table. Same wording as the Flutter table
// (lib/models/payment_status.dart) — change both together.
//
// Honesty rules baked into this copy (docs/plans/payment-status-timeline.md):
// no fake progress in the blind window, no "AML hold" claims (Monerium
// 'pending' is opaque), no "seconds" promise for a first-ever payment,
// custodian named on every step.
const STEP_COPY = {
  payment:    { title: 'Uplata iz tvoje banke',        custodian: 'Skrbnik: tvoja banka' },
  processing: { title: 'Zaprimljeno — obrada i provjera', custodian: 'Skrbnik: Monerium (regulirani izdavatelj e-novca)' },
  minted:     { title: 'EURe iskovan',                 custodian: 'Na blockchainu (Gnosis)' },
  forwarding: { title: 'Prosljeđivanje primatelju',    custodian: 'MPT relay' },
  settled:    { title: 'Kod primatelja',               custodian: 'Skrbnik: primatelj' },
};

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

function fmtClock(secs) {
  if (secs <= 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function shortAddr(a) { return a ? a.slice(0, 8) + '…' + a.slice(-6) : '—'; }
function shortHash(h) { return h ? h.slice(0, 10) + '…' + h.slice(-8) : ''; }
function esc(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function currentElapsed() {
  return serverElapsed + (Math.floor(Date.now() / 1000) - lastSyncAt);
}
let lastSyncAt = LOADED_AT;

function markerHtml(status) {
  if (status === 'proven') return '✓';
  if (status === 'failed') return '!';
  return ''; // in_progress gets the pulsing dot via ::after; waiting stays hollow
}

/// Progressive disclosure inside the blind window (no Monerium order yet):
/// the only truthful signal is elapsed time, so the copy escalates exactly
/// when the payer starts worrying — never an animated fake progress bar.
function blindWindowNote(elapsed) {
  if (elapsed < 8) {
    return '<span class="soft">Čeka se uplata… <span class="elapsed">' + fmtClock(elapsed) + '</span></span>';
  }
  if (elapsed < 25) {
    return 'Tvoja banka obrađuje uplatu… <span class="elapsed">' + fmtClock(elapsed) + '</span>';
  }
  // Deliberately NO revolut:// deep link: the scheme exists but is only
  // documented for the native Revolut Pay SDK (LSApplicationQueriesSchemes),
  // not as a web href — behaviour from mobile browsers is undefined.
  return 'Čekamo tvoju banku. <span class="elapsed">' + fmtClock(elapsed) + '</span>' +
    '<span class="reassure">Prva uplata s novog računa zna potrajati (do 30 min). ' +
    'Novac je siguran. Ne moraš ništa raditi. ' +
    'Provjeri u Revolutu (ili svojoj banci) je li uplata poslana.</span>';
}

function stepNote(step, status) {
  const stage = status.stage;
  if (step.key === 'payment' && stage === 'awaiting_payment') {
    return blindWindowNote(currentElapsed());
  }
  if (step.key === 'processing' && stage === 'received_processing') {
    return 'Stiglo je — novac je siguran kod Moneriuma. Radi se provjera. Ne moraš ništa.';
  }
  if (step.key === 'processing' && stage === 'rejected') {
    const why = status.rejected_reason ? 'Razlog: ' + esc(status.rejected_reason) + '. ' : '';
    return why + 'Novac se vraća na tvoj račun.';
  }
  if (step.key === 'forwarding' && step.status === 'in_progress') {
    return 'Transakcija poslana na blockchain, čeka se potvrda…';
  }
  if (step.key === 'forwarding' && step.status === 'failed') {
    return 'Prosljeđivanje nije uspjelo — novac je siguran u MPT Safeu, rješavamo ručno.';
  }
  if (step.key === 'settled' && step.status === 'proven') {
    return 'Potvrđeno on-chain. Gotovo!';
  }
  return '';
}

function txLinksHtml(step, status) {
  const links = [];
  if (step.key === 'minted' && status.mint_tx_hashes && status.mint_tx_hashes.length) {
    status.mint_tx_hashes.forEach(h => {
      links.push('<a href="https://gnosisscan.io/tx/' + esc(h) + '" target="_blank" rel="noopener">mint ' + esc(shortHash(h)) + '</a>');
    });
  }
  if ((step.key === 'forwarding' || step.key === 'settled') && step.tx_hash) {
    links.push('<a href="https://gnosisscan.io/tx/' + esc(step.tx_hash) + '" target="_blank" rel="noopener">tx ' + esc(shortHash(step.tx_hash)) + '</a>');
  }
  return links.length ? '<div class="tl-tx">' + links.join(' · ') + '</div>' : '';
}

function renderTimeline(status) {
  const html = status.steps.map(step => {
    const copy = STEP_COPY[step.key] || { title: step.key, custodian: '' };
    const note = stepNote(step, status);
    return '<div class="tl-step ' + step.status + '">' +
      '<div class="tl-rail"><div class="tl-marker">' + markerHtml(step.status) + '</div><div class="tl-line"></div></div>' +
      '<div class="tl-body">' +
        '<div class="tl-title">' + esc(copy.title) + '</div>' +
        '<div class="tl-custodian">' + esc(copy.custodian) + '</div>' +
        (note ? '<div class="tl-note">' + note + '</div>' : '') +
        txLinksHtml(step, status) +
      '</div>' +
    '</div>';
  }).join('');
  $('timeline').innerHTML = html;
}

function renderStatusBar(s) {
  const status = s.status;
  const stage = status ? status.stage : (s.state === 'paid' ? 'settled' : s.state === 'expired' ? 'expired' : 'awaiting_payment');
  let cls, inner;
  if (stage === 'expired') {
    cls = 'expired';
    inner = '<span style="font-size:1.1em">⌛</span> Sesija je istekla. Ako ste već platili, novac će svejedno stići — ova stranica će to prikazati.';
  } else if (stage === 'rejected') {
    cls = 'expired';
    inner = '<span style="font-size:1.1em">⚠</span> Uplata je odbijena — novac se vraća na tvoj račun.';
  } else if (stage === 'settled') {
    cls = 'paid';
    inner = '<span style="font-size:1.1em">✓</span> Uplata potvrđena — EURe kod primatelja';
  } else if (stage === 'awaiting_payment') {
    const remaining = Math.max(0, s.expires_at_unix - Math.floor(Date.now() / 1000));
    cls = 'pending';
    inner = '<span class="pulse-dot"></span> Čekamo uplatu — istječe za <span class="countdown" id="countdown">' + fmtClock(remaining) + '</span>';
  } else {
    cls = 'pending';
    inner = '<span class="pulse-dot"></span> Uplata je stigla — u obradi';
  }
  $('statusArea').innerHTML = '<div class="status-bar ' + cls + '" id="statusBar">' + inner + '</div>';
}

function applyState(s) {
  $('amount').textContent = s.amount_eur + ' EUR';
  $('targetVal').textContent = shortAddr(s.target_address);
  $('targetVal').setAttribute('title', s.target_address);
  $('memoVal').textContent = s.memo;
  $('sidVal').textContent = s.sid;
  renderStatusBar(s);
  if (s.status) renderTimeline(s.status);
  const stage = s.status ? s.status.stage : null;
  if (stage === 'settled') showSuccess(s);
  // Once money verifiably left the bank leg, the QR is done its job —
  // collapse it so the timeline is the hero.
  if (stage && stage !== 'awaiting_payment' && stage !== 'expired') {
    $('qrWrap').style.display = 'none';
  }
}

function showSuccess(s) {
  if ($('successOverlay').style.display !== 'none') return;
  $('successAmount').textContent = ((s.amount_received_cents != null ? s.amount_received_cents : (parseFloat(s.amount_eur) * 100)) / 100).toFixed(2);
  const tx = (s.status && s.status.forward_tx_hash) || s.forward_tx_hash;
  if (tx) {
    $('txLink').href = 'https://gnosisscan.io/tx/' + tx;
  } else {
    $('txLink').style.display = 'none';
  }
  $('successOverlay').style.display = 'flex';
  ensureAudio();
  playChime();
  if (navigator.vibrate) { try { navigator.vibrate([60, 40, 120]); } catch {} }
}

// 1 s ticker: countdown while waiting + live elapsed copy in the blind window.
setInterval(() => {
  const stage = latest.status ? latest.status.stage : null;
  if (stage !== 'awaiting_payment') return;
  const el = $('countdown');
  if (el) {
    const remaining = Math.max(0, latest.expires_at_unix - Math.floor(Date.now() / 1000));
    el.textContent = fmtClock(remaining);
  }
  renderTimeline(latest.status);
}, 1000);

// Polling. Phase 2 will swap to EventSource('/api/intents/<sid>/stream')
// and fall back to this on 404. Note: polling continues on 'expired' —
// a late SEPA arrival after expiry still forwards, and the page should
// honestly show it.
async function poll() {
  try {
    const r = await fetch('/api/intents/' + SID, { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    serverElapsed = (d.status && d.status.elapsed_seconds) || serverElapsed;
    lastSyncAt = Math.floor(Date.now() / 1000);
    const flat = {
      sid: d.sid,
      state: d.state,
      amount_eur: d.amount_eur,
      target_address: d.target_address,
      memo: d.memo,
      expires_at_unix: Math.floor(new Date(d.expires_at).getTime() / 1000),
      forward_tx_hash: d.forward_tx_hash,
      amount_received_cents: d.amount_received_cents,
      status: d.status,
    };
    latest = flat;
    applyState(flat);
    const stage = d.status ? d.status.stage : null;
    if (stage === 'settled' || stage === 'rejected') {
      clearInterval(pollInterval);
    }
  } catch {}
}

const terminal = INITIAL.status && (INITIAL.status.stage === 'settled' || INITIAL.status.stage === 'rejected');
let pollInterval = terminal ? null : setInterval(poll, 2000);

// User gesture handler to unlock audio on first interaction.
document.addEventListener('click', ensureAudio, { once: true });

// Bootstrap — QR rendered server-side, just initialize state UI.
applyState(INITIAL);
</script>
</body>
</html>`;
}
