import { Hono } from 'hono';

import type { Env } from '../types';
import { resendWebhook } from '../intents/outbox';
import {
  getMoneriumWebhookEvent,
  listForwards,
  listMoneriumOrders,
  listMoneriumWebhookEvents,
  getMoneriumOrder,
  getForwardById,
  getForwardByOrder,
} from '../monerium/db';
import { listIntents, listRerouteCandidates } from '../intents/db';
import { checkReroute, eurToWei, handleForward, makeForwardDeps, maybeForward } from '../monerium/forward';
import { STRAY_LOOKBACK_SECONDS } from '../monerium/strayResolver';
import type { MoneriumOrder } from '../monerium/types';
import { getTenantRail, isLegacyTenant, legacyRail, type TenantRail } from '../tenants/rail';
import { defaultTenantId } from '../tenants/whitelist';
import { writeAudit } from '../tenants/db';
import { getIntent, isTrustedTarget } from '../intents/db';
import { getForwardStatus } from '../router/safe';
import {
  countWallets,
  listPhoneBindingsForCredentials,
  listSybilClusters,
  listWallets,
  listWalletsSharingPhone,
} from '../wallets/db';
import { publicWalletView } from '../wallets/api';
import { mountTenantAdmin } from '../tenants/admin';
import { actorOf, mountAdminAuth } from './auth/mount';
import { loadTenantTags, tenantWhere } from './tenantTags';
import { buildHpbOps, buildMoneriumOps } from './opsRoutes';
import { listOffRailLegs, makeOffRailDeps, markResolvedOffRail } from '../monerium/offrail';
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
/// Auth: Cloudflare Access (OTP na e-mail, /admin/sso) ili passkey → sesija u
/// kolačiću (./auth/mount.ts, isti model kao bank-push-gateway). Sve pod
/// /admin, uključujući /admin/api/*, traži tu sesiju; promjene traže i isti
/// Origin. Dashboard fetch() pozivi nose kolačić same-origin.
export function mountAdminUi(
  app: Hono<{ Bindings: Env }>,
  ops: { refreshAllAccounts(env: Env): Promise<number> } = { refreshAllAccounts: async () => 0 },
): void {
  mountAdminAuth(app);
  // AD-02: HPB connect + Monerium admin under the admin session (CSRF, audit
  // with the session e-mail) instead of a shared static bearer token.
  app.route('/admin/api/hpb', buildHpbOps({ actor: actorOf, refreshAllAccounts: ops.refreshAllAccounts }));
  app.route('/admin/api/monerium', buildMoneriumOps({ actor: actorOf }));
  app.get('/admin', (c) => c.html(renderEventsPage()));
  app.get('/admin/', (c) => c.html(renderEventsPage()));
  app.get('/admin/events/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.text('bad id', 400);
    const ev = await getMoneriumWebhookEvent(c.env, id);
    if (!ev) return c.text('event not found', 404);
    const tags = await loadTenantTags(c.env);
    return c.html(renderEventDetailPage(ev, tags.resolve(ev.tenant_id)));
  });
  app.get('/admin/orders', (c) => c.html(renderOrdersPage()));
  app.get('/admin/orders/:id', async (c) => {
    const order = await getMoneriumOrder(c.env, c.req.param('id'));
    if (!order) return c.text('order not found', 404);
    const tags = await loadTenantTags(c.env);
    return c.html(renderOrderDetailPage(order, tags.resolve(order.tenant_id)));
  });
  // Tenant + Monerium environment list for the header strip and the tenant
  // selectors on every admin tab. Display only.
  app.get('/admin/api/tenant-tags', async (c) => {
    const tags = await loadTenantTags(c.env);
    return c.json({ default_tenant_id: tags.defaultId, tenants: tags.list });
  });
  app.get('/admin/forwards', (c) => c.html(renderForwardsPage()));
  app.get('/admin/api/forwards', async (c) => {
    const status = c.req.query('status') || undefined;
    const tags = await loadTenantTags(c.env);
    const tenant = c.req.query('tenant') || undefined;
    const { items, total } = await listForwards(c.env, {
      status,
      tenant: tenant ? tenantWhere(tenant, tags.defaultId) : undefined,
      limit: 100,
    });
    return c.json({
      items: items.map((it) => ({ ...it, ...tags.resolve(it.tenant_id) })),
      total,
      tenants: tags.list,
    });
  });
  // Parked payment → intent (stray resolver, operator side). The picker lists
  // the order tenant's unsettled intents around the payment time; the POST
  // re-runs the normal forward path with the chosen sid, so the whitelist /
  // tenant / cap gate decides exactly as for a memo-carried payment.
  app.get('/admin/api/orders/:id/reroute-candidates', async (c) => {
    const loaded = await loadParkedOrder(c.env, c.req.param('id'));
    if ('error' in loaded) return c.json({ error: loaded.error }, 404);
    const { order, row } = loaded;
    const placed = row.placed_at ? Math.floor(Date.parse(row.placed_at) / 1000) : Math.floor(Date.now() / 1000);
    const amountCents = Math.round(Number(row.amount) * 100);
    const items = await listRerouteCandidates(c.env, {
      tenantId: loaded.tenantId,
      defaultTenantId: defaultTenantId(c.env),
      amountCents,
      createdFrom: placed - STRAY_LOOKBACK_SECONDS,
      createdTo: placed + 3600,
    });
    return c.json({ order_id: order.id, amount_cents: amountCents, placed_at: row.placed_at, items });
  });
  app.post('/admin/api/orders/:id/reroute', async (c) => {
    type Body = { sid?: string; force?: boolean; reason?: string };
    const body = await c.req.json<Body>().catch(() => ({} as Body));
    const sid = (body.sid ?? '').trim();
    if (!sid) return c.json({ error: 'sid_required' }, 400);
    const force = body.force === true;
    const reason = (body.reason ?? '').trim();
    // A different amount is a deliberate operator decision, written down.
    if (force && reason.length < 10) return c.json({ error: 'reason_required' }, 400);
    const loaded = await loadParkedOrder(c.env, c.req.param('id'));
    if ('error' in loaded) return c.json({ error: loaded.error }, 404);
    const deps = makeForwardDeps(c.env, loaded.rail);
    const refusal = await checkReroute(deps, loaded.order, sid, { force });
    if (refusal) return c.json({ error: refusal }, 409);
    const intent = await getIntent(c.env, sid);
    // SR-01: a destination anyone could have opened an intent to (wallet Safe
    // off the static whitelist, no secret key) needs the same written reason.
    if (!force && intent && intent.created_with_key !== 1
        && !(await isTrustedTarget(c.env, loaded.tenantId, intent.target_address))) {
      return c.json({ error: 'untrusted_target' }, 409);
    }
    await writeAudit(c.env, {
      tenantId: loaded.tenantId,
      action: 'forward.reroute',
      address: intent?.target_address ?? null,
      actor: actorOf(c),
      detail: JSON.stringify({
        order_id: loaded.order.id,
        sid,
        order_amount: loaded.row.amount,
        intent_amount_cents: intent?.amount_cents ?? null,
        force,
        reason: reason || null,
      }),
    });
    // The forward polls for confirmation (~75 s) — don't hold the request.
    c.executionCtx.waitUntil(handleForward(deps, loaded.order, { sid }));
    return c.json({ accepted: true, order_id: loaded.order.id, sid }, 202);
  });
  // Retry a forward whose BROADCAST failed (RPC down, gas, nonce) — MT-10 /
  // prethodni P0-6. Same path as the webhook; the live-forward latch (0016)
  // makes two concurrent retries broadcast once. A `blocked` (policy) row is
  // not retried here — that is what reroute is for.
  app.post('/admin/api/forwards/:id/retry', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'bad_id' }, 400);
    const row = await getForwardById(c.env, id);
    if (!row) return c.json({ error: 'forward_not_found' }, 404);
    if (row.status !== 'failed') return c.json({ error: 'not_failed', status: row.status }, 409);
    // A `failed` row WITH a tx hash (revert, or dropped from the mempool):
    // make sure that tx is not mined or pending after all — a second
    // broadcast would then pay twice. RPC trouble ('unknown') refuses too.
    if (row.tx_hash) {
      const st = await getForwardStatus(c.env, row.tx_hash as `0x${string}`, row.tenant_id);
      if (st !== 'failed' && st !== 'dropped') return c.json({ error: 'tx_still_live', tx_status: st }, 409);
    }
    const latest = await getForwardByOrder(c.env, row.order_id);
    if (latest && latest.id !== row.id) return c.json({ error: 'superseded', latest_id: latest.id, latest_status: latest.status }, 409);
    const loaded = await loadParkedOrder(c.env, row.order_id);
    if ('error' in loaded) return c.json({ error: loaded.error }, 404);
    const deps = makeForwardDeps(c.env, loaded.rail);
    await writeAudit(c.env, {
      tenantId: loaded.tenantId,
      action: 'forward.retry',
      address: row.target_address,
      actor: actorOf(c),
      detail: JSON.stringify({ forward_id: row.id, order_id: row.order_id, sid: row.sid, previous_error: row.error }),
    });
    // An operator's earlier pick stays the pick; everything else re-runs the
    // normal decision (memo, or the resolver for a stray).
    const run = row.memo_prefix === 'manual' && row.sid
      ? handleForward(deps, loaded.order, { sid: row.sid })
      : maybeForward(deps, loaded.order);
    c.executionCtx.waitUntil(run);
    return c.json({ accepted: true, forward_id: row.id, order_id: row.order_id }, 202);
  });
  // Parked order whose money was moved by hand outside the rail (2/3 owners).
  // The tx is verified on-chain; afterwards the order can never be rerouted.
  // OF-01: the EURe legs of a manual tx, so the operator picks the one that
  // paid THIS order (a 2/3 batch may pay out several).
  app.get('/admin/api/orders/:id/offrail-legs', async (c) => {
    const loaded = await loadParkedOrder(c.env, c.req.param('id'));
    if ('error' in loaded) return c.json({ error: loaded.error }, 404);
    const legs = await listOffRailLegs(makeOffRailDeps(c.env, loaded.rail), c.req.query('tx') ?? '');
    if (legs === null) return c.json({ error: 'tx_not_found_or_failed' }, 404);
    return c.json({
      order_id: loaded.order.id,
      order_amount_wei: eurToWei(loaded.order.amount ?? '0').toString(),
      legs,
    });
  });
  app.post('/admin/api/orders/:id/resolved-offrail', async (c) => {
    type Body = { tx_hash?: string; log_index?: number; force?: boolean; reason?: string };
    const body = await c.req.json<Body>().catch(() => ({} as Body));
    const force = body.force === true;
    const reason = (body.reason ?? '').trim();
    if (force && reason.length < 10) return c.json({ error: 'reason_required' }, 400);
    if (body.log_index !== undefined && !Number.isInteger(body.log_index)) return c.json({ error: 'bad_log_index' }, 400);
    const loaded = await loadParkedOrder(c.env, c.req.param('id'));
    if ('error' in loaded) return c.json({ error: loaded.error }, 404);
    const actor = actorOf(c);
    const r = await markResolvedOffRail(makeOffRailDeps(c.env, loaded.rail), loaded.order, body.tx_hash ?? '', actor, {
      logIndex: body.log_index,
      force,
      reason: reason || undefined,
    });
    return r.ok ? c.json(r) : c.json(r, r.error === 'bad_tx_hash' ? 400 : 409);
  });
  // Outbound merchant webhook outbox (migration 0015).
  app.get('/admin/api/outbox', async (c) => {
    const status = c.req.query('status');
    const tags = await loadTenantTags(c.env);
    const tenant = c.req.query('tenant') || undefined;
    const where: string[] = [];
    const args: unknown[] = [];
    if (status) { where.push('status = ?'); args.push(status); }
    if (tenant) { const w = tenantWhere(tenant, tags.defaultId); where.push(w.sql); args.push(...w.args); }
    const res = await c.env.DB.prepare(
      `SELECT id, type, tenant_id, status, attempts, next_attempt_at, last_status,
              last_error, created_at, delivered_at
         FROM webhook_outbox
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC LIMIT 200`,
    ).bind(...args).all<{ tenant_id: string | null }>();
    return c.json({
      items: res.results.map((it) => ({ ...it, ...tags.resolve(it.tenant_id) })),
      tenants: tags.list,
    });
  });
  app.post('/admin/api/outbox/:id/resend', async (c) => {
    const r = await resendWebhook(c.env, c.req.param('id'));
    return c.json({ result: r }, r === 'not_found' ? 404 : 200);
  });
  app.get('/admin/intents', (c) => c.html(renderIntentsPage()));
  app.get('/admin/api/intents', async (c) => {
    const stateParam = c.req.query('state');
    const validStates = ['pending', 'paid', 'expired'] as const;
    const state = (validStates as readonly string[]).includes(stateParam ?? '')
      ? (stateParam as typeof validStates[number])
      : undefined;
    const tags = await loadTenantTags(c.env);
    const tenant = c.req.query('tenant') || undefined;
    const { items, total } = await listIntents(c.env, {
      state,
      sid: c.req.query('sid') || undefined,
      targetAddress: c.req.query('target_address') || undefined,
      tenant: tenant ? tenantWhere(tenant, tags.defaultId) : undefined,
      limit: 100,
    });
    return c.json({
      items: items.map((it) => ({ ...it, ...tags.resolve(it.tenant_id) })),
      total,
      tenants: tags.list,
    });
  });

  // JSON endpoints powering the dashboard (same Basic Auth gate).
  app.get('/admin/api/events', async (c) => {
    const limit = Number(c.req.query('limit') ?? '25');
    const offset = Number(c.req.query('offset') ?? '0');
    const sigParam = c.req.query('sig');
    const sid = c.req.query('sid') || undefined;
    const tags = await loadTenantTags(c.env);
    const tenant = c.req.query('tenant') || undefined;
    const filter = {
      tenant: tenant ? tenantWhere(tenant, tags.defaultId) : undefined,
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
      items: items.map((it) => ({ ...it, ...tags.resolve(it.tenant_id) })),
      total,
      tenants: tags.list,
      total_all: stats?.total_all ?? 0,
      sig_ok_count: stats?.sig_ok_count ?? 0,
      sig_fail_count: stats?.sig_fail_count ?? 0,
      distinct_sids: stats?.distinct_sids ?? 0,
    });
  });
  app.get('/admin/api/orders', async (c) => {
    const tags = await loadTenantTags(c.env);
    const tenant = c.req.query('tenant') || undefined;
    const orders = await listMoneriumOrders(c.env, 100, tenant ? tenantWhere(tenant, tags.defaultId) : undefined);
    return c.json({
      // Order's own `chain` (from Monerium) wins over the tenant's rail chain.
      orders: orders.map((o) => { const t = tags.resolve(o.tenant_id); return { ...t, ...o, tenant_id: t.tenant_id }; }),
      tenants: tags.list,
    });
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

async function loadParkedOrder(
  env: Env,
  orderId: string,
): Promise<
  | { order: MoneriumOrder; row: NonNullable<Awaited<ReturnType<typeof getMoneriumOrder>>>; rail: TenantRail; tenantId: string }
  | { error: string }
> {
  const row = await getMoneriumOrder(env, orderId);
  if (!row) return { error: 'order_not_found' };
  const tenantId = row.tenant_id ?? defaultTenantId(env);
  const rail = isLegacyTenant(env, tenantId) ? legacyRail(env) : await getTenantRail(env, tenantId);
  if (!rail) return { error: 'tenant_rail_not_found' };
  let order: MoneriumOrder;
  try {
    order = JSON.parse(row.raw_json) as MoneriumOrder;
  } catch {
    return { error: 'order_raw_json_unparseable' };
  }
  return { order, row, rail, tenantId };
}
