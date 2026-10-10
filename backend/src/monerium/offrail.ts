import { createPublicClient, http, parseEventLogs, parseAbiItem, type Hex } from 'viem';
import { gnosis, gnosisChiado } from 'viem/chains';

import type { Env } from '../types';
import type { TenantRail } from '../tenants/rail';
import { sendAlert } from '../alerts';
import { writeAudit } from '../tenants/db';
import { getForwardByOrder, insertForward } from './db';
import { extractRoutingFromOrder } from './sid';
import { eurToWei, parseAmountCents } from './forward';
import type { MoneriumOrder } from './types';

/// A parked order whose money an operator already moved by hand (2/3 Safe
/// owners, outside the rail — e.g. safe-tx/003 orphan recovery). Recording it
/// as `resolved_offrail` closes the order: the admin reroute refuses it and a
/// redelivered webhook skips it. Without this the rail still sees "parked,
/// money in the Safe" and offers to pay it a second time out of whatever
/// other payments are in the Safe at that moment.
///
/// The claim is checked on-chain, not trusted: the tx must have succeeded and
/// moved EURe out of this rail's Safe.

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const LIVE = new Set(['pending', 'submitted', 'confirmed']);

export interface OffRailTransfer {
  /// Log index of the EURe Transfer inside the tx — identifies the leg.
  logIndex: number;
  to: string;
  valueWei: bigint;
}

export interface OffRailDeps {
  getForwardByOrder(orderId: string): Promise<{ status: string } | null>;
  /// EURe transfers out of `safe` in a successful tx; null = tx missing/failed.
  safeOutflows(txHash: string): Promise<OffRailTransfer[] | null>;
  /// tx_log_index of every forward row already pointing at this tx (any
  /// order). NULL = an older row that claimed the whole tx.
  usedLegs(txHash: string): Promise<Array<number | null>>;
  record(row: {
    orderId: string;
    txHash: string;
    logIndex: number;
    to: string;
    valueWei: bigint;
    amountCents: number | null;
    sid: string | null;
  }): Promise<number>;
  audit(detail: Record<string, unknown>): Promise<void>;
  alert(text: string): Promise<void>;
}

export type OffRailResult =
  | { ok: true; forwardId: number; to: string; valueWei: string }
  | { ok: false; error: 'bad_tx_hash' | 'not_processed' | 'already_forwarded' | 'already_resolved'
      | 'tx_not_found_or_failed' | 'no_eure_outflow_from_safe' | 'tx_already_used'
      /// OF-01: the tx has several legs — the operator must say which one.
      | 'leg_required' | 'leg_not_found' | 'leg_already_used'
      /// OF-02: leg value ≠ order amount; allowed only with force + reason.
      | 'amount_mismatch' };

export interface OffRailLeg {
  logIndex: number;
  to: string;
  valueWei: string;
  used: boolean;
}

/// The EURe legs out of the Safe in `txHash`, each marked used if a forward
/// row already consumed it — for the admin picker (OF-01).
export async function listOffRailLegs(deps: OffRailDeps, txHash: string): Promise<OffRailLeg[] | null> {
  const tx = txHash.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(tx)) return null;
  const outflows = await deps.safeOutflows(tx);
  if (outflows === null) return null;
  const used = await deps.usedLegs(tx);
  const wholeTx = used.includes(null);
  return outflows.map((o) => ({
    logIndex: o.logIndex,
    to: o.to.toLowerCase(),
    valueWei: o.valueWei.toString(),
    used: wholeTx || used.includes(o.logIndex),
  }));
}

export async function markResolvedOffRail(
  deps: OffRailDeps,
  order: MoneriumOrder,
  txHash: string,
  actor: string,
  opts: { logIndex?: number; force?: boolean; reason?: string } = {},
): Promise<OffRailResult> {
  const tx = txHash.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(tx)) return { ok: false, error: 'bad_tx_hash' };
  if (order.kind !== 'issue' || (order.state ?? order.meta?.state) !== 'processed') {
    return { ok: false, error: 'not_processed' };
  }
  const existing = await deps.getForwardByOrder(order.id);
  if (existing && LIVE.has(existing.status)) return { ok: false, error: 'already_forwarded' };
  if (existing?.status === 'resolved_offrail') return { ok: false, error: 'already_resolved' };
  // One transfer (leg) explains one order. Reusing it would let a single
  // manual payment "close" several parked orders. An older row without a log
  // index claimed the whole tx.
  const used = await deps.usedLegs(tx);
  if (used.includes(null)) return { ok: false, error: 'tx_already_used' };

  const outflows = await deps.safeOutflows(tx);
  if (outflows === null) return { ok: false, error: 'tx_not_found_or_failed' };
  if (outflows.length === 0) return { ok: false, error: 'no_eure_outflow_from_safe' };
  // OF-01: a batch may carry several orders' payouts — guessing the leg
  // (largest / memo target) recorded the wrong one. Single-leg tx: that leg.
  let pick: OffRailTransfer | undefined;
  if (opts.logIndex !== undefined) {
    pick = outflows.find((o) => o.logIndex === opts.logIndex);
    if (!pick) return { ok: false, error: 'leg_not_found' };
  } else if (outflows.length === 1) {
    pick = outflows[0];
  } else {
    return { ok: false, error: 'leg_required' };
  }
  if (used.includes(pick.logIndex)) return { ok: false, error: 'leg_already_used' };
  // OF-02: closing a 500 € order with a 1 € transfer would leave 499 € in the
  // Safe with no trace. A different amount is a written operator decision.
  if (pick.valueWei !== eurToWei(order.amount ?? '0') && !opts.force) {
    return { ok: false, error: 'amount_mismatch' };
  }

  const amountCents = parseAmountCents(order.amount);
  const forwardId = await deps.record({
    orderId: order.id,
    txHash: tx,
    logIndex: pick.logIndex,
    to: pick.to.toLowerCase(),
    valueWei: pick.valueWei,
    amountCents,
    sid: extractRoutingFromOrder(order).sid,
  });
  await deps.audit({
    order_id: order.id,
    tx_hash: tx,
    log_index: pick.logIndex,
    to: pick.to.toLowerCase(),
    value_wei: pick.valueWei.toString(),
    order_amount_cents: amountCents,
    force: !!opts.force,
    reason: opts.reason ?? null,
    actor,
  });
  await deps.alert(
    `✅ <b>Parkirana uplata označena kao riješena izvan raila</b>\n` +
      `order: <code>${order.id}</code> · iznos: <b>${order.amount} EUR</b>\n` +
      `ručni tx: <code>${tx}</code> → <code>${pick.to.toLowerCase()}</code>\n` +
      `označio: <code>${actor}</code>`,
  ).catch(() => {});
  return { ok: true, forwardId, to: pick.to.toLowerCase(), valueWei: pick.valueWei.toString() };
}

export function makeOffRailDeps(env: Env, rail: TenantRail): OffRailDeps {
  const s = rail.signer;
  const client = createPublicClient({
    chain: s.chain === 'chiado' ? gnosisChiado : gnosis,
    transport: http(s.rpcUrl),
  });
  const safe = s.safe.toLowerCase();
  const eure = s.eureContract.toLowerCase();
  return {
    getForwardByOrder: (orderId) => getForwardByOrder(env, orderId),
    safeOutflows: async (txHash) => {
      const receipt = await client.getTransactionReceipt({ hash: txHash as Hex }).catch(() => null);
      if (!receipt || receipt.status !== 'success') return null;
      return parseEventLogs({ abi: [TRANSFER], logs: receipt.logs })
        .filter((l) => l.address.toLowerCase() === eure && l.args.from.toLowerCase() === safe)
        .map((l) => ({ logIndex: l.logIndex, to: l.args.to, valueWei: l.args.value }));
    },
    usedLegs: async (txHash) => {
      const r = await env.DB.prepare(`SELECT tx_log_index FROM monerium_forwards WHERE lower(tx_hash) = ?`)
        .bind(txHash).all<{ tx_log_index: number | null }>();
      return r.results.map((x) => x.tx_log_index);
    },
    record: (row) => insertForward(env, {
      orderId: row.orderId,
      targetAddress: row.to,
      amountWei: row.valueWei.toString(),
      amountCents: row.amountCents,
      sid: row.sid,
      memoPrefix: 'offrail',
      status: 'resolved_offrail',
      txHash: row.txHash,
      tenantId: rail.tenantId,
      txLogIndex: row.logIndex,
    }),
    audit: (detail) => writeAudit(env, {
      tenantId: rail.tenantId,
      action: 'forward.resolved_offrail',
      address: (detail.to as string) ?? null,
      actor: (detail.actor as string) ?? 'admin',
      detail: JSON.stringify(detail),
    }),
    alert: (text) => sendAlert(env, text),
  };
}
