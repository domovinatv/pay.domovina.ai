import type { Env } from '../types';
import { sendAlert } from '../alerts';
import { notifyOrderLifecycle } from '../intents/lifecycle';
import { MoneriumClient } from './client';
import { getTenantRail, legacyRail, listRailTenantIds, type TenantRail } from '../tenants/rail';
import { getForwardByOrder, getMoneriumOrder, upsertMoneriumOrder } from './db';
import { makeForwardDeps, maybeForward } from './forward';
import { orderState, orderStateRank } from './orderState';
import type { MoneriumOrder } from './types';

/// Backstop for a MISSED Monerium webhook. Monerium retries a failed delivery
/// for ~12 h, but if every retry fails (or our endpoint was down) the order
/// would otherwise never reach D1: the payer's checkout sits on "waiting" and
/// the merchant never hears `payment.received`.
///
/// Pulls recent orders from the Monerium API and runs every NEW state through
/// the same persistence + merchant-notification path as the webhook.
///
/// A processed issue order with NO forward row at all after FORWARD_GRACE_S —
/// memo or not (SR-05: a stray whose order.updated was lost used to be
/// invisible) — is alerted, every STUCK_ALERT_REPEAT_S while younger than
/// STUCK_ALERT_MAX_AGE_S. With RECONCILE_FORWARDS=1 the reconcile instead runs
/// the normal forward path on it: the live-forward latch (migration 0016)
/// makes the INSERT the decision, so a webhook retry racing it cannot
/// double-forward (the reason this used to be alert-only, BW-02, is gone).

/// Only look at orders placed within this window.
const LOOKBACK_S = 7 * 86_400;
/// A processed order without a forward row is expected for a few seconds
/// (webhook → waitUntil forward); only alert once it is clearly stuck.
const FORWARD_GRACE_S = 15 * 60;
/// Re-alert a still-stuck order this often (KV dedup), but only this long.
const STUCK_ALERT_REPEAT_S = 6 * 3600;
const STUCK_ALERT_MAX_AGE_S = 48 * 3600;

export interface ReconcileResult {
  skipped: boolean;
  fetched: number;
  advanced: number;
  unforwarded: number;
}

/// Worth an API call only while something could still be in flight: a recent
/// pending intent, or an order stored in a non-terminal state. ITalk keeps the
/// historical rail-wide query; other tenants only look at their own rows.
async function somethingInFlight(env: Env, rail: TenantRail, nowUnix: number): Promise<boolean> {
  // SR-05: a processed issue order without any forward row is "in flight"
  // too — otherwise a quiet night (no pending intent) skips the very check
  // that would notice it.
  if (rail.legacy) {
    const row = await env.DB.prepare(
      `SELECT 1 AS hit WHERE
         EXISTS (SELECT 1 FROM payment_intents WHERE state = 'pending' AND created_at > ?1)
         OR EXISTS (SELECT 1 FROM monerium_orders WHERE state IN ('placed', 'pending'))
         OR EXISTS (SELECT 1 FROM monerium_orders o
                     WHERE o.kind = 'issue' AND o.state = 'processed' AND o.updated_at > ?2
                       AND (o.tenant_id IS NULL OR o.tenant_id = ?3)
                       AND NOT EXISTS (SELECT 1 FROM monerium_forwards f WHERE f.order_id = o.id))`,
    )
      .bind(nowUnix - 2 * 86_400, nowUnix - 86_400, rail.tenantId)
      .first<{ hit: number }>();
    return row !== null;
  }
  const row = await env.DB.prepare(
    `SELECT 1 AS hit WHERE
       EXISTS (SELECT 1 FROM payment_intents WHERE tenant_id = ?1 AND state = 'pending' AND created_at > ?2)
       OR EXISTS (SELECT 1 FROM monerium_orders WHERE tenant_id = ?1 AND state IN ('placed', 'pending'))
       OR EXISTS (SELECT 1 FROM monerium_orders o
                   WHERE o.tenant_id = ?1 AND o.kind = 'issue' AND o.state = 'processed' AND o.updated_at > ?3
                     AND NOT EXISTS (SELECT 1 FROM monerium_forwards f WHERE f.order_id = o.id))`,
  )
    .bind(rail.tenantId, nowUnix - 2 * 86_400, nowUnix - 86_400)
    .first<{ hit: number }>();
  return row !== null;
}

/// Reconcile ITalk (env rail) and then every other tenant with a rail, each
/// with its own Monerium client and profile (ADR 0017). One tenant failing
/// (expired credentials, Monerium 5xx) never stops the others.
export async function reconcileMoneriumOrders(env: Env, nowUnix: number): Promise<ReconcileResult> {
  let total: ReconcileResult = { skipped: true, fetched: 0, advanced: 0, unforwarded: 0 };
  let legacyError: unknown = null;
  try {
    total = await reconcileTenant(env, legacyRail(env), nowUnix);
  } catch (e) {
    legacyError = e;
  }
  for (const tenantId of await listRailTenantIds(env)) {
    const rail = await getTenantRail(env, tenantId);
    if (!rail) continue;
    try {
      const r = await reconcileTenant(env, rail, nowUnix);
      total.skipped = total.skipped && r.skipped;
      total.fetched += r.fetched;
      total.advanced += r.advanced;
      total.unforwarded += r.unforwarded;
    } catch (e) {
      console.error(`reconcile tenant ${tenantId} failed: ${(e as Error).message}`);
    }
  }
  // ITalk's failure still surfaces exactly as before (cron logs it), but only
  // after the other tenants had their turn.
  if (legacyError) throw legacyError;
  return total;
}

async function reconcileTenant(env: Env, rail: TenantRail, nowUnix: number): Promise<ReconcileResult> {
  const result: ReconcileResult = { skipped: false, fetched: 0, advanced: 0, unforwarded: 0 };
  if (!rail.monerium.clientId || !(await somethingInFlight(env, rail, nowUnix))) {
    return { ...result, skipped: true };
  }
  const orders = await new MoneriumClient(env, rail.monerium).listOrders();
  result.fetched = orders.length;
  for (const order of orders) {
    const placedAt = isoToUnix(order.meta?.placedAt);
    if (placedAt !== null && placedAt < nowUnix - LOOKBACK_S) continue;
    // Same profile rule as the per-tenant webhook: /orders?profile= should
    // only return this tenant's orders, but never trust that silently.
    if (!rail.legacy && order.profile !== rail.monerium.profileId) {
      console.error(`reconcile tenant ${rail.tenantId}: order ${order.id} has profile ${order.profile ?? '-'} — skipped`);
      continue;
    }
    const stored = await getMoneriumOrder(env, order.id);
    if (!stored || orderStateRank(orderState(order)) > orderStateRank(stored.state)) {
      if (await upsertMoneriumOrder(env, order, rail.tenantId)) {
        result.advanced++;
        console.log(`reconcile: order ${order.id} → ${orderState(order)} (webhook missed or late)`);
        await notifyOrderLifecycle(env, order, rail.tenantId);
      }
    }
    if (await isStuckWithoutForward(env, order, nowUnix)) {
      result.unforwarded++;
      if (env.RECONCILE_FORWARDS === '1') {
        // Same path as the webhook: gate, resolver, latch, alerts.
        console.log(`reconcile: order ${order.id} processed without forward — running forward path`);
        await maybeForward(makeForwardDeps(env, rail), order);
      } else if (await claimStuckAlert(env, order.id)) {
        await sendAlert(
          env,
          `⚠️ <b>Monerium order obrađen, a forward nije pokrenut</b>\n` +
            (rail.legacy ? '' : `tenant: <code>${rail.tenantId}</code>\n`) +
            `order: <code>${order.id}</code> · iznos: <b>${order.amount} EUR</b>\n` +
            `memo: <code>${(order.memo ?? '-').slice(0, 120)}</code>\n` +
            `Webhook order.updated vjerojatno nije stigao. EURe je u ${rail.legacy ? 'MPT Safeu' : 'prihvatnom Safeu tenanta'}; ` +
            `forward se ne pokreće automatski (RECONCILE_FORWARDS≠1) — preusmjeriti iz /admin/forwards ili riješiti ručno. ` +
            `Alarm se ponavlja svakih 6 h dok forward red ne postoji (najviše 48 h).`,
        );
      }
    }
  }
  return result;
}

export async function isStuckWithoutForward(env: Env, order: MoneriumOrder, nowUnix: number): Promise<boolean> {
  if (order.kind !== 'issue' || orderState(order) !== 'processed') return false;
  const processedAt = isoToUnix(order.meta?.processedAt);
  if (processedAt === null) return false;
  const age = nowUnix - processedAt;
  if (age < FORWARD_GRACE_S || age >= STUCK_ALERT_MAX_AGE_S) return false;
  // Any row — even a park — means the forward path ran and reported.
  return (await getForwardByOrder(env, order.id)) === null;
}

/// One alert per order per STUCK_ALERT_REPEAT_S. Without KV: alert (noisy
/// beats silent).
async function claimStuckAlert(env: Env, orderId: string): Promise<boolean> {
  const key = `stuckalert:${orderId}`;
  try {
    if (await env.TOKEN_CACHE.get(key)) return false;
    await env.TOKEN_CACHE.put(key, '1', { expirationTtl: STUCK_ALERT_REPEAT_S });
  } catch (e) {
    console.error(`stuck alert dedup: ${(e as Error).message}`);
  }
  return true;
}

/// The cron runs the reconcile every RECONCILE_INTERVAL_S (see index.ts).
export const RECONCILE_INTERVAL_S = 10 * 60;

function isoToUnix(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
