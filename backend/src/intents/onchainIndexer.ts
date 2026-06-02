import { createPublicClient, http, getAddress, parseAbiItem, type Address } from 'viem';
import { gnosis } from 'viem/chains';
import type { Env } from '../types';

/// On-chain EURe donation indexer.
///
/// Scans Monerium EURe **V2** (`env.EURE_CONTRACT` = 0x420CA0f9 on Gnosis)
/// `Transfer` logs whose recipient is a pinka campaign Safe, and forwards them
/// to domovina-api `pinka-onchain-ingest` (HMAC-signed) which credits a paid
/// contribution. This is the direct-donation path: a donor scans the EIP-681 QR
/// with any wallet and sends EURe straight to the campaign Safe (no SEPA, no sid).
///
/// IMPORTANT (see docs/reference/monerium-contracts.md): index V2 only. V1
/// (0xcB444e90) and V2 share balances but emit logs separately; Gnosis is long
/// past the V1→V2 cutover (block 35656951) so all current activity is on V2.
///
/// Dedup: rail forwards ALSO land EURe at campaign Safes (the fiat path, already
/// credited via the Monerium webhook). Those come FROM the MPT rail Safe
/// (`env.SAFE_ADDRESS`), so we skip transfers whose `from` is the rail.

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

const CURSOR_KEY = 'onchain:cursor:eure';
const CHUNK = 5_000n;        // public Gnosis RPC caps eth_getLogs block range
const FIRST_RUN_LOOKBACK = 5_000n;
const MAX_CHUNKS_PER_RUN = 20n; // bound subrequests if the cursor falls far behind

type WatchEntry = { campaign_id: string; address: string };
type Transfer = {
  to: string;
  from: string;
  tx_hash: string;
  log_index: number;
  amount_wei: string;
  block: number;
};

function ingestUrl(env: Env): string {
  // Same Supabase functions base as the outbound webhook, different fn.
  return (env.INTENT_WEBHOOK_URL ?? 'https://api.domovina.ai/functions/v1/pinka-webhook')
    .replace(/\/[^/]+$/, '/pinka-onchain-ingest');
}

export async function scanOnchainDonations(
  env: Env,
): Promise<{ scanned: string; found: number; posted: number; created?: number }> {
  const secret = env.INTENT_WEBHOOK_SECRET?.trim();
  if (!secret) return { scanned: 'skip:no_secret', found: 0, posted: 0 };

  const base = ingestUrl(env);

  // 1. Watchlist of active campaign Safe addresses.
  const wlRes = await fetch(base, { method: 'GET' });
  if (!wlRes.ok) return { scanned: `skip:watchlist_${wlRes.status}`, found: 0, posted: 0 };
  const wl = (await wlRes.json()) as { watchlist?: WatchEntry[] };
  const watch = wl.watchlist ?? [];
  if (watch.length === 0) return { scanned: 'skip:empty_watchlist', found: 0, posted: 0 };
  const toAddrs = watch.map((w) => getAddress(w.address));

  // 2. Client + cursor.
  const rpcUrl = env.GNOSIS_RPC_URL || 'https://rpc.gnosischain.com';
  const client = createPublicClient({ chain: gnosis, transport: http(rpcUrl) });
  const latest = await client.getBlockNumber();
  const stored = await env.TOKEN_CACHE.get(CURSOR_KEY);
  let from = stored ? BigInt(stored) + 1n : latest - FIRST_RUN_LOOKBACK;
  if (from > latest) return { scanned: `up_to_date@${latest}`, found: 0, posted: 0 };

  const railFrom = (env.SAFE_ADDRESS ?? '').toLowerCase();
  const eure = getAddress(env.EURE_CONTRACT);
  const transfers: Transfer[] = [];
  let cursorEnd = from - 1n;
  let chunks = 0n;

  // 3. Chunked scan.
  for (; from <= latest && chunks < MAX_CHUNKS_PER_RUN; from += CHUNK, chunks++) {
    const to = from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n;
    const logs = await client.getLogs({
      address: eure,
      event: TRANSFER_EVENT,
      args: { to: toAddrs }, // indexed `to` as array → OR filter on topic[2]
      fromBlock: from,
      toBlock: to,
    });
    for (const lg of logs) {
      const f = (lg.args.from ?? '').toLowerCase();
      if (railFrom && f === railFrom) continue; // rail forward — already credited via fiat
      transfers.push({
        to: (lg.args.to as Address).toLowerCase(),
        from: f,
        tx_hash: lg.transactionHash,
        log_index: lg.logIndex,
        amount_wei: (lg.args.value as bigint).toString(),
        block: Number(lg.blockNumber),
      });
    }
    cursorEnd = to;
  }

  // 4. Forward to the ingest fn (idempotent on the receiver).
  let created: number | undefined;
  if (transfers.length > 0) {
    const body = JSON.stringify({ transfers });
    const id = `onchain-${cursorEnd}`;
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = await hmacSha256Base64(decodeSecret(secret)!, `${id}.${ts}.${body}`);
    const res = await fetch(base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': ts,
        'webhook-signature': `v1,${sig}`,
      },
      body,
    });
    if (!res.ok) {
      console.error(`onchain ingest POST → ${res.status}`);
      // Do NOT advance the cursor on failure — retry next run.
      return { scanned: `post_failed_${res.status}@${cursorEnd}`, found: transfers.length, posted: 0 };
    }
    const out = (await res.json()) as { created?: number };
    created = out.created;
  }

  // 5. Advance cursor only after a successful (or empty) scan.
  await env.TOKEN_CACHE.put(CURSOR_KEY, cursorEnd.toString());
  return { scanned: `${from > latest ? 'done' : 'partial'}@${cursorEnd}`, found: transfers.length, posted: transfers.length, created };
}

// --- svix / Standard Webhooks HMAC (mirrors intents/outbound.ts) -------------
function decodeSecret(secret: string): Uint8Array | null {
  const stripped = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  try {
    const bin = atob(stripped);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacSha256Base64(key: Uint8Array, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  const bytes = new Uint8Array(sig);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
