import { decryptSecret, deriveSid } from './crypto';
import { getOrder, getOrderBySid, getShop, insertOrder, now, updateOrder } from './db';
import { createIntent, getIntent } from './mpt';
import {
  addOrderTags,
  cancelOrder,
  fetchOrder,
  markOrderPaid,
  moneyToCents,
  setPaymentMetafields,
} from './shopify';
import type { Env, MptIntent, OrderRow, OrderStatus, ShopRow } from './types';

/// Order tags the merchant can filter on in Shopify admin.
export const TAGS = {
  received: 'mpt-zaprimljeno',
  paid: 'mpt-placeno',
  underpaid: 'mpt-manjak',
  rejected: 'mpt-odbijeno',
  expired: 'mpt-isteklo',
  paidAfterCancel: 'mpt-placeno-nakon-otkazivanja',
} as const;

export type EnsureResult =
  | { kind: 'ok'; order: OrderRow }
  | { kind: 'skip'; reason: 'shop_not_active' | 'order_not_found' | 'not_mpt_gateway' | 'order_cancelled' | 'unsupported_currency' | 'nothing_due' };

export function isActive(shop: ShopRow | null): shop is ShopRow & { mpt_api_key_enc: string; target_address: string } {
  return !!shop && shop.active === 1 && !shop.uninstalled_at && !!shop.mpt_api_key_enc && !!shop.target_address;
}

export function gatewayMatches(names: string[], match: string): boolean {
  const needle = match.trim().toLowerCase();
  return needle.length > 0 && names.some((n) => n.toLowerCase().includes(needle));
}

/// The MPT intent for a Shopify order, created on first sight. Called from the
/// orders/create webhook AND from the Thank-you extension, whichever comes
/// first; both derive the same sid, so the loser gets 409 and reads the intent.
export async function ensureIntent(env: Env, shopDomain: string, orderGid: string): Promise<EnsureResult> {
  const existing = await getOrder(env, shopDomain, orderGid);
  if (existing) return { kind: 'ok', order: existing };

  const shop = await getShop(env, shopDomain);
  if (!isActive(shop)) return { kind: 'skip', reason: 'shop_not_active' };

  const order = await fetchOrder(env, shopDomain, orderGid);
  if (!order) return { kind: 'skip', reason: 'order_not_found' };
  if (!gatewayMatches(order.paymentGatewayNames, shop.gateway_match)) return { kind: 'skip', reason: 'not_mpt_gateway' };
  if (order.cancelledAt) return { kind: 'skip', reason: 'order_cancelled' };
  const due = order.totalOutstandingSet.shopMoney;
  if (due.currencyCode !== 'EUR') return { kind: 'skip', reason: 'unsupported_currency' };
  const cents = moneyToCents(due.amount);
  if (!cents || cents <= 0) return { kind: 'skip', reason: 'nothing_due' };

  const sid = await deriveSid(env.SID_SECRET, shopDomain, orderGid);
  const apiKey = await decryptSecret(env.TOKEN_KEK, shop.mpt_api_key_enc);
  let intent = await createIntent(env, apiKey, {
    sid,
    target_address: shop.target_address,
    amount_eur: (cents / 100).toFixed(2),
    label: `${shopDomain.replace('.myshopify.com', '')} ${order.name}`.slice(0, 120),
    expires_in_seconds: shop.intent_ttl_seconds,
    metadata: { source: 'shopify', shop: shopDomain, order_id: orderGid, order_name: order.name },
  });
  if (intent === 'exists') {
    const read = await getIntent(env, sid);
    if (!read) throw new Error('intent_conflict_but_missing');
    intent = read;
  }
  await insertOrder(env, {
    sid,
    shop: shopDomain,
    order_gid: orderGid,
    order_name: order.name,
    amount_cents: cents,
    intent_json: JSON.stringify(intent),
    expires_at: isoToUnix(intent.expires_at),
  });
  const row = await getOrderBySid(env, sid);
  if (!row) throw new Error('order_row_not_persisted');
  return { kind: 'ok', order: row };
}

const RECEIVED_STAGES = new Set(['received_processing', 'minted', 'forwarding', 'settled']);
const TERMINAL: ReadonlySet<OrderStatus> = new Set(['paid', 'underpaid', 'rejected', 'cancelled']);

/// Pure: what the intent says about the order right now. Settlement wins over
/// expiry — a late SEPA payment (`payment.late`) is still money in the Safe.
export function classifyIntent(intent: MptIntent, amountCents: number): OrderStatus {
  const got = intent.amount_received_cents;
  if (intent.paid_at) {
    return got !== null && got !== undefined && got < amountCents ? 'underpaid' : 'paid';
  }
  // BW-01: MPT records an underpayment without paid_at (the intent is not
  // paid) — settled money, so it wins over expiry like a late payment.
  if (
    intent.status?.amount_mismatch === 'under'
    || (intent.monerium_order_id && got !== null && got !== undefined && got < amountCents)
  ) {
    return 'underpaid';
  }
  const stage = intent.status?.stage;
  if (stage === 'rejected') return 'rejected';
  if (stage && RECEIVED_STAGES.has(stage)) return 'received';
  if (intent.state === 'expired') return 'expired';
  return 'pending';
}

/// Pure: the status to store. Terminal statuses never move, except that a
/// cancelled order can still learn it was paid (handled as a side effect).
export function nextStatus(current: OrderStatus, observed: OrderStatus): OrderStatus {
  if (TERMINAL.has(current)) return current;
  if (current === 'received' && (observed === 'pending' || observed === 'expired')) return current;
  return observed;
}

/// Bring our row and the Shopify order in line with the intent. Idempotent:
/// safe to call from the MPT webhook, the cron and the extension concurrently.
export async function applyIntent(env: Env, row: OrderRow, intent: MptIntent): Promise<OrderRow> {
  const observed = classifyIntent(intent, row.amount_cents);
  const status = nextStatus(row.status, observed);
  const ts = now();
  await updateOrder(env, row.sid, {
    status,
    intent_json: JSON.stringify(intent),
    paid_at: intent.paid_at ? isoToUnix(intent.paid_at) : row.paid_at,
    forward_tx_hash: intent.forward_tx_hash ?? row.forward_tx_hash,
    amount_received_cents: intent.amount_received_cents ?? row.amount_received_cents,
    last_polled_at: ts,
  });
  const updated = { ...row, status, intent_json: JSON.stringify(intent), forward_tx_hash: intent.forward_tx_hash ?? row.forward_tx_hash };

  try {
    if (status === 'received' && row.status !== 'received') {
      await addOrderTags(env, row.shop, row.order_gid, [TAGS.received]);
    }
    if (row.status === 'cancelled' && (observed === 'paid' || observed === 'underpaid') && !row.paid_at) {
      await addOrderTags(env, row.shop, row.order_gid, [TAGS.paidAfterCancel]);
      await updateOrder(env, row.sid, { last_error: 'paid_after_cancel: refund or reinstate manually' });
    }
    // Sync once per final status: an `expired` order that later settles
    // (payment.late) changes status and must be synced again as `paid`.
    if (TERMINAL_OR_EXPIRED.has(status) && (row.shopify_synced_at === null || status !== row.status)) {
      const finalStatus = await syncFinalToShopify(env, updated, intent, status);
      await updateOrder(env, row.sid, { status: finalStatus, shopify_synced_at: now(), last_error: null });
      return { ...updated, status: finalStatus, shopify_synced_at: now() };
    }
  } catch (e) {
    // Leave shopify_synced_at NULL — the cron retries on its next tick.
    await updateOrder(env, row.sid, { last_error: String((e as Error).message ?? e).slice(0, 500) });
  }
  return updated;
}

const TERMINAL_OR_EXPIRED: ReadonlySet<OrderStatus> = new Set(['paid', 'underpaid', 'rejected', 'expired']);

async function syncFinalToShopify(env: Env, row: OrderRow, intent: MptIntent, status: OrderStatus): Promise<OrderStatus> {
  const meta = { sid: row.sid, txHash: intent.forward_tx_hash, receivedCents: intent.amount_received_cents };
  switch (status) {
    case 'paid': {
      const order = await fetchOrder(env, row.shop, row.order_gid);
      if (order?.cancelledAt) {
        await addOrderTags(env, row.shop, row.order_gid, [TAGS.paidAfterCancel]);
      } else if (order?.canMarkAsPaid) {
        await markOrderPaid(env, row.shop, row.order_gid);
      }
      await setPaymentMetafields(env, row.shop, row.order_gid, meta);
      await addOrderTags(env, row.shop, row.order_gid, [TAGS.paid]);
      return 'paid';
    }
    case 'underpaid':
      // Never mark paid on less money than the order total (review BW-01).
      await setPaymentMetafields(env, row.shop, row.order_gid, meta);
      await addOrderTags(env, row.shop, row.order_gid, [TAGS.underpaid]);
      return 'underpaid';
    case 'rejected':
      await addOrderTags(env, row.shop, row.order_gid, [TAGS.rejected]);
      return 'rejected';
    case 'expired': {
      const shop = await getShop(env, row.shop);
      if (shop?.auto_cancel === 1) {
        await cancelOrder(env, row.shop, row.order_gid, `MPT: QR plaćanje isteklo (sid ${row.sid})`);
        return 'cancelled';
      }
      await addOrderTags(env, row.shop, row.order_gid, [TAGS.expired]);
      return 'expired';
    }
    default:
      return status;
  }
}

/// Re-read the intent from the MPT backend and apply it.
export async function refreshOrder(env: Env, row: OrderRow): Promise<OrderRow> {
  const intent = await getIntent(env, row.sid);
  if (!intent) {
    await updateOrder(env, row.sid, { last_polled_at: now(), last_error: 'intent_not_found' });
    return row;
  }
  return applyIntent(env, row, intent);
}

function isoToUnix(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}
