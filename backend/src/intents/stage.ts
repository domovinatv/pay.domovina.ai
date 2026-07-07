import type { Env } from '../types';
import type { PaymentIntentRow } from './db';
import type { MoneriumOrderRow, MoneriumForwardRow } from '../monerium/db';
import { getMoneriumOrder, getForwardByOrder, updateForward } from '../monerium/db';
import { getForwardStatus } from '../router/safe';
import type { Hex } from 'viem';

/// Canonical per-stage payment status — "gdje su moji novci".
///
/// Computed AT READ TIME by joining payment_intents ↔ monerium_orders ↔
/// monerium_forwards (no schema migration). Purely additive over the existing
/// `state` field: `markIntentPaid` timing and the merchant webhook are
/// untouched.
///
/// Honesty constraints (docs/plans/payment-status-timeline.md):
/// - The user→bank→SEPA-transit window is BLIND: no Monerium order exists
///   until funds land. `awaiting_payment` carries only elapsed time — the
///   client derives progressive copy from it, never fake progress.
/// - Monerium `pending` conflates review/mint/settlement; we expose it as
///   one `received_processing` stage and never claim "AML hold".
/// - `rejected` reason is free text from `meta.rejectedReason` — passed
///   through verbatim, not classified.

export type PaymentStage =
  | 'awaiting_payment'
  | 'received_processing'
  | 'minted'
  | 'forwarding'
  | 'settled'
  | 'rejected'
  | 'expired';

export type StepStatus = 'proven' | 'in_progress' | 'waiting' | 'failed';

export type StepKey = 'payment' | 'processing' | 'minted' | 'forwarding' | 'settled';

export type Custodian = 'bank' | 'monerium' | 'blockchain' | 'relay' | 'recipient';

export interface StageStep {
  key: StepKey;
  status: StepStatus;
  /// Unix seconds when the step reached a terminal-for-it status
  /// (proven/failed). Null while waiting / in progress or when the source
  /// timestamp is unavailable.
  at: number | null;
  custodian: Custodian;
  tx_hash?: string | null;
  tx_hashes?: string[];
}

export interface StageResult {
  stage: PaymentStage;
  steps: StageStep[];
  /// Seconds since intent creation.
  elapsed_seconds: number;
  /// Seconds since the last observed stage transition (best-effort from the
  /// newest timestamp we can attribute to the current stage).
  seconds_in_stage: number;
  /// Whether an on-chain forward hop is part of this payment's rail
  /// (mpt:/gnosis:/cmp: routing → yes; bare 0x / direct mint → no).
  forward_expected: boolean;
  order_id: string | null;
  order_state: string | null;
  mint_tx_hashes: string[];
  forward_status: MoneriumForwardRow['status'] | null;
  forward_tx_hash: string | null;
  rejected_reason: string | null;
}

/// Narrow row slices so the pure computation is unit-testable without D1.
export type StageIntent = Pick<
  PaymentIntentRow,
  'state' | 'created_at' | 'expires_at' | 'paid_at'
>;
export type StageOrder = Pick<
  MoneriumOrderRow,
  'id' | 'state' | 'memo' | 'reference_number' | 'tx_hashes'
  | 'placed_at' | 'processed_at' | 'raw_json' | 'updated_at'
>;
export type StageForward = Pick<
  MoneriumForwardRow,
  'status' | 'tx_hash' | 'error' | 'created_at' | 'updated_at'
>;

export interface StageInput {
  intent: StageIntent;
  order: StageOrder | null;
  forward: StageForward | null;
  /// Unix seconds "now" — injected for testability.
  now: number;
}

const ORDER_ROUTED_RE = /^(mpt|gnosis|cmp):/i;

/// Pure stage computation — single source of truth for all three surfaces
/// (checkout page, Flutter in-app status, merchant/POS view).
export function computeStage(input: StageInput): StageResult {
  const { intent, order, forward, now } = input;
  const elapsed = Math.max(0, now - intent.created_at);

  const mintTxHashes = parseTxHashes(order?.tx_hashes ?? null);
  const rejectedReason = order ? parseRejectedReason(order.raw_json) : null;
  const placedAt = isoToUnix(order?.placed_at ?? null) ?? order?.updated_at ?? null;
  const processedAt = isoToUnix(order?.processed_at ?? null) ?? order?.updated_at ?? null;

  // Forward expected: an actual forward row settles the question; otherwise
  // infer from the routing prefix in the order memo/reference. Before any
  // order exists the rail default is "yes" (every intent QR emits mpt:…),
  // which only affects which steps render as `waiting`.
  const forwardExpected = forward
    ? true
    : order
      ? ORDER_ROUTED_RE.test(order.memo ?? '') || ORDER_ROUTED_RE.test(order.reference_number ?? '')
      : true;

  const stage = resolveStage(intent, order, forward, forwardExpected);

  const steps = buildSteps({
    stage, order, forward, forwardExpected,
    placedAt, processedAt, mintTxHashes,
    expiresAt: intent.expires_at,
  });

  return {
    stage,
    steps,
    elapsed_seconds: elapsed,
    seconds_in_stage: Math.max(0, now - stageEnteredAt({
      stage, intent, order, forward, placedAt, processedAt,
    })),
    forward_expected: forwardExpected,
    order_id: order?.id ?? null,
    order_state: order?.state ?? null,
    mint_tx_hashes: mintTxHashes,
    forward_status: forward?.status ?? null,
    forward_tx_hash: forward?.tx_hash ?? null,
    rejected_reason: rejectedReason,
  };
}

function resolveStage(
  intent: StageIntent,
  order: StageOrder | null,
  forward: StageForward | null,
  forwardExpected: boolean,
): PaymentStage {
  // Terminal: Monerium refused the order (compliance OR insufficient funds —
  // indistinguishable except via free-text reason).
  if (order?.state === 'rejected') return 'rejected';
  // Terminal: intent expired and money never reached Monerium. If an order
  // DID arrive after expiry we keep showing real stages — the EURe still
  // flows (forward doesn't check intent expiry).
  if (!order) return intent.state === 'expired' ? 'expired' : 'awaiting_payment';
  if (order.state === 'processed') {
    if (forward) {
      switch (forward.status) {
        case 'confirmed': return 'settled';
        case 'submitted':
        case 'pending': return 'forwarding';
        case 'failed': return 'minted'; // minted but stuck — step carries `failed`
      }
    }
    return forwardExpected ? 'minted' : 'settled';
  }
  // placed | pending | anything unknown → money is provably at Monerium.
  return 'received_processing';
}

function buildSteps(args: {
  stage: PaymentStage;
  order: StageOrder | null;
  forward: StageForward | null;
  forwardExpected: boolean;
  placedAt: number | null;
  processedAt: number | null;
  mintTxHashes: string[];
  expiresAt: number;
}): StageStep[] {
  const { stage, order, forward, forwardExpected, placedAt, processedAt, mintTxHashes, expiresAt } = args;

  const payment: StageStep = {
    key: 'payment', custodian: 'bank',
    status: order ? 'proven' : stage === 'expired' ? 'failed' : 'waiting',
    at: order ? placedAt : stage === 'expired' ? expiresAt : null,
  };

  const processing: StageStep = {
    key: 'processing', custodian: 'monerium',
    status: !order ? 'waiting'
      : stage === 'rejected' ? 'failed'
      : order.state === 'processed' ? 'proven'
      : 'in_progress',
    at: !order ? null
      : stage === 'rejected' ? processedAt
      : order.state === 'processed' ? processedAt
      : null,
  };

  const minted: StageStep = {
    key: 'minted', custodian: 'blockchain',
    status: order?.state === 'processed' ? 'proven' : 'waiting',
    at: order?.state === 'processed' ? processedAt : null,
    tx_hashes: mintTxHashes,
  };

  const settledProven = stage === 'settled';
  const steps: StageStep[] = [payment, processing, minted];

  if (forwardExpected) {
    steps.push({
      key: 'forwarding', custodian: 'relay',
      status: !forward ? 'waiting'
        : forward.status === 'failed' ? 'failed'
        : forward.status === 'confirmed' ? 'proven'
        : 'in_progress',
      at: forward && (forward.status === 'confirmed' || forward.status === 'failed')
        ? forward.updated_at
        : null,
      tx_hash: forward?.tx_hash ?? null,
    });
  }

  steps.push({
    key: 'settled', custodian: 'recipient',
    status: settledProven ? 'proven' : 'waiting',
    at: settledProven ? (forward?.updated_at ?? processedAt) : null,
    tx_hash: forward?.tx_hash ?? null,
  });

  return steps;
}

function stageEnteredAt(args: {
  stage: PaymentStage;
  intent: StageIntent;
  order: StageOrder | null;
  forward: StageForward | null;
  placedAt: number | null;
  processedAt: number | null;
}): number {
  const { stage, intent, order, forward, placedAt, processedAt } = args;
  switch (stage) {
    case 'awaiting_payment': return intent.created_at;
    case 'expired': return intent.expires_at;
    case 'received_processing': return placedAt ?? order?.updated_at ?? intent.created_at;
    case 'minted':
    case 'rejected': return processedAt ?? order?.updated_at ?? intent.created_at;
    case 'forwarding': return forward?.updated_at ?? forward?.created_at ?? intent.created_at;
    case 'settled':
      return forward?.updated_at ?? intent.paid_at ?? processedAt ?? intent.created_at;
  }
}

/// D1 lookups feeding computeStage. Order resolution: the direct FK on a
/// paid intent, else the newest signature-verified webhook event whose
/// extracted sid matches — this is what makes `received_processing` visible
/// BEFORE the forward/paid flip links the tables.
export async function loadStageContext(
  env: Env,
  intent: PaymentIntentRow,
): Promise<{ order: MoneriumOrderRow | null; forward: MoneriumForwardRow | null }> {
  let order: MoneriumOrderRow | null = null;
  if (intent.monerium_order_id) {
    order = await getMoneriumOrder(env, intent.monerium_order_id);
  }
  if (!order) {
    const row = await env.DB.prepare(
      `SELECT o.* FROM monerium_orders o
        WHERE o.id = (
          SELECT order_id FROM monerium_webhook_events
           WHERE sid_extracted = ? AND order_id IS NOT NULL AND signature_ok = 1
           ORDER BY id DESC LIMIT 1)`,
    )
      .bind(intent.sid)
      .first<MoneriumOrderRow>();
    order = row ?? null;
  }
  const forward = order ? await getForwardByOrder(env, order.id) : null;
  return { order, forward };
}

/// Best-effort on-chain confirmation of a broadcast forward. Runs in
/// `waitUntil` on the status read path so polling clients (2 s loop) pick
/// up `settled` one tick after the receipt is mined — without ever blocking
/// the response. Idempotent: updateForward is a plain UPDATE and repeat
/// receipts return the same status.
export async function confirmForwardIfMined(
  env: Env,
  forward: MoneriumForwardRow,
): Promise<void> {
  if (forward.status !== 'submitted' || !forward.tx_hash) return;
  try {
    const status = await getForwardStatus(env, forward.tx_hash as Hex);
    if (status === 'confirmed') {
      await updateForward(env, forward.id, { status: 'confirmed' });
    } else if (status === 'failed') {
      await updateForward(env, forward.id, { status: 'failed', error: 'onchain_revert' });
    }
    // 'pending' / 'unknown' → leave as submitted, next poll retries.
  } catch (e) {
    console.warn(`confirmForwardIfMined ${forward.id}: ${(e as Error).message}`);
  }
}

function parseTxHashes(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

function parseRejectedReason(rawJson: string): string | null {
  try {
    const v = JSON.parse(rawJson) as { meta?: { rejectedReason?: unknown } };
    const r = v?.meta?.rejectedReason;
    return typeof r === 'string' && r.length > 0 ? r : null;
  } catch {
    return null;
  }
}

function isoToUnix(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
