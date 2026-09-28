import type { Env } from '../types';
import type { MoneriumOrder } from '../monerium/types';
import { isKnownPayer } from '../monerium/db';
import { extractRoutingFromOrder, extractSenderFromOrder, extractSessionId } from '../monerium/sid';
import { getCampaign } from '../tenants/db';
import { getIntent } from './db';
import { emitOrderLifecycleWebhook } from './outbound';

/// Tell the merchant what a Monerium issue order means right now:
/// `payment.received` as soon as Monerium holds the SEPA funds (~1 s after the
/// payer's bank sent them), `payment.rejected` if Monerium refuses it.
///
/// Only orders that correlate to something we issued — a known intent (sid) or
/// a registered campaign (cmp:) — produce an event; free-form SEPA transfers to
/// the IBAN have no merchant to tell. Idempotent through the outbox primary key
/// (rcv_/rej_<orderId>), so calling it for every sighting of an order is safe.
/// Never throws: it runs in waitUntil next to the money path.
export async function notifyOrderLifecycle(env: Env, order: MoneriumOrder): Promise<void> {
  if (order.kind !== 'issue') return;
  try {
    const routing = extractRoutingFromOrder(order);
    const sid = routing.sid ?? extractSessionId(order);
    const campaignId = routing.prefix === 'cmp' ? routing.campaignId : null;
    const intent = sid ? await getIntent(env, sid) : null;
    const campaign = !intent && campaignId ? await getCampaign(env, campaignId) : null;
    if (!intent && !campaign) return;
    const knownPayer = await isKnownPayer(env, extractSenderFromOrder(order).iban, order.id);
    await emitOrderLifecycleWebhook(env, order, {
      sid: intent?.sid ?? null,
      campaignId: campaign?.campaign_id ?? null,
      tenantId: intent?.tenant_id ?? campaign?.tenant_id ?? null,
      knownPayer,
    });
  } catch (e) {
    console.error(`notifyOrderLifecycle ${order.id}: ${(e as Error).message}`);
  }
}
