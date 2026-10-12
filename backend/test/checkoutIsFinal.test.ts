import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/// The checkout page's browser script decides when to stop watching an intent.
/// The return to the merchant's app waits for state 'paid', and the stream can
/// report stage 'settled' a moment before that, so 'settled' alone must not
/// stop polling.

type Snapshot = { state?: string; status?: { stage?: string; amount_mismatch?: string } | null };

function loadIsFinal(): (s: Snapshot) => boolean {
  const source = readFileSync(new URL('../src/checkout/page.ts', import.meta.url), 'utf8');
  const fn = source.match(/function isFinal\(s\) \{[\s\S]*?\n\}/);
  if (!fn) throw new Error('isFinal not found in the checkout page script');
  return new Function(`${fn[0]}; return isFinal;`)() as (s: Snapshot) => boolean;
}

describe('checkout isFinal', () => {
  const isFinal = loadIsFinal();

  it('keeps watching a settled intent whose state is still pending', () => {
    expect(isFinal({ state: 'pending', status: { stage: 'settled' } })).toBe(false);
  });

  it('stops once a settled intent is paid', () => {
    expect(isFinal({ state: 'paid', status: { stage: 'settled' } })).toBe(true);
  });

  it('stops on an underpaid settlement, which never turns paid', () => {
    expect(isFinal({ state: 'pending', status: { stage: 'settled', amount_mismatch: 'under' } })).toBe(true);
  });

  it('stops on a rejected payment', () => {
    expect(isFinal({ state: 'pending', status: { stage: 'rejected' } })).toBe(true);
  });

  it('keeps watching every earlier stage', () => {
    for (const stage of ['awaiting_payment', 'received_processing', 'minted', 'forwarding', 'expired']) {
      expect(isFinal({ state: 'pending', status: { stage } })).toBe(false);
    }
    expect(isFinal({ state: 'pending', status: null })).toBe(false);
  });
});
