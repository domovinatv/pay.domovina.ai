import { custom, http, type Transport } from 'viem';

import type { Env } from '../types';

/// Server-side Gnosis reads go to our own node first (ADR 0031): Nethermind on
/// the i9, published as `acutis-rpc.mpt.hr` through a Cloudflare Tunnel and
/// guarded by Cloudflare Access (service token `eure-reader`). The public RPC
/// the rail already knows (`rpcUrl`) stays the fallback, so a node that is
/// down, unreachable or still syncing costs latency, never a failed read.
///
/// Reads only. Wallet clients (writes) keep `http(rpcUrl)`, and `rpcUrl`
/// itself stays public: the setup dapp puts it into the browser's CSP and
/// calls it from the page, which must never hold the Access token.
///
/// Chiado has no own node, so it always uses `rpcUrl`.

export const ACUTIS_RPC_DEFAULT = 'https://acutis-rpc.mpt.hr';
/// One slow own-node call must not double the latency of every read.
const PRIMARY_TIMEOUT_MS = 4_000;
/// How long an `eth_syncing` verdict holds per isolate.
const HEALTH_TTL_MS = 60_000;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export type RpcRequest = (method: string, params?: unknown) => Promise<unknown>;

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface Primary {
  url: string;
  headers: Record<string, string>;
}

function primaryOf(env: Env): Primary | null {
  const id = env.CF_ACCESS_CLIENT_ID?.trim();
  const secret = env.CF_ACCESS_CLIENT_SECRET?.trim();
  if (!id || !secret) return null;
  return {
    url: env.ACUTIS_RPC_URL || ACUTIS_RPC_DEFAULT,
    headers: { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret },
  };
}

/// Thrown for a JSON-RPC error the node answered on purpose: a revert is a
/// revert on every node, so it is passed through instead of retried.
export class RpcCallError extends Error implements RpcError {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/// Reverts and VM errors (Nethermind: 3, -32015; geth-style: "execution
/// reverted"). Anything else from the own node — method not found, range
/// limits, internal errors — is retried on the fallback.
function isExecutionError(e: RpcError): boolean {
  return e.code === 3 || e.code === -32015 || /revert/i.test(e.message);
}

async function post(
  fetchFn: Fetch,
  url: string,
  headers: Record<string, string>,
  method: string,
  params: unknown,
  timeoutMs?: number,
): Promise<{ result?: unknown; error?: RpcError }> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  // Access answers a bad or missing token with 403 HTML, not JSON-RPC.
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: RpcError };
  if (!body || typeof body !== 'object' || (!('result' in body) && !body.error)) {
    throw new Error(`${url} not a JSON-RPC response`);
  }
  return body;
}

/// Per-isolate verdict on the own node. A syncing node answers with stale
/// state and no error, so it is skipped until it reports `eth_syncing: false`.
let health: { url: string; ok: boolean; until: number } | null = null;

/// For tests.
export function resetGnosisRpcHealth(): void {
  health = null;
}

async function primaryHealthy(p: Primary, fetchFn: Fetch, now: number): Promise<boolean> {
  if (health && health.url === p.url && health.until > now) return health.ok;
  let ok = false;
  try {
    const body = await post(fetchFn, p.url, p.headers, 'eth_syncing', [], PRIMARY_TIMEOUT_MS);
    ok = body.result === false;
  } catch {
    ok = false;
  }
  health = { url: p.url, ok, until: now + HEALTH_TTL_MS };
  return ok;
}

/// One JSON-RPC request: own node first, `fallbackUrl` second.
export function gnosisRpc(
  env: Env,
  fallbackUrl: string,
  fetchFn: Fetch = fetch,
  now: () => number = Date.now,
): RpcRequest {
  const primary = primaryOf(env);
  return async (method, params) => {
    if (primary && (await primaryHealthy(primary, fetchFn, now()))) {
      try {
        const body = await post(fetchFn, primary.url, primary.headers, method, params, PRIMARY_TIMEOUT_MS);
        if (!body.error) return body.result;
        if (isExecutionError(body.error)) throw new RpcCallError(body.error.code, body.error.message, body.error.data);
        console.warn(`acutis ${method}: ${body.error.code} ${body.error.message}; using fallback`);
      } catch (e) {
        if (e instanceof RpcCallError) throw e;
        console.warn(`acutis ${method}: ${(e as Error).message}; using fallback`);
        // Unreachable or refused: skip the own node for the rest of the TTL.
        health = { url: primary.url, ok: false, until: now() + HEALTH_TTL_MS };
      }
    }
    const body = await post(fetchFn, fallbackUrl, {}, method, params);
    if (body.error) throw new RpcCallError(body.error.code, body.error.message, body.error.data);
    return body.result;
  };
}

/// viem transport for a server-side public client. Gnosis goes through
/// `gnosisRpc`; Chiado, or a Worker without the Access token, is plain
/// `http(rpcUrl)` as before.
export function readTransport(env: Env, chain: 'gnosis' | 'chiado', rpcUrl: string): Transport {
  if (chain !== 'gnosis' || !primaryOf(env)) return http(rpcUrl);
  const request = gnosisRpc(env, rpcUrl);
  return custom({ request: ({ method, params }) => request(method, params) });
}
