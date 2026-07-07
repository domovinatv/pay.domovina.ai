import type { Hex } from 'viem';

import type { Env } from '../types';
import type { MoneriumForwardRow, MoneriumOrderRow } from '../monerium/db';
import {
  confirmForwardOnce,
  getMoneriumOrder,
  listSubmittedForwardsOlderThan,
  updateForward,
} from '../monerium/db';
import { getForwardStatus } from '../router/safe';
import { parseCampaignIdFromText, type SenderInfo } from '../monerium/sid';
import type { PaymentIntentRow } from './db';
import { getIntent, markIntentPaid } from './db';
import { emitCampaignContributionWebhook, emitIntentPaidWebhook } from './outbound';

/// Settlement of a forward = the moment "plaćeno" becomes TRUE: the forward
/// TX is CONFIRMED on-chain, not merely broadcast. A broadcast can still
/// revert — the merchant must never hear "paid" for money that bounced back
/// into the MPT Safe. Three independent paths can observe the receipt first:
///
///   1. primary  — handleForward's waitUntil poll right after broadcast
///   2. backstop — cron reconcile over stale `submitted` forwards
///                 (covers Worker eviction before the primary poll finishes)
///   3. tertiary — the status read path (confirmForwardIfMined in stage.ts)
///
/// All three funnel into `settleConfirmedForward`, whose atomic
/// `submitted → confirmed` flip (confirmForwardOnce) guarantees the paid
/// flip + merchant/campaign webhooks fire from exactly ONE winner.
///
/// Everything here is dependency-injected (ConfirmDeps) so the settlement
/// logic is unit-testable without D1/RPC — same philosophy as computeStage.

/// The forward fields settlement needs. Full MoneriumForwardRow satisfies it.
export type SettleableForward = Pick<
  MoneriumForwardRow,
  'id' | 'order_id' | 'sid' | 'tx_hash' | 'amount_cents' | 'memo_prefix' | 'target_address'
>;

export interface ConfirmDeps {
  getForwardStatus(txHash: Hex): Promise<'pending' | 'confirmed' | 'failed' | 'unknown'>;
  /// Atomic `submitted → confirmed` flip; true only for the caller that won.
  confirmForwardOnce(forwardId: number): Promise<boolean>;
  markForwardFailed(forwardId: number, error: string): Promise<void>;
  getOrder(orderId: string): Promise<MoneriumOrderRow | null>;
  getIntent(sid: string): Promise<PaymentIntentRow | null>;
  markIntentPaid(
    sid: string,
    args: {
      moneriumOrderId: string;
      forwardId: number;
      forwardTxHash: string | null;
      amountReceivedCents: number | null;
    },
  ): Promise<boolean>;
  emitIntentPaid(intent: PaymentIntentRow, sender: SenderInfo): Promise<void>;
  emitCampaignContribution(args: {
    campaignId: string;
    orderId: string;
    amountCents: number | null;
    currency: string;
    targetAddress: string;
    forwardTxHash: string | null;
    senderIban?: string | null;
    senderName?: string | null;
  }): Promise<void>;
  listSubmittedForwards(olderThanUnix: number): Promise<MoneriumForwardRow[]>;
  sleep(ms: number): Promise<void>;
}

export function makeConfirmDeps(env: Env): ConfirmDeps {
  return {
    getForwardStatus: (txHash) => getForwardStatus(env, txHash),
    confirmForwardOnce: (id) => confirmForwardOnce(env, id),
    markForwardFailed: (id, error) => updateForward(env, id, { status: 'failed', error }),
    getOrder: (orderId) => getMoneriumOrder(env, orderId),
    getIntent: (sid) => getIntent(env, sid),
    markIntentPaid: (sid, args) => markIntentPaid(env, sid, args),
    emitIntentPaid: (intent, sender) => emitIntentPaidWebhook(env, intent, sender),
    emitCampaignContribution: (args) => emitCampaignContributionWebhook(env, args),
    listSubmittedForwards: (olderThan) => listSubmittedForwardsOlderThan(env, olderThan),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/// Post-broadcast receipt-poll schedule (~75 s total). Gnosis blocks land
/// every ~5 s, so the front-loaded checks catch the common case; the tail —
/// and any waitUntil eviction mid-poll — is covered by the cron reconcile.
export const CONFIRM_POLL_DELAYS_MS = [5_000, 5_000, 5_000, 10_000, 15_000, 15_000, 20_000];

/// Cron reconcile only touches `submitted` forwards at least this old, so it
/// doesn't burn RPC calls racing a primary poll that is still running.
export const RECONCILE_MIN_AGE_SECONDS = 60;

/// Settle a forward whose TX was observed CONFIRMED on-chain. Returns true
/// when this call won the atomic flip and fired the effects; false when
/// another path already settled it (or the row was never `submitted`, e.g.
/// a self_target_noop inserted directly as confirmed).
export async function settleConfirmedForward(
  deps: ConfirmDeps,
  fwd: SettleableForward,
): Promise<boolean> {
  const won = await deps.confirmForwardOnce(fwd.id);
  if (!won) return false;
  const order = await deps.getOrder(fwd.order_id);
  const sender: SenderInfo = {
    iban: order?.counterpart_iban ?? null,
    name: order?.counterpart_name ?? null,
  };
  if (fwd.sid) {
    await flipPaidAndNotify(deps, {
      sid: fwd.sid,
      orderId: fwd.order_id,
      forwardId: fwd.id,
      forwardTxHash: fwd.tx_hash,
      amountCents: fwd.amount_cents,
      sender,
    });
  }
  // Permanent campaign QR (`cmp:`): one contribution per Monerium order.
  // Single-fire now rests on the atomic flip above (previously on
  // maybeForward reaching broadcast once); the receiver additionally dedups
  // on the order-scoped webhook-id.
  if (fwd.memo_prefix === 'cmp') {
    const campaignId =
      parseCampaignIdFromText(order?.memo ?? null)
      ?? parseCampaignIdFromText(order?.reference_number ?? null);
    if (campaignId) {
      await deps.emitCampaignContribution({
        campaignId,
        orderId: fwd.order_id,
        amountCents: fwd.amount_cents,
        currency: order?.currency ?? 'eur',
        targetAddress: fwd.target_address,
        forwardTxHash: fwd.tx_hash,
        senderIban: sender.iban,
        senderName: sender.name,
      });
    }
  }
  return true;
}

/// Non-routed rail (self-target noop): there is no forward hop to await —
/// the Monerium mint behind `state=processed` is already confirmed on-chain,
/// so 'paid' keys off that instead. Single-fire via markIntentPaid's
/// pending→paid guard.
export async function settleNonRoutedPaid(
  deps: ConfirmDeps,
  args: {
    sid: string;
    orderId: string;
    forwardId: number;
    amountCents: number | null;
    sender: SenderInfo;
  },
): Promise<boolean> {
  return flipPaidAndNotify(deps, { ...args, forwardTxHash: null });
}

/// Primary confirmation path: poll the receipt right after broadcast, inside
/// the same waitUntil that ran the forward. Returns what happened so the
/// caller can log it; 'timeout' leaves the row `submitted` for the cron.
export async function pollForwardConfirmation(
  deps: ConfirmDeps,
  fwd: SettleableForward,
): Promise<'confirmed' | 'failed' | 'timeout'> {
  if (!fwd.tx_hash) return 'timeout';
  for (const delayMs of CONFIRM_POLL_DELAYS_MS) {
    await deps.sleep(delayMs);
    const status = await deps.getForwardStatus(fwd.tx_hash as Hex);
    if (status === 'confirmed') {
      await settleConfirmedForward(deps, fwd);
      return 'confirmed';
    }
    if (status === 'failed') {
      // Reverted on-chain: funds bounced back into the MPT Safe. NO paid
      // flip, NO merchant webhook (opcija A — no reversal webhook either).
      await deps.markForwardFailed(fwd.id, 'onchain_revert');
      return 'failed';
    }
    // 'pending' / 'unknown' → keep polling.
  }
  return 'timeout';
}

/// Cron backstop: reconcile every stale `submitted` forward against chain.
/// Idempotent and cheap on an empty set.
export async function reconcileSubmittedForwards(
  deps: ConfirmDeps,
  nowUnix: number,
): Promise<{ checked: number; confirmed: number; failed: number }> {
  const rows = await deps.listSubmittedForwards(nowUnix - RECONCILE_MIN_AGE_SECONDS);
  let confirmed = 0;
  let failed = 0;
  for (const fwd of rows) {
    if (!fwd.tx_hash) continue;
    const status = await deps.getForwardStatus(fwd.tx_hash as Hex);
    if (status === 'confirmed') {
      if (await settleConfirmedForward(deps, fwd)) confirmed++;
    } else if (status === 'failed') {
      await deps.markForwardFailed(fwd.id, 'onchain_revert');
      failed++;
    }
  }
  return { checked: rows.length, confirmed, failed };
}

async function flipPaidAndNotify(
  deps: ConfirmDeps,
  args: {
    sid: string;
    orderId: string;
    forwardId: number;
    forwardTxHash: string | null;
    amountCents: number | null;
    sender: SenderInfo;
  },
): Promise<boolean> {
  const flipped = await deps.markIntentPaid(args.sid, {
    moneriumOrderId: args.orderId,
    forwardId: args.forwardId,
    forwardTxHash: args.forwardTxHash,
    amountReceivedCents: args.amountCents,
  });
  // Merchant webhook rides the pending→paid flip: markIntentPaid is an
  // atomic conditional UPDATE, so at most one caller ever sees flipped=true
  // — late SEPA after expiry (state='expired') never resurrects to paid.
  if (flipped) {
    const intent = await deps.getIntent(args.sid);
    if (intent) await deps.emitIntentPaid(intent, args.sender);
  }
  return flipped;
}
