import type { Address } from 'viem';

import type { Env } from '../types';
import type { MoneriumOrder } from './types';
import { getForwardByOrder, insertForward, updateForward } from './db';
import { extractRoutingFromOrder, extractSenderFromOrder, type SenderInfo } from './sid';
import { forwardViaSafe, type ForwardArgs, type ForwardResult } from '../router/safe';
import {
  makeConfirmDeps,
  pollForwardConfirmation,
  settleNonRoutedPaid,
} from '../intents/confirm';
import { emitForwardBlockedWebhook } from '../intents/outbound';
import {
  authorizeForward,
  describeParkReason,
  makeAuthorizeDeps,
  type AuthorizeDeps,
  type ParkReason,
} from '../tenants/whitelist';
import { writeAudit } from '../tenants/db';
import { sendAlert } from '../alerts';

/// The forward hop: EURe that Monerium minted into the MPT Safe is pushed on
/// to the payee. Extracted out of index.ts so the fail-closed branches are
/// unit-testable — every external effect goes through `ForwardDeps`.
///
/// Authorisation lives entirely in `authorizeForward` (../tenants/whitelist.ts);
/// nothing here decides on its own that an address is acceptable.

export interface ForwardDeps {
  authorize: AuthorizeDeps;
  getForwardByOrder(orderId: string): Promise<{ status: string } | null>;
  insertForward(args: Parameters<typeof insertForward>[1]): Promise<number>;
  updateForward(id: number, patch: Parameters<typeof updateForward>[2]): Promise<void>;
  forward(args: ForwardArgs): Promise<ForwardResult>;
  settleNonRoutedPaid(args: {
    sid: string;
    orderId: string;
    forwardId: number;
    amountCents: number | null;
    sender: SenderInfo;
  }): Promise<boolean>;
  pollConfirmation(fwd: {
    id: number;
    order_id: string;
    sid: string | null;
    tx_hash: string;
    amount_cents: number | null;
    memo_prefix: string | null;
    target_address: string;
  }): Promise<'confirmed' | 'failed' | 'timeout'>;
  alert(text: string): Promise<void>;
  audit(entry: {
    tenantId: string | null;
    action: string;
    address?: string | null;
    actor: string;
    detail?: string | null;
  }): Promise<void>;
  emitBlocked(args: {
    reason: string;
    orderId: string;
    sid: string | null;
    campaignId: string | null;
    targetAddress: string | null;
    amountCents: number | null;
    tenantId: string | null;
  }): Promise<void>;
}

export function makeForwardDeps(env: Env): ForwardDeps {
  return {
    authorize: makeAuthorizeDeps(env),
    getForwardByOrder: (orderId) => getForwardByOrder(env, orderId),
    insertForward: (args) => insertForward(env, args),
    updateForward: (id, patch) => updateForward(env, id, patch),
    forward: (args) => forwardViaSafe(env, args),
    settleNonRoutedPaid: (args) => settleNonRoutedPaid(makeConfirmDeps(env), args),
    pollConfirmation: (fwd) => pollForwardConfirmation(makeConfirmDeps(env), fwd),
    alert: (text) => sendAlert(env, text),
    audit: (entry) => writeAudit(env, entry),
    emitBlocked: (args) => emitForwardBlockedWebhook(env, args),
  };
}

/// Convert Monerium's decimal-string amount ("12.34") to integer minor units.
export function parseAmountCents(amount: string | undefined | null): number | null {
  if (!amount) return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/// EURe has 18 decimals. Split on the decimal point and pad so no float math
/// touches a money value.
export function eurToWei(amount: string): bigint {
  const [whole, frac = ''] = amount.split('.');
  const fracPadded = (frac + '0'.repeat(18)).slice(0, 18);
  return BigInt(whole) * 10n ** 18n + BigInt(fracPadded || '0');
}

/// Forward-level idempotency guard, then the forward itself. Called inside
/// `executionCtx.waitUntil` so the webhook response is never blocked.
export async function maybeForward(
  deps: ForwardDeps,
  order: MoneriumOrder,
): Promise<void> {
  const existing = await deps.getForwardByOrder(order.id);
  if (existing && (existing.status === 'submitted' || existing.status === 'confirmed')) {
    console.log(`forward ${order.id} already ${existing.status}, skipping`);
    return;
  }
  await handleForward(deps, order);
}

export async function handleForward(
  deps: ForwardDeps,
  order: MoneriumOrder,
): Promise<void> {
  const routing = extractRoutingFromOrder(order);
  const sender = extractSenderFromOrder(order);
  const amountCents = parseAmountCents(order.amount);

  // ---- Single authorisation gate. No forward path bypasses this. ----
  const decision = await authorizeForward(deps.authorize, routing);

  if (decision.action === 'park') {
    await park(deps, {
      order,
      routing,
      amountCents,
      reason: decision.reason,
      tenantId: decision.tenantId,
    });
    return;
  }

  // Memo targets the Safe itself: nothing to transfer, the mint already landed
  // where it should. `state=processed` means that mint is on-chain confirmed,
  // so 'paid' keys off it directly.
  if (decision.action === 'self_noop') {
    const forwardId = await deps.insertForward({
      orderId: order.id,
      targetAddress: routing.target!,
      amountWei: '0',
      amountCents,
      sid: routing.sid,
      memoPrefix: routing.prefix,
      status: 'confirmed',
      error: 'self_target_noop',
    });
    if (routing.sid) {
      await deps.settleNonRoutedPaid({
        sid: routing.sid,
        orderId: order.id,
        forwardId,
        amountCents,
        sender,
      });
    }
    return;
  }

  // ---- Authorised: move the money. ----
  const target = routing.target!;
  const amountWei = eurToWei(order.amount ?? '0');
  const forwardId = await deps.insertForward({
    orderId: order.id,
    targetAddress: target,
    amountWei: amountWei.toString(),
    amountCents,
    sid: routing.sid,
    memoPrefix: routing.prefix,
    status: 'pending',
  });
  const result = await deps.forward({
    target: target as Address,
    amountWei,
    // When PAYMENT_REGISTRY_ADDRESS + MULTISEND_ADDRESS are set, the rail
    // batches `registry.record(...)` alongside the transfer so each forward
    // emits an onchain `Payment` event. Null → legacy single-transfer path.
    sessionId: routing.sid,
  });
  if (!result.ok) {
    await deps.updateForward(forwardId, {
      status: 'failed',
      error: result.error ?? 'unknown',
      attempts: 1,
    });
    console.error(`forward ${order.id} FAILED: ${result.error}`);
    return;
  }

  await deps.updateForward(forwardId, {
    status: 'submitted',
    tx_hash: result.txHash!,
    attempts: 1,
  });
  console.log(`forward ${order.id} → ${target} tx=${result.txHash}`);
  // 'paid' + the merchant/campaign webhooks fire on ON-CHAIN CONFIRMATION, not
  // on broadcast — a forward that later reverts must never have told the
  // merchant "plaćeno". If this poll is evicted, the cron reconcile and the
  // status read path are the backstops; all three settle through the same
  // atomic submitted → confirmed flip, so effects stay single-fire.
  const outcome = await deps.pollConfirmation({
    id: forwardId,
    order_id: order.id,
    sid: routing.sid,
    tx_hash: result.txHash!,
    amount_cents: amountCents,
    memo_prefix: routing.prefix,
    target_address: target,
  });
  if (outcome === 'timeout') {
    console.log(`forward ${order.id} unconfirmed after poll window — cron reconcile will settle`);
  } else if (outcome === 'failed') {
    console.error(`forward ${order.id} REVERTED on-chain tx=${result.txHash} — intent NOT paid, no webhook`);
  }
}

/// Fail-closed landing: record WHY we refused, alert, tell the merchant, and
/// leave the EURe in the Safe. Never throws — an alert or webhook failure must
/// not turn a refusal into an exception that some caller might retry blindly.
async function park(
  deps: ForwardDeps,
  args: {
    order: MoneriumOrder;
    routing: ReturnType<typeof extractRoutingFromOrder>;
    amountCents: number | null;
    reason: ParkReason;
    tenantId: string | null;
  },
): Promise<void> {
  const { order, routing, amountCents, reason, tenantId } = args;
  const observed = routing.target ?? routing.diagnosticTarget ?? '';

  // 'no_routing_target' keeps its historical status ('failed') because it
  // predates the whitelist and admin tooling already filters on it. Every
  // authorisation refusal gets the new 'blocked' status so an operator can
  // tell "we refused" apart from "the chain/RPC refused".
  const status = reason === 'no_routing_target' ? 'failed' : 'blocked';

  await deps.insertForward({
    orderId: order.id,
    targetAddress: observed,
    amountWei: '0',
    amountCents,
    sid: routing.sid,
    memoPrefix: routing.prefix,
    status,
    error: reason === 'no_routing_target' ? 'no_routing_target' : `not_whitelisted:${reason}`,
  });

  const amountEur = amountCents !== null ? (amountCents / 100).toFixed(2) : '?';
  console.warn(
    `forward ${order.id} BLOCKED (${reason}): memo="${order.memo ?? ''}" ` +
      `observed=${observed || '-'} tenant=${tenantId ?? '-'} amount=${amountEur} EUR`,
  );

  await safely(deps.audit({
    tenantId,
    action: 'forward.blocked',
    address: observed || null,
    actor: 'system',
    detail: JSON.stringify({
      order_id: order.id,
      reason,
      prefix: routing.prefix,
      sid: routing.sid,
      campaign_id: routing.campaignId,
      amount_cents: amountCents,
    }),
  }));

  await safely(deps.alert(
    `🛑 <b>MPT forward blokiran</b>\n` +
      `razlog: <code>${reason}</code> — ${describeParkReason(reason)}\n` +
      `order: <code>${order.id}</code>\n` +
      `iznos: <b>${amountEur} EUR</b> (ostaje u Safe-u)\n` +
      `adresa iz memo-a: <code>${observed || '-'}</code>\n` +
      `tenant: <code>${tenantId ?? '-'}</code> · prefix: <code>${routing.prefix ?? '-'}</code>`,
  ));

  // Only worth telling the merchant when there is something to correlate on.
  if (routing.sid || routing.campaignId) {
    await safely(deps.emitBlocked({
      reason,
      orderId: order.id,
      sid: routing.sid,
      campaignId: routing.campaignId,
      targetAddress: observed || null,
      amountCents,
      tenantId,
    }));
  }
}

async function safely(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (e) {
    console.error(`forward park side-effect failed: ${(e as Error).message}`);
  }
}
