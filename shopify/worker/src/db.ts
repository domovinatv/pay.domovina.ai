import type { Env, OrderRow, OrderStatus, ShopRow } from './types';

export const now = (): number => Math.floor(Date.now() / 1000);

export async function getShop(env: Env, shop: string): Promise<ShopRow | null> {
  return env.DB.prepare('SELECT * FROM shops WHERE shop = ?').bind(shop).first<ShopRow>();
}

export async function saveInstall(
  env: Env,
  shop: string,
  t: {
    accessEnc: string;
    accessExpiresAt: number | null;
    refreshEnc: string | null;
    refreshExpiresAt: number | null;
    scope: string;
  },
): Promise<void> {
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO shops (shop, access_token_enc, access_expires_at, refresh_token_enc, refresh_expires_at,
                        scope, installed_at, uninstalled_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(shop) DO UPDATE SET
       access_token_enc = excluded.access_token_enc,
       access_expires_at = excluded.access_expires_at,
       refresh_token_enc = excluded.refresh_token_enc,
       refresh_expires_at = excluded.refresh_expires_at,
       scope = excluded.scope,
       uninstalled_at = NULL,
       updated_at = excluded.updated_at`,
  )
    .bind(shop, t.accessEnc, t.accessExpiresAt, t.refreshEnc, t.refreshExpiresAt, t.scope, ts, ts)
    .run();
}

export async function markUninstalled(env: Env, shop: string): Promise<void> {
  // Tokens are dead once the app is uninstalled; drop them, keep the MPT config
  // so a reinstall does not need re-onboarding.
  await env.DB.prepare(
    `UPDATE shops SET access_token_enc = NULL, refresh_token_enc = NULL, access_expires_at = NULL,
                      refresh_expires_at = NULL, uninstalled_at = ?, updated_at = ? WHERE shop = ?`,
  )
    .bind(now(), now(), shop)
    .run();
}

/// shop/redact (48 h after uninstall): forget the shop entirely.
export async function redactShop(env: Env, shop: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM orders WHERE shop = ?').bind(shop),
    env.DB.prepare('DELETE FROM shops WHERE shop = ?').bind(shop),
  ]);
}

export async function getOrderBySid(env: Env, sid: string): Promise<OrderRow | null> {
  return env.DB.prepare('SELECT * FROM orders WHERE sid = ?').bind(sid).first<OrderRow>();
}

export async function getOrder(env: Env, shop: string, orderGid: string): Promise<OrderRow | null> {
  return env.DB.prepare('SELECT * FROM orders WHERE shop = ? AND order_gid = ?').bind(shop, orderGid).first<OrderRow>();
}

export async function insertOrder(
  env: Env,
  o: Pick<OrderRow, 'sid' | 'shop' | 'order_gid' | 'order_name' | 'amount_cents' | 'intent_json' | 'expires_at'>,
): Promise<void> {
  const ts = now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO orders (sid, shop, order_gid, order_name, amount_cents, status, intent_json,
                                   expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
  )
    .bind(o.sid, o.shop, o.order_gid, o.order_name, o.amount_cents, o.intent_json, o.expires_at, ts, ts)
    .run();
}

export async function updateOrder(
  env: Env,
  sid: string,
  patch: Partial<Pick<OrderRow, 'status' | 'intent_json' | 'paid_at' | 'forward_tx_hash' | 'amount_received_cents' | 'shopify_synced_at' | 'last_error' | 'last_polled_at'>>,
): Promise<void> {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  await env.DB.prepare(`UPDATE orders SET ${sets}, updated_at = ? WHERE sid = ?`)
    .bind(...keys.map((k) => patch[k] ?? null), now(), sid)
    .run();
}

/// Orders that still need a backend poll: open (expired and cancelled included
/// — a late SEPA payment can still land), or final but not yet told to Shopify
/// (a failed Admin API call is retried here). Bounded to 8 days — a payment
/// later than that is a support case, not a cron job.
export async function listOrdersToSync(env: Env, limit: number): Promise<OrderRow[]> {
  const open: OrderStatus[] = ['pending', 'received', 'expired', 'cancelled'];
  const res = await env.DB.prepare(
    `SELECT * FROM orders
      WHERE created_at > ?
        AND (status IN (${open.map(() => '?').join(',')})
             OR (shopify_synced_at IS NULL AND status IN ('paid', 'underpaid', 'expired')))
      ORDER BY COALESCE(last_polled_at, 0) LIMIT ?`,
  )
    .bind(now() - 8 * 86400, ...open, limit)
    .all<OrderRow>();
  return res.results ?? [];
}

export async function createOAuthState(env: Env, shop: string): Promise<string> {
  const state = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE created_at < ?').bind(now() - 600),
    env.DB.prepare('INSERT INTO oauth_states (state, shop, created_at) VALUES (?, ?, ?)').bind(state, shop, now()),
  ]);
  return state;
}

/// One-shot: a state is valid once, for the shop it was issued to, for 10 min.
export async function consumeOAuthState(env: Env, state: string, shop: string): Promise<boolean> {
  const row = await env.DB.prepare('DELETE FROM oauth_states WHERE state = ? RETURNING shop, created_at')
    .bind(state)
    .first<{ shop: string; created_at: number }>();
  return !!row && row.shop === shop && row.created_at > now() - 600;
}
