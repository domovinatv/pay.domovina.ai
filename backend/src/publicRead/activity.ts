import { Hono } from 'hono';

import { gnosisRpc, type RpcRequest } from '../chain/gnosisRpc';
import type { Env } from '../types';
import { edgeCached, MissLimited, workerEdgeDeps } from './edgeCache';

/// Incoming EURe on one address, read from the chain on the page's behalf and
/// edge-cached (ADR 0030). The chain stays the source of truth: these are the
/// same Blockscout rows Gnosisscan shows people, and every row carries its tx
/// hash so a page links each one to the explorer. What this buys is one
/// upstream call per address per FRESH_S per data centre, instead of one per
/// open tab — at a fair, hundreds of phones behind one NAT would otherwise
/// hit Blockscout's per-IP limit.
///
/// Gnosis (chain 100) only: sandbox pages keep reading Chiado directly.

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
/// 10 pages of 50 = 500 payments, the same cap the page used.
export const ACTIVITY_MAX_PAGES = 10;
const DEFAULT_BLOCKSCOUT = 'https://gnosisscan.io/api/v2';

export interface ActivityTransfer {
  hash: string;
  timestamp: string;
  value: string;
}

export interface Activity {
  transfers: ActivityTransfer[];
  /// `balanceOf` from the RPC (Blockscout's token-balances lags transfers by
  /// hours); null when the RPC did not answer — the page then falls back.
  balance_wei: string | null;
  truncated: boolean;
}

interface TransferPage {
  items: Array<{ transaction_hash: string; timestamp: string; total: { value: string } }>;
  next_page_params: Record<string, string | number> | null;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function hexBalance(result: unknown): string | null {
  return typeof result === 'string' && /^0x[0-9a-fA-F]*$/.test(result)
    ? BigInt(result === '0x' ? 0 : result).toString()
    : null;
}

async function balanceOf(rpcUrl: string, token: string, owner: string, fetchFn: Fetch, rpc?: RpcRequest): Promise<string | null> {
  const data = `0x70a08231${owner.slice(2).toLowerCase().padStart(64, '0')}`;
  if (rpc) return hexBalance(await rpc('eth_call', [{ to: token, data }, 'latest']));
  const res = await fetchFn(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: token, data }, 'latest'] }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { result?: unknown };
  return hexBalance(body.result);
}

export async function loadActivity(
  /// `rpc`, when given, carries `balanceOf` (own node first, ADR 0031).
  cfg: { blockscoutApi: string; rpcUrl: string; eure: string; rpc?: RpcRequest },
  address: string,
  fetchFn: Fetch = fetch,
): Promise<Activity> {
  const base = `${cfg.blockscoutApi}/addresses/${address}/token-transfers?type=ERC-20&filter=to&token=${cfg.eure}`;
  const transfers: ActivityTransfer[] = [];
  let next: TransferPage['next_page_params'] = null;
  let pages = 0;
  do {
    const query = next
      ? '&' + new URLSearchParams(Object.entries(next).map(([k, v]): [string, string] => [k, String(v)])).toString()
      : '';
    const res = await fetchFn(base + query, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`blockscout ${res.status}`);
    const page = (await res.json()) as TransferPage;
    for (const item of page.items) {
      transfers.push({ hash: item.transaction_hash, timestamp: item.timestamp, value: item.total.value });
    }
    next = page.next_page_params;
    pages += 1;
  } while (next && pages < ACTIVITY_MAX_PAGES);
  const balance_wei = await balanceOf(cfg.rpcUrl, cfg.eure, address, fetchFn, cfg.rpc).catch(() => null);
  return { transfers, balance_wei, truncated: next !== null };
}

export function buildActivityApi() {
  const api = new Hono<{ Bindings: Env }>();
  api.get('/:address', async (c) => {
    const address = c.req.param('address');
    if (!ADDR_RE.test(address)) return c.json({ error: 'invalid_address' }, 400);
    const addr = address.toLowerCase();
    const cfg = {
      blockscoutApi: c.env.BLOCKSCOUT_API || DEFAULT_BLOCKSCOUT,
      rpcUrl: c.env.GNOSIS_RPC_URL,
      eure: c.env.EURE_CONTRACT,
      rpc: gnosisRpc(c.env, c.env.GNOSIS_RPC_URL),
    };
    try {
      const body = await edgeCached(
        workerEdgeDeps(c.env, c.req.raw, c.executionCtx),
        `${new URL(c.req.url).origin}/api/activity/${addr}`,
        async () => JSON.stringify(await loadActivity(cfg, addr)),
      );
      c.header('Cache-Control', 'public, max-age=5');
      c.header('Content-Type', 'application/json');
      return c.body(body);
    } catch (e) {
      if (e instanceof MissLimited) return c.json({ error: 'rate_limited' }, 429);
      return c.json({ error: 'upstream_unavailable' }, 502);
    }
  });
  return api;
}
