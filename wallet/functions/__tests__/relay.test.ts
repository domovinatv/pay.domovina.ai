import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

import { MULTISEND_CALL_ONLY, predictSafeProxyAddress } from '../_lib/safe';

/// Relay handler (functions/api/relay.ts) with a fake chain: which addresses
/// hold code, and what the relayer EOA broadcast. Money-safety contract:
///   • never execTransaction on an address without code (EVM: silent success)
///   • never deploy a Safe whose CREATE2 address ≠ the safeAddress the
///     client funded (WR-02: also on the hot→cold fallback)
///   • daily / abuse caps hold even with garbage in KV (WR-04)

const chain = {
  code: new Set<string>(),
  sends: [] as Array<{ to: string; data: string }>,
  hotFails: false,
  threshold: 1n,
};

vi.mock('../_lib/relayer', async (orig) => {
  const real = await orig<typeof import('../_lib/relayer')>();
  return {
    ...real,
    loadRelayer: () => ({
      ok: true,
      clients: {
        publicClient: {
          getCode: async ({ address }: { address: string }) => (chain.code.has(address.toLowerCase()) ? '0x6080' : undefined),
          readContract: async () => chain.threshold,
        },
        wallet: {
          sendTransaction: async (tx: { to: string; data: string }) => {
            if (chain.hotFails && tx.to.toLowerCase() !== MULTISEND_CALL_ONLY.toLowerCase()) throw new Error('execution reverted');
            chain.sends.push(tx);
            return '0x' + 'ab'.repeat(32);
          },
        },
      },
    }),
  };
});

const { onRequestPost } = await import('../api/relay');

const SIGNER = '0x06a300d779999b51385f23cc1e002f24954751f1' as Address;
const RECOVERY = '0x39c86046038ba132f1bcdb4b5b35bb33511dd72c' as Address;
const DERIVED_SAFE = predictSafeProxyAddress([SIGNER, RECOVERY], 0n);
const SOLO_SAFE = predictSafeProxyAddress([SIGNER], 0n);
const OTHER = '0x' + '77'.repeat(20);

function kv(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => { m.set(k, v); },
    m,
  } as unknown as KVNamespace & { m: Map<string, string> };
}

function call(body: Record<string, unknown>, store = kv()) {
  const request = new Request('https://wallet.domovina.ai/api/relay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7' },
    body: JSON.stringify({
      safeAddress: SOLO_SAFE, signerAddress: SIGNER, pubKeyX: '1', pubKeyY: '2',
      to: OTHER, value: '0', data: '0x', signature: '0x00',
      ...body,
    }),
  });
  return onRequestPost({ request, env: { RELAY_KV: store, RELAYER_PRIVATE_KEY: '0x' + '11'.repeat(32) } } as never);
}

beforeEach(() => {
  chain.code = new Set();
  chain.sends = [];
  chain.hotFails = false;
  chain.threshold = 1n;
});

describe('relay — undeployed Safe (cold path)', () => {
  it('deploys + sends atomically through MultiSend, never a bare execTransaction', async () => {
    const res = await call({});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, deployed: true });
    expect(chain.sends).toHaveLength(1);
    expect(chain.sends[0].to.toLowerCase()).toBe(MULTISEND_CALL_ONLY.toLowerCase());
  });

  it('refuses a safeAddress that is not the CREATE2 address of its owners — nothing broadcast', async () => {
    const res = await call({ safeAddress: OTHER.replace('77', '88') });
    expect(res.status).toBe(400);
    expect(chain.sends).toHaveLength(0);
  });

  it('derived account: 2-owner initializer must match too', async () => {
    expect((await call({ safeAddress: DERIVED_SAFE, recoveryOwner: RECOVERY })).status).toBe(200);
    chain.sends = [];
    expect((await call({ safeAddress: DERIVED_SAFE })).status).toBe(400); // forgot the recovery owner
    expect(chain.sends).toHaveLength(0);
  });
});

describe('relay — deployed Safe (hot path)', () => {
  it('execTransaction straight on the Safe', async () => {
    chain.code.add(SOLO_SAFE.toLowerCase());
    chain.code.add(SIGNER.toLowerCase());
    const res = await call({});
    expect(await res.json()).toMatchObject({ ok: true, deployed: false });
    expect(chain.sends[0].to.toLowerCase()).toBe(SOLO_SAFE.toLowerCase());
  });

  it('threshold > 1 → 409 with an explanation, not an opaque revert', async () => {
    chain.code.add(SOLO_SAFE.toLowerCase());
    chain.code.add(SIGNER.toLowerCase());
    chain.hotFails = true;
    chain.threshold = 2n;
    expect((await call({})).status).toBe(409);
  });

  it('WR-02: hot fails, RPC now says the Safe is NOT deployed, address mismatch → 400, no deploy', async () => {
    // Pre-flight saw code (stale/lying RPC), later reads see none.
    const bogus = '0x' + '99'.repeat(20);
    let reads = 0;
    chain.code.add(bogus);
    const realHas = chain.code.has.bind(chain.code);
    chain.code.has = (a: string) => (a === bogus ? reads++ === 0 : realHas(a));
    chain.hotFails = true;
    const res = await call({ safeAddress: bogus });
    expect(res.status).toBe(400);
    expect(chain.sends).toHaveLength(0);
  });
});

describe('relay — limits', () => {
  it('5 free relays per signer per day, then 429', async () => {
    const store = kv();
    chain.code.add(SOLO_SAFE.toLowerCase());
    chain.code.add(SIGNER.toLowerCase());
    for (let i = 0; i < 5; i++) expect((await call({}, store)).status).toBe(200);
    expect((await call({}, store)).status).toBe(429);
  });

  it('WR-04: garbage in the counter is not "unlimited"', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const store = kv({ [`relay:${SIGNER.toLowerCase()}:${day}`]: 'NaN-garbage' });
    chain.code.add(SOLO_SAFE.toLowerCase());
    chain.code.add(SIGNER.toLowerCase());
    // A corrupted counter counts as exhausted, never as zero-and-forever.
    expect((await call({}, store)).status).toBe(429);
  });

  it('input validation: stub pubkey, safe === signer, bad saltNonce → 400 before any chain work', async () => {
    expect((await call({ pubKeyX: '0' })).status).toBe(400);
    expect((await call({ safeAddress: SIGNER })).status).toBe(400);
    expect((await call({ saltNonce: 'x' })).status).toBe(400);
    expect(chain.sends).toHaveLength(0);
  });
});
