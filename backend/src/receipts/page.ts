import type { Hono } from 'hono';

import type { Env } from '../types';
import { escapeAttr, jsonForScript } from '../checkout/page';
import { getIntent } from '../intents/db';
import { RECEIPT_CLIENT_JS, RECEIPT_PDF_JS } from './client.generated';
import { isReceiptSid } from './sid';

/// Payer-side receipt pages (ADR 0022 §4). Everything sensitive happens in
/// the browser bundle (client/main.ts); the server only renders a shell.
///
///   /potvrda/nova/:sid  re-issue a pending intent under a key-bound sid
///   /potvrda/:sid       the receipt: sign, fetch, print to PDF
///   /potvrda/client.js  the bundle

const STYLE = `
:root { --navy: #002F6C; --red: #FF0000; --muted: #5b6577; --border: #d9dee7; --bg: #f5f7fa; --warn: #8a4b00; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1b2330; background: var(--bg); }
main { max-width: 760px; margin: 0 auto; padding: 1.25rem 1rem 3rem; }
h1 { color: var(--navy); font-size: 1.5rem; margin: 0 0 .5rem; }
h2 { color: var(--navy); font-size: 1.05rem; margin: 1.25rem 0 .5rem; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; word-break: break-all; }
pre.json { white-space: pre-wrap; background: #fff; border: 1px solid var(--border); padding: .75rem; border-radius: 6px; }
button { font: inherit; padding: .55rem .9rem; border-radius: 6px; border: 1px solid var(--navy); background: #fff; color: var(--navy); cursor: pointer; margin: .25rem .25rem .25rem 0; }
button.primary, a.primary-link { background: var(--navy); color: #fff; border-color: var(--navy); }
a.primary-link { display: inline-block; padding: .55rem .9rem; border-radius: 6px; text-decoration: none; }
input { font: inherit; padding: .5rem; border: 1px solid var(--border); border-radius: 6px; margin: .25rem 0; max-width: 100%; }
.receipt, .card { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem; margin: 1rem 0; }
.receipt header { border-bottom: 3px solid var(--navy); margin-bottom: 1rem; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .35rem 1rem; margin: 0 0 1rem; }
dt { color: var(--muted); }
dd { margin: 0; min-width: 0; }
table { width: 100%; border-collapse: collapse; font-size: .9rem; }
th, td { text-align: left; padding: .4rem .3rem; border-bottom: 1px solid var(--border); }
td.num { text-align: right; white-space: nowrap; }
.muted { color: var(--muted); font-size: .85rem; }
.warn { color: var(--warn); background: #fff4e5; border: 1px solid #f1c48a; padding: .6rem .8rem; border-radius: 6px; }
.msg { color: var(--muted); }
.qr { width: 180px; height: 180px; }
.qr-row { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; }
.tricolor { display: flex; height: 6px; } .tricolor span { flex: 1; }
.tricolor .red { background: var(--red); } .tricolor .white { background: #fff; } .tricolor .navy { background: var(--navy); }
@media (max-width: 520px) { dl { grid-template-columns: 1fr; } th:nth-child(4), td:nth-child(4), th:nth-child(6), td:nth-child(6) { display: none; } }
@media print {
  body { background: #fff; }
  .no-print, .tricolor { display: none !important; }
  .receipt { border: 0; padding: 0; }
  .part-b { break-before: page; }
  a { color: inherit; text-decoration: none; }
}`;

function shell(title: string, config: { mode: 'new' | 'view'; sid: string }, intro: string): string {
  return `<!doctype html>
<html lang="hr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeAttr(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="tricolor"><span class="red"></span><span class="white"></span><span class="navy"></span></div>
<main>
${intro}
<div id="app"><p>Učitavam…</p></div>
<noscript><p class="warn">Potvrda se izrađuje u vašem pregledniku i treba JavaScript.</p></noscript>
</main>
<script type="application/json" id="receipt-config">${jsonForScript(config)}</script>
<script src="/potvrda/pdf.js" defer></script>
<script src="/potvrda/client.js" defer></script>
</body>
</html>`;
}

export function mountReceiptPages(app: Hono<{ Bindings: Env }>): void {
  app.get('/potvrda/client.js', () =>
    new Response(RECEIPT_CLIENT_JS, {
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    }));

  app.get('/potvrda/pdf.js', () =>
    new Response(RECEIPT_PDF_JS, {
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    }));

  app.get('/potvrda/nova/:sid', async (c) => {
    const intent = await getIntent(c.env, c.req.param('sid'));
    if (!intent) return c.text('intent not found', 404);
    if (isReceiptSid(intent.sid)) return c.redirect(`/potvrda/${intent.sid}`);
    const amount = (intent.amount_cents / 100).toFixed(2).replace('.', ',');
    const intro = `<p class="muted no-print">Plaćanje: <strong>${escapeAttr(amount)} EUR</strong>${
      intent.label ? ` · ${escapeAttr(intent.label)}` : ''} · <a href="/checkout/${escapeAttr(intent.sid)}">natrag bez potvrde</a></p>`;
    return c.html(shell('Potvrda o uplati', { mode: 'new', sid: intent.sid }, intro));
  });

  app.get('/potvrda/:sid', async (c) => {
    const sid = c.req.param('sid');
    if (!isReceiptSid(sid)) return c.text('not a receipt reference', 404);
    const intent = await getIntent(c.env, sid);
    if (!intent) return c.text('intent not found', 404);
    const intro = `<p class="muted no-print"><a href="/checkout/${escapeAttr(sid)}">← plaćanje</a></p>`;
    return c.html(shell(`Potvrda ${sid}`, { mode: 'view', sid }, intro));
  });
}
