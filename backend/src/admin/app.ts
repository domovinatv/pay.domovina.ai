import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';

import type { Env } from '../types';
import {
  getMoneriumWebhookEvent,
  listForwards,
  listMoneriumOrders,
  listMoneriumWebhookEvents,
  getMoneriumOrder,
} from '../monerium/db';
import { listIntents } from '../intents/db';
import {
  countWallets,
  listPhoneBindingsForCredentials,
  listSybilClusters,
  listWallets,
  listWalletsSharingPhone,
} from '../wallets/db';
import { publicWalletView } from '../wallets/api';
import { mountTenantAdmin } from '../tenants/admin';
import {
  renderEventDetailPage,
  renderEventsPage,
  renderForwardsPage,
  renderIntentsPage,
  renderOrderDetailPage,
  renderOrdersPage,
  renderSybilPage,
  renderWalletsPage,
} from './views';

/// Mounts the branded `/admin` HTML dashboard on the given app.
///
/// Auth model: Hono's basicAuth middleware. Credentials are
/// `MONERIUM_ADMIN_USER` / `MONERIUM_ADMIN_PASS` secrets. If either is
/// missing the entire /admin tree returns 503 — we never want to expose the
/// webhook audit log unauthenticated (it contains IBANs, wallet addresses,
/// and HMAC failure debug info).
///
/// JSON endpoints under `/admin/api/*` are gated by the same Basic Auth so
/// the dashboard's fetch() calls inherit the browser's cached credentials.
export function mountAdminUi(app: Hono<{ Bindings: Env }>): void {
  app.use('/admin/*', async (c, next) => {
    const user = c.env.MONERIUM_ADMIN_USER;
    const pass = c.env.MONERIUM_ADMIN_PASS;
    if (!user || !pass) {
      return c.text('admin not configured (set MONERIUM_ADMIN_USER + PASS)', 503);
    }
    return basicAuth({ username: user, password: pass, realm: 'DOMOVINA Monerium admin' })(c, next);
  });
  // Some browsers cache the Basic Auth even after explicit logout — short-
  // circuit unauthenticated requests at the root too, so a typo'd URL on a
  // shared machine doesn't leak via cached creds from a different realm.
  app.get('/admin', (c) => c.html(renderEventsPage()));
  app.get('/admin/', (c) => c.html(renderEventsPage()));
  app.get('/admin/events/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.text('bad id', 400);
    const ev = await getMoneriumWebhookEvent(c.env, id);
    if (!ev) return c.text('event not found', 404);
    return c.html(renderEventDetailPage(ev));
  });
  app.get('/admin/orders', (c) => c.html(renderOrdersPage()));
  app.get('/admin/orders/:id', async (c) => {
    const order = await getMoneriumOrder(c.env, c.req.param('id'));
    if (!order) return c.text('order not found', 404);
    return c.html(renderOrderDetailPage(order));
  });
  app.get('/admin/forwards', (c) => c.html(renderForwardsPage()));
  app.get('/admin/api/forwards', async (c) => {
    const status = c.req.query('status') || undefined;
    const { items, total } = await listForwards(c.env, { status, limit: 100 });
    return c.json({ items, total });
  });
  app.get('/admin/intents', (c) => c.html(renderIntentsPage()));
  app.get('/admin/api/intents', async (c) => {
    const stateParam = c.req.query('state');
    const validStates = ['pending', 'paid', 'expired'] as const;
    const state = (validStates as readonly string[]).includes(stateParam ?? '')
      ? (stateParam as typeof validStates[number])
      : undefined;
    const { items, total } = await listIntents(c.env, {
      state,
      sid: c.req.query('sid') || undefined,
      targetAddress: c.req.query('target_address') || undefined,
      limit: 100,
    });
    return c.json({ items, total });
  });

  // JSON endpoints powering the dashboard (same Basic Auth gate).
  app.get('/admin/api/events', async (c) => {
    const limit = Number(c.req.query('limit') ?? '25');
    const offset = Number(c.req.query('offset') ?? '0');
    const sigParam = c.req.query('sig');
    const sid = c.req.query('sid') || undefined;
    const filter = {
      limit,
      offset,
      sid,
      signatureOk: sigParam === '' || sigParam === undefined
        ? undefined
        : sigParam === '1',
    };
    const { items, total } = await listMoneriumWebhookEvents(c.env, filter);
    // Lightweight stats: counts across the whole table, not just the page.
    const stats = await c.env.DB.prepare(
      `SELECT
         COUNT(*) AS total_all,
         SUM(CASE WHEN signature_ok = 1 THEN 1 ELSE 0 END) AS sig_ok_count,
         SUM(CASE WHEN signature_ok = 0 THEN 1 ELSE 0 END) AS sig_fail_count,
         COUNT(DISTINCT sid_extracted) AS distinct_sids
       FROM monerium_webhook_events`,
    ).first<{
      total_all: number;
      sig_ok_count: number;
      sig_fail_count: number;
      distinct_sids: number;
    }>();
    return c.json({
      items,
      total,
      total_all: stats?.total_all ?? 0,
      sig_ok_count: stats?.sig_ok_count ?? 0,
      sig_fail_count: stats?.sig_fail_count ?? 0,
      distinct_sids: stats?.distinct_sids ?? 0,
    });
  });
  app.get('/admin/api/orders', async (c) => {
    const orders = await listMoneriumOrders(c.env);
    return c.json({ orders });
  });

  // Self-custody wallet registry — Phase 3 (customer count) + Phase 4a
  // (phone binding via otp.domovina.ai). See [[reference-wallet-domovina]].
  app.get('/admin/wallets', (c) => c.html(renderWalletsPage()));
  app.get('/admin/api/wallets', async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 500);
    const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
    const phoneOnly = c.req.query('phone') === '1';
    const rows = await listWallets(c.env, { limit, offset });
    const counts = await countWallets(c.env);
    const filtered = phoneOnly ? rows.filter((r) => r.phone_hash !== null) : rows;
    const bindingsMap = await listPhoneBindingsForCredentials(
      c.env,
      filtered.map((r) => r.credential_id),
    );
    return c.json({
      total: counts.total,
      with_phone: counts.withPhone,
      limit,
      offset,
      rows: filtered.map((r) => ({
        ...publicWalletView(r),
        phones: (bindingsMap.get(r.credential_id) ?? []).map((b) => ({
          phone_hash_short: b.phone_hash.slice(0, 10) + '…' + b.phone_hash.slice(-6),
          first_bound_at: new Date(b.first_bound_at * 1000).toISOString(),
          latest_verified_at: new Date(b.latest_verified_at * 1000).toISOString(),
          verification_count: b.verification_count,
        })),
      })),
    });
  });

  // Sybil dashboard — phone hashes held by 2+ distinct wallets. Surfaces the
  // many-to-many wallet_phone_bindings duplicates that Phase 4a-fix made
  // queryable. Each row drills down to the wallets sharing that phone.
  app.get('/admin/sybil', (c) => c.html(renderSybilPage()));
  app.get('/admin/api/sybil', async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 500);
    const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
    const clusters = await listSybilClusters(c.env, { limit, offset });
    return c.json({ limit, offset, clusters });
  });
  // Tenant payout whitelist console + JSON API (ADR 0016). Inherits the same
  // Basic Auth gate as the rest of /admin/*.
  mountTenantAdmin(app);

  app.get('/admin/api/sybil/phone/:phoneHash', async (c) => {
    const phoneHash = c.req.param('phoneHash');
    if (!/^[0-9a-fA-F]{64}$/.test(phoneHash)) return c.json({ error: 'bad_phone_hash' }, 400);
    const wallets = await listWalletsSharingPhone(c.env, phoneHash);
    return c.json({ phone_hash: phoneHash, wallets });
  });
}
