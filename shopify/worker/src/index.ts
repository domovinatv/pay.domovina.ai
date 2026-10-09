import { Hono } from 'hono';
import { jwtVerify } from 'jose';

import {
  decryptSecret,
  encryptSecret,
  timingSafeEqual,
  verifyMptWebhook,
  verifyShopifyQueryHmac,
  verifyShopifyWebhook,
} from './crypto';
import {
  consumeOAuthState,
  createOAuthState,
  getOrderBySid,
  getShop,
  listOrdersToSync,
  markUninstalled,
  now,
  redactShop,
} from './db';
import { MptError } from './mpt';
import { SHOP_RE, exchangeCode, isOrderGid } from './shopify';
import { ensureIntent, refreshOrder } from './sync';
import type { Env, MptIntent, OrderRow } from './types';

/// MPT for Shopify — "Path B": the merchant adds a manual payment method, this
/// app creates an MPT intent per order, the Thank-you / Order status extension
/// shows the EPC QR, and settlement marks the order paid via the Admin API.
/// See shopify/README.md.

const app = new Hono<{ Bindings: Env }>();

// ── Install / OAuth ─────────────────────────────────────────────────────────

/// App URL. Shopify opens it with ?shop&hmac&timestamp on install and from
/// the admin Apps list. Not embedded: a plain status page after install.
app.get('/', async (c) => {
  const url = new URL(c.req.url);
  const shop = url.searchParams.get('shop') ?? '';
  if (!SHOP_RE.test(shop) || !(await verifyShopifyQueryHmac(url.searchParams, c.env.SHOPIFY_API_SECRET))) {
    return c.html(page('MPT za Shopify', '<p>Instalirajte aplikaciju iz Shopify admina.</p>'));
  }
  const row = await getShop(c.env, shop);
  if (!row?.access_token_enc) return c.redirect(`/auth?${url.searchParams.toString()}`);
  const ready = row.active === 1 && !!row.target_address && !!row.mpt_api_key_enc;
  return c.html(
    page(
      'MPT za Shopify',
      ready
        ? `<p>✅ Aktivno za <b>${esc(shop)}</b>. Narudžbe plaćene načinom koji sadrži „${esc(row.gateway_match)}“ dobivaju QR kod i automatski se označavaju plaćenima.</p>`
        : `<p>Aplikacija je instalirana na <b>${esc(shop)}</b>, ali MPT još nije aktiviran.</p>
           <p>Javite se na <b>mpt.hr</b> — aktivacija traži vaš Monerium račun (KYB) i adresu Safea za isplatu.</p>`,
    ),
  );
});

app.get('/auth', async (c) => {
  const url = new URL(c.req.url);
  const shop = url.searchParams.get('shop') ?? '';
  if (!SHOP_RE.test(shop)) return c.text('invalid shop', 400);
  // Shopify's own install redirect is HMAC-signed; refuse unsigned starts so a
  // third party cannot bounce merchants through our OAuth flow.
  if (!(await verifyShopifyQueryHmac(url.searchParams, c.env.SHOPIFY_API_SECRET))) return c.text('invalid hmac', 401);
  const state = await createOAuthState(c.env, shop);
  const authorize = new URL(`https://${shop}/admin/oauth/authorize`);
  authorize.searchParams.set('client_id', c.env.SHOPIFY_API_KEY);
  authorize.searchParams.set('scope', c.env.SHOPIFY_SCOPES);
  authorize.searchParams.set('redirect_uri', `${c.env.APP_URL}/auth/callback`);
  authorize.searchParams.set('state', state);
  return c.redirect(authorize.toString());
});

app.get('/auth/callback', async (c) => {
  const url = new URL(c.req.url);
  const shop = url.searchParams.get('shop') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const state = url.searchParams.get('state') ?? '';
  if (!SHOP_RE.test(shop) || !code) return c.text('invalid callback', 400);
  if (!(await consumeOAuthState(c.env, state, shop))) return c.text('invalid state', 401);
  if (!(await verifyShopifyQueryHmac(url.searchParams, c.env.SHOPIFY_API_SECRET))) return c.text('invalid hmac', 401);
  await exchangeCode(c.env, shop, code);
  return c.redirect(`https://${shop}/admin/apps/${c.env.SHOPIFY_API_KEY}`);
});

// ── Shopify webhooks (declared in shopify.app.toml) ─────────────────────────

app.post('/webhooks/shopify', async (c) => {
  const raw = await c.req.text();
  if (!(await verifyShopifyWebhook(raw, c.req.header('x-shopify-hmac-sha256') ?? null, c.env.SHOPIFY_API_SECRET))) {
    return c.text('invalid hmac', 401);
  }
  const topic = c.req.header('x-shopify-topic') ?? '';
  const shop = c.req.header('x-shopify-shop-domain') ?? '';
  if (!SHOP_RE.test(shop)) return c.text('invalid shop', 400);
  const body = safeJson<Record<string, unknown>>(raw) ?? {};

  switch (topic) {
    case 'orders/create': {
      const gid = typeof body.admin_graphql_api_id === 'string' ? body.admin_graphql_api_id : '';
      // Answer Shopify fast (5 s budget); the extension creates the intent
      // lazily if this background run is lost.
      if (isOrderGid(gid)) {
        c.executionCtx.waitUntil(
          ensureIntent(c.env, shop, gid).catch((e) => console.error('orders/create ensureIntent', shop, gid, e)),
        );
      }
      break;
    }
    case 'app/uninstalled':
      await markUninstalled(c.env, shop);
      break;
    case 'shop/redact':
      await redactShop(c.env, shop);
      break;
    case 'customers/data_request':
    case 'customers/redact':
      // We store no customer data: orders are keyed by order id, with amount
      // and order name only. Nothing to export or erase.
      break;
  }
  return c.text('ok');
});

// ── MPT outbound webhooks (tenant outbound_webhook_url points here) ─────────

const MPT_EVENTS = new Set(['intent.paid', 'payment.late', 'payment.received', 'payment.rejected']);

app.post('/webhooks/mpt', async (c) => {
  const raw = await c.req.text();
  const payload = safeJson<{ type?: string; sid?: string | null }>(raw);
  if (!payload?.type || !MPT_EVENTS.has(payload.type) || !payload.sid) {
    return c.text('ignored'); // other tenant events (campaigns, forward.blocked) — 2xx so the outbox stops
  }
  const row = await getOrderBySid(c.env, payload.sid);
  if (!row) return c.text('unknown sid'); // not a Shopify order — 2xx, nothing to retry
  const shop = await getShop(c.env, row.shop);
  if (!shop?.mpt_webhook_secret_enc) return c.text('webhook secret not configured', 401);
  const ok = await verifyMptWebhook({
    id: c.req.header('webhook-id') ?? null,
    timestamp: c.req.header('webhook-timestamp') ?? null,
    signature: c.req.header('webhook-signature') ?? null,
    body: raw,
    secret: await decryptSecret(c.env.TOKEN_KEK, shop.mpt_webhook_secret_enc),
    nowUnix: now(),
  });
  if (!ok) return c.text('invalid signature', 401);
  // The payload is only a trigger: re-read the intent so the order status
  // comes from the authoritative API, never from a webhook body.
  await refreshOrder(c.env, row);
  return c.text('ok');
});

// ── Thank-you / Order status extension API ──────────────────────────────────

const CORS = {
  // UI extensions run in a sandboxed worker with an opaque origin.
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-max-age': '86400',
};

app.options('/ext/*', (c) => c.body(null, 204, CORS));

app.get('/ext/order', async (c) => {
  const shop = await verifySessionToken(c.env, c.req.header('authorization'));
  if (!shop) return c.json({ error: 'unauthorized' }, 401, CORS);
  const orderGid = c.req.query('order_id') ?? '';
  if (!isOrderGid(orderGid)) return c.json({ error: 'invalid_order_id' }, 400, CORS);

  try {
    const res = await ensureIntent(c.env, shop, orderGid);
    if (res.kind === 'skip') return c.json({ status: 'not_applicable', reason: res.reason }, 200, CORS);
    let row = res.order;
    // The extension polls every few seconds; refresh from MPT at most every 4 s.
    const open = row.status === 'pending' || row.status === 'received' || row.status === 'expired';
    if (open && (row.last_polled_at ?? 0) < now() - 4) row = await refreshOrder(c.env, row);
    return c.json(publicView(row), 200, CORS);
  } catch (e) {
    // MPT refused the intent for good (amount over the cap, target not
    // whitelisted, tenant rail off): tell the buyer instead of polling forever.
    if (e instanceof MptError && e.status >= 400 && e.status < 500) {
      console.error('ext/order mpt refused', shop, orderGid, e.code);
      return c.json({ status: 'unavailable', reason: e.code }, 200, CORS);
    }
    console.error('ext/order', shop, orderGid, e);
    return c.json({ error: 'temporarily_unavailable' }, 503, CORS);
  }
});

/// What the buyer's page may see: payment instructions and status, nothing else.
function publicView(row: OrderRow): Record<string, unknown> {
  const i = row.intent_json ? (safeJson<MptIntent>(row.intent_json) ?? null) : null;
  return {
    status: row.status,
    order_name: row.order_name,
    amount_eur: (row.amount_cents / 100).toFixed(2),
    expires_at: i?.expires_at ?? null,
    review_expected: i?.status?.review_expected ?? null,
    qr: i
      ? {
          epc_qr_data: i.epc_qr_data,
          iban: i.iban,
          bic: i.bic,
          beneficiary_name: i.beneficiary_name,
          reference: i.memo,
          checkout_url: i.checkout_url,
        }
      : null,
  };
}

/// Checkout / customer-account session token: HS256 JWT signed with the app
/// secret, `aud` = client id, `dest` = the shop. Returns the shop domain.
async function verifySessionToken(env: Env, header: string | undefined): Promise<string | null> {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(env.SHOPIFY_API_SECRET), {
      algorithms: ['HS256'],
      audience: env.SHOPIFY_API_KEY,
      clockTolerance: 10,
    });
    const dest = typeof payload.dest === 'string' ? payload.dest.replace(/^https:\/\//, '').replace(/\/$/, '') : '';
    return SHOP_RE.test(dest) ? dest : null;
  } catch {
    return null;
  }
}

// ── Operator API (activation after the merchant's MPT tenant is onboarded) ──

app.use('/admin/*', async (c, next) => {
  const auth = c.req.header('authorization') ?? '';
  if (!c.env.ADMIN_TOKEN || !timingSafeEqual(auth, `Bearer ${c.env.ADMIN_TOKEN}`)) return c.text('unauthorized', 401);
  await next();
});

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

app.put('/admin/shops/:shop', async (c) => {
  const shop = c.req.param('shop');
  const row = await getShop(c.env, shop);
  if (!row) return c.json({ error: 'shop_not_installed' }, 404);
  const b = await c.req.json<{
    active?: boolean;
    mpt_api_key?: string;
    mpt_webhook_secret?: string;
    target_address?: string;
    gateway_match?: string;
    intent_ttl_seconds?: number;
    auto_cancel?: boolean;
  }>();
  if (b.target_address !== undefined && !ADDR_RE.test(b.target_address)) return c.json({ error: 'invalid_target_address' }, 400);
  if (b.mpt_webhook_secret !== undefined && !b.mpt_webhook_secret.startsWith('whsec_')) {
    return c.json({ error: 'webhook_secret_must_be_whsec' }, 400);
  }
  if (b.intent_ttl_seconds !== undefined && (b.intent_ttl_seconds < 600 || b.intent_ttl_seconds > 86_400)) {
    return c.json({ error: 'intent_ttl_out_of_range', min: 600, max: 86_400 }, 400);
  }
  if (b.gateway_match !== undefined && b.gateway_match.trim().length < 3) return c.json({ error: 'gateway_match_too_short' }, 400);

  const sets: string[] = [];
  const args: unknown[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    args.push(v);
  };
  if (b.active !== undefined) set('active', b.active ? 1 : 0);
  if (b.mpt_api_key !== undefined) set('mpt_api_key_enc', await encryptSecret(c.env.TOKEN_KEK, b.mpt_api_key.trim()));
  if (b.mpt_webhook_secret !== undefined) set('mpt_webhook_secret_enc', await encryptSecret(c.env.TOKEN_KEK, b.mpt_webhook_secret.trim()));
  if (b.target_address !== undefined) set('target_address', b.target_address.toLowerCase());
  if (b.gateway_match !== undefined) set('gateway_match', b.gateway_match.trim());
  if (b.intent_ttl_seconds !== undefined) set('intent_ttl_seconds', Math.floor(b.intent_ttl_seconds));
  if (b.auto_cancel !== undefined) set('auto_cancel', b.auto_cancel ? 1 : 0);
  if (sets.length === 0) return c.json({ error: 'nothing_to_update' }, 400);
  set('updated_at', now());
  await c.env.DB.prepare(`UPDATE shops SET ${sets.join(', ')} WHERE shop = ?`).bind(...args, shop).run();
  return c.json(await shopView(c.env, shop));
});

app.get('/admin/shops/:shop', async (c) => {
  const view = await shopView(c.env, c.req.param('shop'));
  return view ? c.json(view) : c.json({ error: 'not_found' }, 404);
});

app.post('/admin/orders/:sid/resync', async (c) => {
  const row = await getOrderBySid(c.env, c.req.param('sid'));
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(await refreshOrder(c.env, row));
});

async function shopView(env: Env, shop: string): Promise<Record<string, unknown> | null> {
  const row = await getShop(env, shop);
  if (!row) return null;
  const orders = await env.DB.prepare(
    `SELECT sid, order_name, amount_cents, status, paid_at, forward_tx_hash, shopify_synced_at, last_error, created_at
       FROM orders WHERE shop = ? ORDER BY created_at DESC LIMIT 20`,
  )
    .bind(shop)
    .all();
  return {
    shop: row.shop,
    installed: !!row.access_token_enc,
    uninstalled_at: row.uninstalled_at,
    active: row.active === 1,
    has_mpt_api_key: !!row.mpt_api_key_enc,
    has_mpt_webhook_secret: !!row.mpt_webhook_secret_enc,
    target_address: row.target_address,
    gateway_match: row.gateway_match,
    intent_ttl_seconds: row.intent_ttl_seconds,
    auto_cancel: row.auto_cancel === 1,
    recent_orders: orders.results,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function safeJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="hr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}h1{color:#002F6C}</style>
</head><body><h1>${esc(title)}</h1>${body}</body></html>`;
}

export default {
  fetch: app.fetch,
  /// Every 2 min: poll open orders against the MPT intent API. The MPT webhook
  /// is the fast path; this is the backstop for lost webhooks and for retrying
  /// Admin API calls that failed.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const rows = await listOrdersToSync(env, 50);
        for (const row of rows) {
          if ((row.last_polled_at ?? 0) > now() - 60) continue;
          await refreshOrder(env, row).catch((e) => console.error('cron refresh', row.sid, e));
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
