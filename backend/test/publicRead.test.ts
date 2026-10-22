import { describe, expect, it } from 'vitest';

import { edgeCached, FRESH_S, MissLimited, type EdgeCache, type EdgeCacheDeps } from '../src/publicRead/edgeCache';
import { ACTIVITY_MAX_PAGES, loadActivity } from '../src/publicRead/activity';

/// ADR 0030: public reads go through the edge cache, so a crowd watching a
/// campaign never reaches D1 (or Blockscout) more than once per key per FRESH_S.

const KEY = 'https://mpt.domovina.ai/api/payers/0xabc';

function memoryCache() {
  const store = new Map<string, Response>();
  const cache: EdgeCache = {
    match: async (req) => store.get(req.url)?.clone(),
    put: async (req, res) => void store.set(req.url, res),
  };
  return { cache, store };
}

function harness(over: Partial<EdgeCacheDeps> = {}) {
  const pending: Promise<unknown>[] = [];
  let clock = 1_000_000;
  let loads = 0;
  let misses = 0;
  const deps: EdgeCacheDeps = {
    cache: memoryCache().cache,
    waitUntil: (p) => void pending.push(p),
    now: () => clock,
    allowMiss: async () => (misses += 1, true),
    ...over,
  };
  const load = async () => `L${(loads += 1)}`;
  return {
    deps,
    get: () => edgeCached(deps, KEY, load),
    tick: (ms: number) => void (clock += ms),
    loads: () => loads,
    misses: () => misses,
    settle: () => Promise.all(pending.splice(0)),
  };
}

describe('edgeCached', () => {
  it('serves from the cache while fresh', async () => {
    const h = harness();
    expect(await h.get()).toBe('L1');
    h.tick(FRESH_S * 1000 - 1);
    expect(await h.get()).toBe('L1');
    expect(h.loads()).toBe(1);
  });

  it('serves a stale entry once and refreshes it in the background', async () => {
    const h = harness();
    await h.get();
    h.tick(FRESH_S * 1000);
    expect(await h.get()).toBe('L1');
    await h.settle();
    expect(await h.get()).toBe('L2');
    expect(h.loads()).toBe(2);
  });

  it('coalesces concurrent cold misses into one load (each request still counts against its IP)', async () => {
    const h = harness();
    const bodies = await Promise.all(Array.from({ length: 20 }, () => h.get()));
    expect(new Set(bodies)).toEqual(new Set(['L1']));
    expect(h.loads()).toBe(1);
    expect(h.misses()).toBe(20);
  });

  it('refuses a cold miss over the limit, but never a hit or a stale refresh', async () => {
    let allow = true;
    const h = harness({ allowMiss: async () => allow });
    await h.get();
    allow = false;
    h.tick(FRESH_S * 1000);
    expect(await h.get()).toBe('L1');
    await h.settle();
    expect(h.loads()).toBe(2);
    const cold = harness({ cache: memoryCache().cache, allowMiss: async () => false });
    await expect(cold.get()).rejects.toBeInstanceOf(MissLimited);
    expect(cold.loads()).toBe(0);
  });

  it('works without a cache (local dev, tests)', async () => {
    const h = harness({ cache: null });
    await h.get();
    await h.get();
    expect(h.loads()).toBe(2);
  });
});

describe('loadActivity', () => {
  const cfg = { blockscoutApi: 'https://bs.test/api/v2', rpcUrl: 'https://rpc.test', eure: '0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430' };
  const SAFE = '0x4f7f1950b2cb6713ccb47b869f30c0ebc01d0173';
  const item = (n: number) => ({ transaction_hash: `0x${n}`, timestamp: '2026-10-21T18:50:25Z', total: { value: '1030000000000000000' } });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it('follows pages, reads balanceOf from the RPC and keeps tx hashes', async () => {
    const urls: string[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      urls.push(url);
      if (url === cfg.rpcUrl) {
        const body = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
        expect(body.params[0].data).toBe(`0x70a08231${SAFE.slice(2).padStart(64, '0')}`);
        return json({ result: '0x' + (2060000000000000000n).toString(16) });
      }
      return url.includes('block_number=1')
        ? json({ items: [item(2)], next_page_params: null })
        : json({ items: [item(1)], next_page_params: { block_number: 1, index: 0 } });
    };
    const a = await loadActivity(cfg, SAFE, fetchFn);
    expect(a.transfers.map((t) => t.hash)).toEqual(['0x1', '0x2']);
    expect(a.balance_wei).toBe('2060000000000000000');
    expect(a.truncated).toBe(false);
    expect(urls[0]).toContain(`/addresses/${SAFE}/token-transfers?type=ERC-20&filter=to&token=${cfg.eure}`);
  });

  it('caps pages and reports truncation; a dead RPC leaves balance null', async () => {
    let pages = 0;
    const fetchFn = async (url: string) =>
      url === cfg.rpcUrl
        ? new Response('down', { status: 503 })
        : json({ items: [item((pages += 1))], next_page_params: { block_number: pages, index: 0 } });
    const a = await loadActivity(cfg, SAFE, fetchFn);
    expect(a.transfers).toHaveLength(ACTIVITY_MAX_PAGES);
    expect(a.truncated).toBe(true);
    expect(a.balance_wei).toBeNull();
  });

  it('fails when Blockscout fails, so the cache keeps the last good body', async () => {
    await expect(loadActivity(cfg, SAFE, async () => new Response('', { status: 429 }))).rejects.toThrow('blockscout 429');
  });
});
