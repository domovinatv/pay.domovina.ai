import type { Env } from '../types';
import type { MoneriumOrder, MoneriumWebhookEvent } from './types';
import { extractEventType, extractOrder, verifyWebhookSignature } from './webhook';
import {
  alreadyProcessedEvent,
  recordMoneriumWebhookEvent,
  releaseProcessedEvent,
  upsertMoneriumOrder,
} from './db';
import { extractSessionId } from './sid';
import { makeForwardDeps, maybeForward, parseAmountCents } from './forward';
import { notifyOrderLifecycle } from '../intents/lifecycle';
import { sendAlert } from '../alerts';
import type { TenantRail } from '../tenants/rail';

/// Inbound Monerium webhook, for ONE tenant's rail (ADR 0017). Extracted from
/// index.ts so the attribution and fail-closed branches are unit-testable;
/// the ITalk route and the per-tenant route `/api/monerium/webhook/t/:id`
/// both call this with the rail they resolved from the URL.
///
/// Attribution rule: the event belongs to the tenant whose URL received it,
/// and it is verified ONLY with that tenant's secret. We never try other
/// tenants' secrets — "whichever secret matches" would let one tenant's event
/// be processed as another's.

export interface WebhookRecord {
  orderId: string | null;
  eventType: string;
  signatureOk: boolean;
  payload: string;
  headersJson: string;
  sidExtracted: string | null;
  amountCents: number | null;
  currency: string | null;
  processingNote: string | null;
  tenantId: string;
}

export interface WebhookDeps {
  recordEvent(rec: WebhookRecord): Promise<void>;
  /// Atomic idempotency claim. True = this key was already processed.
  alreadyProcessed(key: string): Promise<boolean>;
  releaseProcessed(key: string): Promise<void>;
  upsertOrder(order: MoneriumOrder): Promise<boolean>;
  notifyLifecycle(order: MoneriumOrder): Promise<void>;
  forward(order: MoneriumOrder): Promise<void>;
  alert(text: string): Promise<void>;
  waitUntil(p: Promise<unknown>): void;
}

export function makeWebhookDeps(
  env: Env,
  rail: TenantRail,
  ctx: { waitUntil(p: Promise<unknown>): void },
): WebhookDeps {
  return {
    recordEvent: async (rec) => {
      await recordMoneriumWebhookEvent(env, rec);
    },
    alreadyProcessed: (key) => alreadyProcessedEvent(env, key),
    releaseProcessed: (key) => releaseProcessedEvent(env, key),
    upsertOrder: (order) => upsertMoneriumOrder(env, order, rail.tenantId),
    notifyLifecycle: (order) => notifyOrderLifecycle(env, order, rail.tenantId),
    forward: (order) => maybeForward(makeForwardDeps(env, rail), order),
    alert: (text) => sendAlert(env, text),
    waitUntil: (p) => ctx.waitUntil(p),
  };
}

export interface WebhookResponse {
  status: 200 | 401 | 500;
  body: Record<string, unknown>;
}

/// Idempotency key. ITalk keeps the bare webhook-id (unchanged rows in
/// monerium_processed_event_ids); other tenants are namespaced because a
/// webhook-id is unique per subscription, not across Monerium accounts.
export function dedupKey(rail: TenantRail, webhookId: string): string {
  return rail.legacy ? webhookId : `${rail.tenantId}:${webhookId}`;
}

/// For a non-legacy tenant the order must belong to the tenant's own Monerium
/// profile. A missing profile counts as a mismatch (fail-closed).
export function profileMismatch(rail: TenantRail, order: MoneriumOrder | null): boolean {
  if (rail.legacy || !order) return false;
  const expected = rail.monerium.profileId;
  return !expected || !order.profile || order.profile !== expected;
}

export async function handleMoneriumWebhook(
  deps: WebhookDeps,
  rail: TenantRail,
  rawBody: string,
  headers: Headers,
): Promise<WebhookResponse> {
  const verify = await verifyWebhookSignature(rawBody, headers, rail.webhookSecret);
  let event: MoneriumWebhookEvent | null = null;
  try {
    event = JSON.parse(rawBody) as MoneriumWebhookEvent;
  } catch {
    // Persist the raw payload anyway so we can debug malformed events.
  }
  const eventType = event ? extractEventType(event) : 'invalid_json';
  const order = event ? extractOrder(event) : null;
  const sid = extractSessionId(order);
  const amountCents = parseAmountCents(order?.amount);
  const headersObj: Record<string, string> = {};
  headers.forEach((v, k) => { headersObj[k] = v; });
  const wrongProfile = verify.ok && profileMismatch(rail, order);
  let processingNote: string | null = null;
  if (!verify.ok) processingNote = `signature_invalid: ${verify.reason}`;
  else if (eventType === 'subscription.created') processingNote = 'subscription_ack';
  else if (!order) processingNote = 'no_order_in_payload';
  else if (wrongProfile) processingNote = 'profile_mismatch';
  await deps.recordEvent({
    orderId: order?.id ?? null,
    eventType,
    signatureOk: verify.ok,
    payload: rawBody,
    headersJson: JSON.stringify(headersObj),
    sidExtracted: sid,
    amountCents,
    currency: order?.currency ?? null,
    processingNote,
    tenantId: rail.tenantId,
  });
  if (!verify.ok) {
    console.warn(
      `monerium webhook signature FAILED: ${verify.reason}\n` +
        (rail.legacy ? '' : `  tenant: ${rail.tenantId}\n`) +
        `  body[${rawBody.length}b]: ${rawBody.slice(0, 300)}\n` +
        `  debug: ${JSON.stringify(verify.debug, null, 2)}`,
    );
    return { status: 401, body: { error: 'invalid signature' } };
  }
  // Idempotency: skip re-processing if Monerium retried (up to 10× / 12h).
  const claimKey = verify.webhookId ? dedupKey(rail, verify.webhookId) : null;
  if (claimKey) {
    const seen = await deps.alreadyProcessed(claimKey);
    if (seen) {
      console.log(`monerium webhook ${verify.webhookId} already processed`);
      return { status: 200, body: { ok: true, dedup: true } };
    }
  }
  // `subscription.created` is sent once on registration — just return 200.
  if (eventType === 'subscription.created') {
    console.log(
      rail.legacy
        ? 'monerium subscription.created — webhook activated'
        : `monerium subscription.created — webhook activated for tenant ${rail.tenantId}`,
    );
    return { status: 200, body: { ok: true } };
  }
  if (order && wrongProfile) {
    // Signed with this tenant's secret, but the order is not on this tenant's
    // profile. Never attribute it: no upsert, no merchant event, no forward.
    // 200 so Monerium stops retrying — the raw event is already recorded.
    console.error(
      `monerium webhook tenant=${rail.tenantId} order ${order.id} profile=${order.profile ?? '-'} ` +
        `≠ ${rail.monerium.profileId ?? '-'} — IGNORED`,
    );
    await safely(deps.alert(
      `🛑 <b>Monerium order s krivim profilom</b>\n` +
        `tenant: <code>${rail.tenantId}</code> · order: <code>${order.id}</code>\n` +
        `profil u orderu: <code>${order.profile ?? '-'}</code> · očekivan: <code>${rail.monerium.profileId ?? '-'}</code>\n` +
        `Order NIJE upisan ni proslijeđen.`,
    ));
    return { status: 200, body: { ok: true, ignored: 'profile_mismatch' } };
  }
  if (order) {
    try {
      const applied = await deps.upsertOrder(order);
      if (!applied) {
        // Out-of-order retry (e.g. order.created after order.updated
        // processed): the stored order is already further along. Nothing to
        // do — acting on it would replay stale side effects.
        console.log(`monerium ${eventType} order ${order.id} state=${order.state ?? '?'} STALE — ignored`);
        return { status: 200, body: { ok: true, stale: true } };
      }
      console.log(`monerium ${eventType} order ${order.id} state=${order.state ?? '?'}`);
      // Merchant sees `payment.received` the moment Monerium holds the funds
      // (order.created, ~1 s) — the card-like "approved" moment — and
      // `payment.rejected` if Monerium refuses. Settlement (`intent.paid`)
      // still waits for the confirmed on-chain forward below.
      deps.waitUntil(deps.notifyLifecycle(order));
      // Auto-forward via Safe + Roles Modifier on incoming issue orders.
      //
      // Critical race-condition fix (2026-05-21): only forward AFTER Monerium
      // has actually executed the EURe mint TX on-chain. `order.created` fires
      // when Monerium receives the SEPA payment but BEFORE the mint reaches
      // chain — Safe has no EURe to forward, so `execTransactionWithRole`
      // reverts with `ModuleTransactionFailed()` at the inner `EURe.transfer`
      // call. `order.updated` with `state=processed` is the signal that the
      // mint TX is in `meta.txHashes` and the Safe balance is live.
      //
      // Idempotency: order.updated may fire more than once. The live-forward
      // latch on insertForward (migration 0016) lets exactly one through; a
      // prior `failed` forward is allowed to retry.
      if (
        order.kind === 'issue'
        && eventType === 'order.updated'
        && order.state === 'processed'
        && rail.signer.privateKey
      ) {
        deps.waitUntil(deps.forward(order));
      }
    } catch (e) {
      // Release the idempotency claim so Monerium's retry of this same
      // webhook-id gets processed instead of dropped as a duplicate (BW-03).
      if (claimKey) {
        await deps.releaseProcessed(claimKey).catch(() => {});
      }
      console.error(`monerium webhook processing failed for order ${order.id}: ${(e as Error).message}`);
      return { status: 500, body: { error: 'processing_failed' } };
    }
  }
  return { status: 200, body: { ok: true } };
}

async function safely(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (e) {
    console.error(`webhook side-effect failed: ${(e as Error).message}`);
  }
}
