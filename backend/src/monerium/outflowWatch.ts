import { createPublicClient, http, parseAbiItem, toEventSelector, type Address, type Hex } from 'viem';
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
///   🚨  through a Safe module that is not our Roles modifier
///   ℹ️  owner-signed (the human 2/3 owners moving money by hand), or no Safe
///       execution event at all
///
/// The path is read from the Safe's own execution events in the receipt
/// (TD-01), not from `tx.to`: a thief with the forwarder key can call the
/// modifier through any relay/multicall contract, and `tx.to` is then the
/// relay — but the Safe still emits ExecutionFromModuleSuccess(modifier).
///
/// It cannot PREVENT a theft (the role still allows transfer to anyone, see
/// ADR 0019); it shortens the time to "revoke the role" from "whenever
/// somebody looks" to one cron tick.
///
/// Fail-open like the rest of alerting: an RPC error skips this tick and the
/// cursor does not move, so the next tick rescans the same blocks.

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
/// Safe ≥1.3: module path / owner path. Computed, not hardcoded.
export const EXEC_FROM_MODULE_SUCCESS = toEventSelector('ExecutionFromModuleSuccess(address)');
export const EXECUTION_SUCCESS = toEventSelector('ExecutionSuccess(bytes32,uint256)');
/// A forward row without tx hash only explains an outflow while it is young
/// and still `pending` (TD-03): a months-old `failed` row must not turn a
/// theft into ⚠️.
export const UNHASHED_FORWARD_MAX_AGE_SECONDS = 15 * 60;

/// Blocks behind head we do not look at yet. ~60 s on Gnosis: lets the forward
/// path write its tx hash after broadcast before we judge the transfer.
export const CONFIRMATION_LAG = 12n;
/// Upper bound per tick; the cron runs every 2 min (~24 blocks), so this only
/// matters when catching up after an outage.
export const MAX_RANGE = 2000n;
/// TD-04: a public RPC that refuses a wide getLogs gets halved ranges down to
/// this before the tick gives up.
export const MIN_RANGE = 100n;
/// TD-02: cursor this far behind head → "detector is lagging" (~40 min).
export const LAG_ALERT_BLOCKS = 500n;
/// Consecutive failed ticks per rail before the "detector is blind" alert.
export const FAIL_ALERT_TICKS = 3;

export interface Outflow {
  txHash: string;
  blockNumber: bigint;
  to: string;
  value: bigint;
}

export interface OutflowWatchDeps {
  latestBlock(): Promise<bigint>;
  outgoingTransfers(fromBlock: bigint, toBlock: bigint): Promise<Outflow[]>;
  /// How the watched Safe executed in this tx, from its own receipt events:
  /// modules that ran a transaction (lowercase), and whether owners did.
  safeExecEvents(txHash: string): Promise<SafeExec>;
  /// A forward row with exactly this tx hash exists (any status).
  isKnownForwardTx(txHash: string): Promise<boolean>;
  /// A forward row to `to` for `amountWei` is still waiting for its tx hash.
  hasUnhashedForward(to: string, amountWei: string): Promise<boolean>;
  getCursor(): Promise<bigint | null>;
  setCursor(block: bigint): Promise<void>;
  alert(text: string): Promise<void>;
  audit(detail: Record<string, unknown>): Promise<void>;
  /// True at most once per `ttlSeconds` for `key` (dedup for operational
  /// alerts). Optional: without it every occurrence alerts.
  claimOnce?(key: string, ttlSeconds: number): Promise<boolean>;
}

export interface WatchedSafe {
  tenantId: string;
  safe: string;
  rolesModifier: string;
}

export interface SafeExec {
  viaModules: string[];
  viaOwners: boolean;
}

export type OutflowVerdict = 'known' | 'role_unknown' | 'role_unhashed' | 'module_unknown' | 'other';

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
  if (head - cursor > LAG_ALERT_BLOCKS && (await claim(deps, `watch:lag:${w.tenantId}`, 6 * 3600))) {
    await safely(deps.alert(
      `⚠️ <b>Detektor krađe zaostaje</b>\n` +
      `tenant: <code>${w.tenantId}</code> · Safe: <code>${w.safe}</code>\n` +
      `kursor ${cursor}, chain ${head} → ${head - cursor} blokova iza. Izlazi iz Safe-a se još ne gledaju.`,
    ));
  }
  let to = head - from + 1n > MAX_RANGE ? from + MAX_RANGE - 1n : head;

  // TD-04: shrink the range on RPC refusal instead of stalling forever.
  let outflows: Outflow[];
  for (;;) {
    try {
      outflows = await deps.outgoingTransfers(from, to);
      break;
    } catch (e) {
      const range = to - from + 1n;
      if (range <= MIN_RANGE) throw e;
      const half = range / 2n < MIN_RANGE ? MIN_RANGE : range / 2n;
      to = from + half - 1n;
    }
  }
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
  const exec = await deps.safeExecEvents(o.txHash);
  if (exec.viaModules.includes(w.rolesModifier.toLowerCase())) {
    return (await deps.hasUnhashedForward(o.to, o.value.toString())) ? 'role_unhashed' : 'role_unknown';
  }
  if (exec.viaModules.length > 0) return 'module_unknown';
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
  if (v === 'module_unknown') {
    return (
      `🚨 <b>EURe izašao iz MPT Safe-a kroz modul koji nije naš Roles modifier</b>\n` +
      `${facts}\n` +
      `Safe ima modul koji ne bi smio imati. Odmah: 2/3 vlasnika provjeravaju ` +
      `getModulesPaginated i uklanjaju nepoznati modul (disableModule).`
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
    `Nije prošao kroz forwarder rolu ni kroz drugi modul (ručni 2/3 transfer vlasnika ili ` +
    `transfer bez Safe izvršenja). Ako ga nitko nije radio — istražiti.`
  );
}

async function claim(deps: OutflowWatchDeps, key: string, ttl: number): Promise<boolean> {
  if (!deps.claimOnce) return true;
  try {
    return await deps.claimOnce(key, ttl);
  } catch {
    return true;
  }
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

/// Safe execution events emitted BY `safe` in a receipt. Module address is the
/// indexed topic of ExecutionFromModuleSuccess.
export function safeExecFromLogs(
  logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string | null> }>,
  safe: string,
): SafeExec {
  const viaModules: string[] = [];
  let viaOwners = false;
  for (const l of logs) {
    if (l.address.toLowerCase() !== safe.toLowerCase()) continue;
    const t0 = l.topics[0]?.toLowerCase();
    if (t0 === EXEC_FROM_MODULE_SUCCESS && l.topics[1]) {
      viaModules.push(`0x${l.topics[1].slice(-40)}`.toLowerCase());
    } else if (t0 === EXECUTION_SUCCESS) {
      viaOwners = true;
    }
  }
  return { viaModules, viaOwners };
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
    safeExecEvents: async (txHash) => {
      const receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
      return safeExecFromLogs(receipt.logs, safe);
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
          WHERE tx_hash IS NULL AND status = 'pending' AND created_at > ?
            AND lower(target_address) = ? AND amount_wei = ? LIMIT 1`,
      ).bind(
        Math.floor(Date.now() / 1000) - UNHASHED_FORWARD_MAX_AGE_SECONDS,
        to.toLowerCase(),
        amountWei,
      ).first<{ hit: number }>();
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
    claimOnce: (k, ttl) => kvClaimOnce(env, k, ttl),
    audit: (detail) => writeAudit(env, {
      tenantId: rail.tenantId,
      action: 'outflow.unexplained',
      address: (detail.to as string) ?? null,
      actor: 'system',
      detail: JSON.stringify(detail),
    }),
  };
}

async function kvClaimOnce(env: Env, key: string, ttlSeconds: number): Promise<boolean> {
  if (await env.TOKEN_CACHE.get(key)) return false;
  await env.TOKEN_CACHE.put(key, '1', { expirationTtl: ttlSeconds });
  return true;
}

/// Cron entry: the ITalk rail and every tenant rail, each independently.
///
/// TD-02: the detector lives in the Worker an attacker with deploy rights
/// controls, so it proves it is alive OUTSIDE Cloudflare: after a tick in
/// which every rail was read, it pings WATCH_HEARTBEAT_URL (a dead-man
/// switch such as healthchecks.io that alerts when pings stop). Once an hour
/// it also leaves an `outflow.tick` audit row. A rail that fails
/// FAIL_ALERT_TICKS ticks in a row raises "detector is blind".
export async function watchAllRailOutflows(env: Env, nowMs = Date.now()): Promise<number> {
  const rails: TenantRail[] = [legacyRail(env)];
  for (const id of await listRailTenantIds(env)) {
    const r = await getTenantRail(env, id);
    if (r) rails.push(r);
  }
  let flagged = 0;
  let allOk = true;
  const hourly = Math.floor(nowMs / 120_000) % 30 === 0;
  for (const rail of rails) {
    const s = rail.signer;
    if (!s.safe || !s.rolesModifier || !s.eureContract || !s.rpcUrl) continue;
    const failKey = `watch:fail:${rail.tenantId}`;
    try {
      const r = await watchSafeOutflows(makeOutflowWatchDeps(env, rail), {
        tenantId: rail.tenantId,
        safe: s.safe.toLowerCase(),
        rolesModifier: s.rolesModifier.toLowerCase(),
      });
      if (r) flagged += r.flagged;
      await env.TOKEN_CACHE.delete(failKey).catch(() => {});
      if (hourly && r) {
        await writeAudit(env, {
          tenantId: rail.tenantId,
          action: 'outflow.tick',
          actor: 'system',
          detail: JSON.stringify({ from: r.from.toString(), to: r.to.toString(), outflows: r.outflows, flagged: r.flagged }),
        }).catch(() => {});
      }
    } catch (e) {
      allOk = false;
      console.error(`outflow watch ${rail.tenantId} failed: ${(e as Error).message}`);
      try {
        const n = Number((await env.TOKEN_CACHE.get(failKey)) ?? '0') + 1;
        await env.TOKEN_CACHE.put(failKey, String(n), { expirationTtl: 3600 });
        if (n === FAIL_ALERT_TICKS) {
          await sendAlert(
            env,
            `⚠️ <b>Detektor krađe ne čita chain</b>\n` +
              `tenant: <code>${rail.tenantId}</code> · ${n} uzastopna neuspjela pokušaja\n` +
              `greška: <code>${(e as Error).message.slice(0, 200)}</code>\n` +
              `Dok se ne popravi, izlazi iz Safe-a se ne prate.`,
          );
        }
      } catch (kvErr) {
        console.error(`outflow watch fail counter: ${(kvErr as Error).message}`);
      }
    }
  }
  if (allOk && env.WATCH_HEARTBEAT_URL) {
    try {
      await fetch(env.WATCH_HEARTBEAT_URL, { method: 'GET' });
    } catch (e) {
      console.error(`outflow watch heartbeat: ${(e as Error).message}`);
    }
  }
  return flagged;
}
