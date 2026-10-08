import { createPublicClient, http, parseEventLogs, parseAbiItem, type Hex } from 'viem';
import { gnosis, gnosisChiado } from 'viem/chains';

import type { Env } from '../types';
import type { TenantRail } from '../tenants/rail';
import { sendAlert } from '../alerts';
import { writeAudit } from '../tenants/db';
import { getForwardByOrder, insertForward } from './db';
import { extractRoutingFromOrder } from './sid';
import { parseAmountCents } from './forward';
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
  to: string;
  valueWei: bigint;
}

export interface OffRailDeps {
  getForwardByOrder(orderId: string): Promise<{ status: string } | null>;
  /// EURe transfers out of `safe` in a successful tx; null = tx missing/failed.
  safeOutflows(txHash: string): Promise<OffRailTransfer[] | null>;
  /// Forward row ids already pointing at this tx (any order).
  forwardIdsByTx(txHash: string): Promise<number[]>;
  record(row: {
    orderId: string;
    txHash: string;
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
      | 'tx_not_found_or_failed' | 'no_eure_outflow_from_safe' | 'tx_already_used' };

export async function markResolvedOffRail(
  deps: OffRailDeps,
  order: MoneriumOrder,
  txHash: string,
  actor: string,
): Promise<OffRailResult> {
  const tx = txHash.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(tx)) return { ok: false, error: 'bad_tx_hash' };
  if (order.kind !== 'issue' || (order.state ?? order.meta?.state) !== 'processed') {
    return { ok: false, error: 'not_processed' };
  }
  const existing = await deps.getForwardByOrder(order.id);
  if (existing && LIVE.has(existing.status)) return { ok: false, error: 'already_forwarded' };
  if (existing?.status === 'resolved_offrail') return { ok: false, error: 'already_resolved' };
  // One transfer explains one order. Reusing it would let a single manual
  // payment "close" several parked orders.
  if ((await deps.forwardIdsByTx(tx)).length > 0) return { ok: false, error: 'tx_already_used' };

  const outflows = await deps.safeOutflows(tx);
  if (outflows === null) return { ok: false, error: 'tx_not_found_or_failed' };
  if (outflows.length === 0) return { ok: false, error: 'no_eure_outflow_from_safe' };
  // A batch may carry several transfers; the order's own beneficiary first if
  // the memo named one, otherwise the largest.
  const memoTarget = extractRoutingFromOrder(order).diagnosticTarget;
  const pick =
    outflows.find((o) => memoTarget && o.to.toLowerCase() === memoTarget)
    ?? [...outflows].sort((a, b) => (a.valueWei < b.valueWei ? 1 : -1))[0];

  const amountCents = parseAmountCents(order.amount);
  const forwardId = await deps.record({
    orderId: order.id,
    txHash: tx,
    to: pick.to.toLowerCase(),
    valueWei: pick.valueWei,
    amountCents,
    sid: extractRoutingFromOrder(order).sid,
  });
  await deps.audit({
    order_id: order.id,
    tx_hash: tx,
    to: pick.to.toLowerCase(),
    value_wei: pick.valueWei.toString(),
    order_amount_cents: amountCents,
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
        .map((l) => ({ to: l.args.to, valueWei: l.args.value }));
    },
    forwardIdsByTx: async (txHash) => {
      const r = await env.DB.prepare(`SELECT id FROM monerium_forwards WHERE lower(tx_hash) = ?`)
        .bind(txHash).all<{ id: number }>();
      return r.results.map((x) => x.id);
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
