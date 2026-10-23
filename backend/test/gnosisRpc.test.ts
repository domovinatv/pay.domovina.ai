import { beforeEach, describe, expect, it } from 'vitest';
import { createPublicClient } from 'viem';
import { gnosis } from 'viem/chains';

import { gnosisRpc, readTransport, resetGnosisRpcHealth, RpcCallError } from '../src/chain/gnosisRpc';
import type { Env } from '../src/types';

/// ADR 0031: server-side Gnosis reads hit the own node first (Access token
/// headers), and fall back to the public RPC whenever the node is down,
/// refused, syncing, or rejects the method. Reverts are not retried.

const OWN = 'https://acutis-rpc.test';
const PUB = 'https://rpc.test';
const env = { ACUTIS_RPC_URL: OWN, CF_ACCESS_CLIENT_ID: 'id.access', CF_ACCESS_CLIENT_SECRET: 's3cret' } as unknown as Env;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

type Handler = (method: string, init?: RequestInit) => Response | Promise<Response>;

function net(own: Handler, pub: Handler = (m) => json({ jsonrpc: '2.0', id: 1, result: `pub:${m}` })) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    calls.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url === OWN) return own(method, init);
    if (url === PUB) return pub(method, init);
    throw new Error(`unexpected ${url}`);
  };
  return { fetchFn, calls };
}

const synced: Handler = (m) => json({ jsonrpc: '2.0', id: 1, result: m === 'eth_syncing' ? false : `own:${m}` });

describe('gnosisRpc', () => {
  beforeEach(() => resetGnosisRpcHealth());

  it('reads from the own node with the Access headers once it reports synced', async () => {
    const { fetchFn, calls } = net(synced);
    const rpc = gnosisRpc(env, PUB, fetchFn);
    expect(await rpc('eth_blockNumber', [])).toBe('own:eth_blockNumber');
    expect(await rpc('eth_chainId', [])).toBe('own:eth_chainId');
    // One health check per TTL, not per call.
    expect(calls.map((c) => c.method)).toEqual(['eth_syncing', 'eth_blockNumber', 'eth_chainId']);
    expect(calls[1].headers['CF-Access-Client-Id']).toBe('id.access');
    expect(calls[1].headers['CF-Access-Client-Secret']).toBe('s3cret');
  });

  it('never sends the Access headers to the fallback', async () => {
    const { fetchFn, calls } = net(() => new Response('<html>Forbidden</html>', { status: 403 }));
    expect(await gnosisRpc(env, PUB, fetchFn)('eth_blockNumber', [])).toBe('pub:eth_blockNumber');
    const pub = calls.filter((c) => c.url === PUB);
    expect(pub).toHaveLength(1);
    expect(pub[0].headers['CF-Access-Client-Secret']).toBeUndefined();
  });

  it('skips a syncing node until the health verdict expires', async () => {
    let t = 0;
    let syncing: unknown = { currentBlock: '0x1', highestBlock: '0x9' };
    const own: Handler = (m) => json({ jsonrpc: '2.0', id: 1, result: m === 'eth_syncing' ? syncing : `own:${m}` });
    const { fetchFn, calls } = net(own);
    const rpc = gnosisRpc(env, PUB, fetchFn, () => t);
    expect(await rpc('eth_blockNumber', [])).toBe('pub:eth_blockNumber');
    expect(await rpc('eth_blockNumber', [])).toBe('pub:eth_blockNumber');
    expect(calls.filter((c) => c.method === 'eth_syncing')).toHaveLength(1);
    syncing = false;
    t = 61_000;
    expect(await rpc('eth_blockNumber', [])).toBe('own:eth_blockNumber');
  });

  it('falls back when the own node is unreachable, and stops asking it for the TTL', async () => {
    let up = true;
    const own: Handler = (m) => {
      if (m !== 'eth_syncing' && !up) throw new TypeError('fetch failed');
      return synced(m);
    };
    const { fetchFn, calls } = net(own);
    const rpc = gnosisRpc(env, PUB, fetchFn, () => 0);
    expect(await rpc('eth_blockNumber', [])).toBe('own:eth_blockNumber');
    up = false;
    expect(await rpc('eth_blockNumber', [])).toBe('pub:eth_blockNumber');
    const before = calls.filter((c) => c.url === OWN).length;
    expect(await rpc('eth_blockNumber', [])).toBe('pub:eth_blockNumber');
    expect(calls.filter((c) => c.url === OWN).length).toBe(before);
  });

  it('retries a refused method or range on the fallback', async () => {
    const own: Handler = (m) =>
      m === 'eth_syncing'
        ? json({ jsonrpc: '2.0', id: 1, result: false })
        : json({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Logs request reads 20000 blocks without the log index' } });
    const { fetchFn } = net(own);
    expect(await gnosisRpc(env, PUB, fetchFn)('eth_getLogs', [{}])).toBe('pub:eth_getLogs');
  });

  it('passes a revert through without asking the fallback', async () => {
    const own: Handler = (m) =>
      m === 'eth_syncing'
        ? json({ jsonrpc: '2.0', id: 1, result: false })
        : json({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data: '0x08c379a0' } });
    const { fetchFn, calls } = net(own);
    const err = await gnosisRpc(env, PUB, fetchFn)('eth_call', [{}, 'latest']).catch((e) => e);
    expect(err).toBeInstanceOf(RpcCallError);
    expect((err as RpcCallError).code).toBe(3);
    expect((err as RpcCallError).data).toBe('0x08c379a0');
    expect(calls.some((c) => c.url === PUB)).toBe(false);
  });

  it('without the Access secrets uses only the fallback', async () => {
    const { fetchFn, calls } = net(synced);
    const bare = { GNOSIS_RPC_URL: PUB } as unknown as Env;
    expect(await gnosisRpc(bare, PUB, fetchFn)('eth_blockNumber', [])).toBe('pub:eth_blockNumber');
    expect(calls.every((c) => c.url === PUB)).toBe(true);
  });
});

describe('readTransport', () => {
  beforeEach(() => resetGnosisRpcHealth());

  it('drives a viem public client through the own node', async () => {
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const { method } = JSON.parse(String(init?.body)) as { method: string };
      seen.push(`${url} ${method}`);
      return json({ jsonrpc: '2.0', id: 1, result: method === 'eth_syncing' ? false : '0x2ea1bde' });
    }) as typeof fetch;
    try {
      const client = createPublicClient({ chain: gnosis, transport: readTransport(env, 'gnosis', PUB) });
      expect(await client.getBlockNumber()).toBe(48896990n);
      expect(seen).toEqual([`${OWN} eth_syncing`, `${OWN} eth_blockNumber`]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('keeps Chiado on its own URL', () => {
    const t = readTransport(env, 'chiado', 'https://rpc.chiadochain.net')({ chain: undefined });
    expect(t.config.type).toBe('http');
  });
});
