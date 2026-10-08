import { createPublicClient, http, parseAbiItem, type Address, type Hex } from 'viem';
import { gnosis, gnosisChiado } from 'viem/chains';

import type { Env } from '../types';
import { sendAlert } from '../alerts';
import { writeAudit } from '../tenants/db';
import { getTenantRail, legacyRail, listRailTenantIds, type TenantRail } from '../tenants/rail';

/// Theft detector (ADR 0019, phase 0). Every EURe that leaves a rail's
/// receiving Safe must correspond to a forward we broadcast ourselves
/// (`monerium_forwards.tx_hash`). Anything else is reported:
///
///   🚨  sent through the Roles modifier, i.e. signed with the forwarder key,
///       but not by the rail — the key is being used by someone else
///   ⚠️  through the Roles modifier, matching a forward row that never got
///       its tx hash written (Worker died between broadcast and update)
///   ℹ️  any other path, e.g. the human 2/3 owners moving money by hand
///
/// It cannot PREVENT a theft (the role still allows transfer to anyone, see
/// ADR 0019); it shortens the time to "revoke the role" from "whenever
/// somebody looks" to one cron tick.
///
/// Fail-open like the rest of alerting: an RPC error skips this tick and the
/// cursor does not move, so the next tick rescans the same blocks.

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/// Blocks behind head we do not look at yet. ~60 s on Gnosis: lets the forward
/// path write its tx hash after broadcast before we judge the transfer.
export const CONFIRMATION_LAG = 12n;
/// Upper bound per tick; the cron runs every 2 min (~24 blocks), so this only
/// matters when catching up after an outage.
export const MAX_RANGE = 2000n;

export interface Outflow {
  txHash: string;
  blockNumber: bigint;
  to: string;
  value: bigint;
}

export interface OutflowWatchDeps {
  latestBlock(): Promise<bigint>;
  outgoingTransfers(fromBlock: bigint, toBlock: bigint): Promise<Outflow[]>;
  /// `to` of the transaction that carried the transfer (lowercase), or null.
  txTarget(txHash: string): Promise<string | null>;
  /// A forward row with exactly this tx hash exists (any status).
  isKnownForwardTx(txHash: string): Promise<boolean>;
  /// A forward row to `to` for `amountWei` is still waiting for its tx hash.
  hasUnhashedForward(to: string, amountWei: string): Promise<boolean>;
  getCursor(): Promise<bigint | null>;
  setCursor(block: bigint): Promise<void>;
  alert(text: string): Promise<void>;
  audit(detail: Record<string, unknown>): Promise<void>;
}

export interface WatchedSafe {
  tenantId: string;
  safe: string;
  rolesModifier: string;
}

export type OutflowVerdict = 'known' | 'role_unknown' | 'role_unhashed' | 'other';

export async function watchSafeOutflows(
  deps: OutflowWatchDeps,
  w: WatchedSafe,
): Promise<{ from: bigint; to: bigint; outflows: number; flagged: number } | null> {
  const head = (await deps.latestBlock()) - CONFIRMATION_LAG;
  const cursor = await deps.getCursor();
  // First run: start at the head. Historic manual transfers (e.g. the
  // 2026-05-21 orphan recovery) would otherwise all alert at once.
  if (cursor === null) {
    await deps.setCursor(head);
    return null;
  }
  if (head <= cursor) return null;
  const from = cursor + 1n;
  const to = head - from + 1n > MAX_RANGE ? from + MAX_RANGE - 1n : head;

  const outflows = await deps.outgoingTransfers(from, to);
  let flagged = 0;
  for (const o of outflows) {
    const verdict = await classify(deps, w, o);
    if (verdict === 'known') continue;
    flagged++;
    await safely(deps.alert(alertText(w, o, verdict)));
    await safely(deps.audit({
      verdict,
      tx_hash: o.txHash,
      block: o.blockNumber.toString(),
      to: o.to,
      value_wei: o.value.toString(),
      safe: w.safe,
    }));
  }
  // Only after every alert went out: a crash mid-loop rescans next tick
  // (duplicate alerts are acceptable, a missed one is not).
  await deps.setCursor(to);
  return { from, to, outflows: outflows.length, flagged };
}

export async function classify(
  deps: OutflowWatchDeps,
  w: WatchedSafe,
  o: Outflow,
): Promise<OutflowVerdict> {
  if (await deps.isKnownForwardTx(o.txHash)) return 'known';
  const target = await deps.txTarget(o.txHash);
  if (target !== null && target === w.rolesModifier.toLowerCase()) {
    return (await deps.hasUnhashedForward(o.to, o.value.toString())) ? 'role_unhashed' : 'role_unknown';
  }
  return 'other';
}

function alertText(w: WatchedSafe, o: Outflow, v: OutflowVerdict): string {
  const eur = formatEure(o.value);
  const facts =
    `tenant: <code>${w.tenantId}</code> · Safe: <code>${w.safe}</code>\n` +
    `iznos: <b>${eur} EURe</b> → <code>${o.to}</code>\n` +
    `tx: <code>${o.txHash}</code> (blok ${o.blockNumber})`;
  if (v === 'role_unknown') {
    return (
      `🚨 <b>EURe izašao iz MPT Safe-a forwarder ključem, a rail ga NIJE poslao</b>\n` +
      `${facts}\n` +
      `Ključ role je vjerojatno kompromitiran. Odmah: 2/3 vlasnika opozivaju rolu ` +
      `(Roles.assignRoles(router, [roleKey], [false])) i rotiraju ROUTER_PRIVATE_KEY.`
    );
  }
  if (v === 'role_unhashed') {
    return (
      `⚠️ <b>Forward je na chainu, ali rail nije zapisao tx hash</b>\n` +
      `${facts}\n` +
      `Postoji forward red za tu adresu i iznos bez tx-a — Worker je vjerojatno pao ` +
      `između broadcasta i zapisa. Provjeriti i upisati tx_hash ručno.`
    );
  }
  return (
    `ℹ️ <b>Izlazni EURe iz MPT Safe-a mimo raila</b>\n` +
    `${facts}\n` +
    `Nije prošao kroz forwarder rolu (npr. ručni 2/3 transfer vlasnika). Ako ga nitko nije radio — istražiti.`
  );
}

export function formatEure(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const cents = (wei % 10n ** 18n) / 10n ** 16n;
  return `${whole},${cents.toString().padStart(2, '0')}`;
}

async function safely(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (e) {
    console.error(`outflow watch side-effect failed: ${(e as Error).message}`);
  }
}

// ---- wiring ----------------------------------------------------------------

export function makeOutflowWatchDeps(env: Env, rail: TenantRail): OutflowWatchDeps {
  const s = rail.signer;
  const client = createPublicClient({
    chain: s.chain === 'chiado' ? gnosisChiado : gnosis,
    transport: http(s.rpcUrl),
  });
  const safe = s.safe.toLowerCase();
  const key = `${s.chain}:${safe}`;
  return {
    latestBlock: () => client.getBlockNumber(),
    outgoingTransfers: async (fromBlock, toBlock) => {
      const logs = await client.getLogs({
        address: s.eureContract as Address,
        event: TRANSFER,
        args: { from: safe as Address },
        fromBlock,
        toBlock,
      });
      return logs.map((l) => ({
        txHash: (l.transactionHash ?? '').toLowerCase(),
        blockNumber: l.blockNumber ?? 0n,
        to: (l.args.to ?? '').toLowerCase(),
        value: l.args.value ?? 0n,
      }));
    },
    txTarget: async (txHash) => {
      const tx = await client.getTransaction({ hash: txHash as Hex });
      return tx.to ? tx.to.toLowerCase() : null;
    },
    isKnownForwardTx: async (txHash) => {
      const row = await env.DB.prepare(
        `SELECT 1 AS hit FROM monerium_forwards WHERE lower(tx_hash) = ? LIMIT 1`,
      ).bind(txHash.toLowerCase()).first<{ hit: number }>();
      return row !== null;
    },
    hasUnhashedForward: async (to, amountWei) => {
      const row = await env.DB.prepare(
        `SELECT 1 AS hit FROM monerium_forwards
          WHERE tx_hash IS NULL AND lower(target_address) = ? AND amount_wei = ? LIMIT 1`,
      ).bind(to.toLowerCase(), amountWei).first<{ hit: number }>();
      return row !== null;
    },
    getCursor: async () => {
      const row = await env.DB.prepare(
        `SELECT last_block FROM chain_watch_cursor WHERE key = ?`,
      ).bind(key).first<{ last_block: number }>();
      return row ? BigInt(row.last_block) : null;
    },
    setCursor: async (block) => {
      await env.DB.prepare(
        `INSERT INTO chain_watch_cursor (key, last_block, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET last_block = excluded.last_block, updated_at = excluded.updated_at`,
      ).bind(key, Number(block), Math.floor(Date.now() / 1000)).run();
    },
    alert: (text) => sendAlert(env, text),
    audit: (detail) => writeAudit(env, {
      tenantId: rail.tenantId,
      action: 'outflow.unexplained',
      address: (detail.to as string) ?? null,
      actor: 'system',
      detail: JSON.stringify(detail),
    }),
  };
}

/// Cron entry: the ITalk rail and every tenant rail, each independently.
export async function watchAllRailOutflows(env: Env): Promise<number> {
  const rails: TenantRail[] = [legacyRail(env)];
  for (const id of await listRailTenantIds(env)) {
    const r = await getTenantRail(env, id);
    if (r) rails.push(r);
  }
  let flagged = 0;
  for (const rail of rails) {
    const s = rail.signer;
    if (!s.safe || !s.rolesModifier || !s.eureContract || !s.rpcUrl) continue;
    try {
      const r = await watchSafeOutflows(makeOutflowWatchDeps(env, rail), {
        tenantId: rail.tenantId,
        safe: s.safe.toLowerCase(),
        rolesModifier: s.rolesModifier.toLowerCase(),
      });
      if (r) flagged += r.flagged;
    } catch (e) {
      console.error(`outflow watch ${rail.tenantId} failed: ${(e as Error).message}`);
    }
  }
  return flagged;
}
