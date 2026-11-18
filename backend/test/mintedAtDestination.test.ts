import { describe, expect, it } from 'vitest';

import { markMintedAtDestination, type MintedDirectDeps } from '../src/monerium/offrail';
import type { MoneriumOrder } from '../src/monerium/types';

/// Forward #92 (11. 10. 2026.): Monerium je mintao 1,00 EURe izravno na
/// adresu iz reference, ne na MPT Safe; gate ga je blokirao
/// (`mint_address_mismatch`). Zatvara se bez micanja novca, uz provjeru minta na lancu.

const DEST = '0x4f7f1950b2cb6713ccb47b869f30c0ebc01d0173';
const SAFE = '0x449abcef4e29a7dd8d98db451af2c463561baf2e';
const TX = '0xeeef39678cd2071f7e559a143c3f9966c3047913b0fc102b721b9d6453243f56';
const EUR = (cents: number) => BigInt(cents) * 10n ** 16n;

const order = (over: Partial<MoneriumOrder> = {}): MoneriumOrder => ({
  id: 'd1f51056-c5ba-11f1-a7ec-ea2c7f719632',
  kind: 'issue',
  state: 'processed',
  amount: '1',
  currency: 'eur',
  address: '0x4f7f1950B2CB6713CcB47b869F30C0ebc01d0173',
  memo: 'gnosis:0x4f7f1950B2CB6713CcB47b869F30C0ebc01d0173 sid:test1',
  meta: { txHashes: [TX] },
  ...over,
}) as unknown as MoneriumOrder;

function harness(over: Partial<MintedDirectDeps> = {}) {
  const rec = { rows: [] as Array<Parameters<MintedDirectDeps['record']>[0]>, audits: [] as Array<Record<string, unknown>>, alerts: [] as string[] };
  const used: number[] = [];
  const deps: MintedDirectDeps = {
    safe: SAFE,
    getForwardByOrder: async () => ({ status: 'blocked' }),
    mintsIn: async () => [{ logIndex: 29, to: DEST, valueWei: EUR(100) }],
    usedLegs: async () => used,
    record: async (row) => { rec.rows.push(row); used.push(row.logIndex); return 240; },
    audit: async (d) => { rec.audits.push(d); },
    alert: async (t) => { rec.alerts.push(t); },
    ...over,
  };
  return { deps, rec };
}

describe('markMintedAtDestination', () => {
  it('zatvara blokirani order kad je mint na lancu točno na adresu i iznos ordera', async () => {
    const { deps, rec } = harness();
    const r = await markMintedAtDestination(deps, order(), 'ms@ff.hr');
    expect(r).toEqual({ ok: true, forwardId: 240, to: DEST, txHash: TX, logIndex: 29 });
    expect(rec.rows[0]).toMatchObject({ orderId: order().id, txHash: TX, logIndex: 29, to: DEST, amountCents: 100, valueWei: EUR(100) });
    expect(rec.audits[0]).toMatchObject({ kind: 'minted_at_destination', previous_status: 'blocked', actor: 'ms@ff.hr' });
    expect(rec.alerts[0]).toContain('mint je već na odredištu');
  });

  it('isti mint leg ne zatvara drugi order', async () => {
    const { deps } = harness();
    expect((await markMintedAtDestination(deps, order(), 'a')).ok).toBe(true);
    expect(await markMintedAtDestination(deps, order({ id: 'ord-2' }), 'a')).toEqual({ ok: false, error: 'no_mint_to_address' });
  });

  it('odbija: mint na Safe (novac JE u Safeu → reroute), drugi iznos, druga adresa, pao tx', async () => {
    expect(await markMintedAtDestination(harness().deps, order({ address: SAFE }), 'a')).toEqual({ ok: false, error: 'minted_to_safe' });
    expect(await markMintedAtDestination(harness({ mintsIn: async () => [{ logIndex: 1, to: DEST, valueWei: EUR(99) }] }).deps, order(), 'a'))
      .toEqual({ ok: false, error: 'no_mint_to_address' });
    expect(await markMintedAtDestination(harness({ mintsIn: async () => [{ logIndex: 1, to: SAFE, valueWei: EUR(100) }] }).deps, order(), 'a'))
      .toEqual({ ok: false, error: 'no_mint_to_address' });
    expect(await markMintedAtDestination(harness({ mintsIn: async () => null }).deps, order(), 'a')).toEqual({ ok: false, error: 'no_mint_to_address' });
    expect(await markMintedAtDestination(harness().deps, order({ address: undefined }), 'a')).toEqual({ ok: false, error: 'no_mint_address' });
  });

  it('samo parkirani orderi: živ, riješen ili bez forwarda se ne dira', async () => {
    expect(await markMintedAtDestination(harness({ getForwardByOrder: async () => ({ status: 'confirmed' }) }).deps, order(), 'a')).toEqual({ ok: false, error: 'already_forwarded' });
    expect(await markMintedAtDestination(harness({ getForwardByOrder: async () => ({ status: 'resolved_offrail' }) }).deps, order(), 'a')).toEqual({ ok: false, error: 'already_resolved' });
    expect(await markMintedAtDestination(harness({ getForwardByOrder: async () => null }).deps, order(), 'a')).toEqual({ ok: false, error: 'not_parked' });
    expect(await markMintedAtDestination(harness().deps, order({ state: 'pending' } as Partial<MoneriumOrder>), 'a')).toEqual({ ok: false, error: 'not_processed' });
  });
});
