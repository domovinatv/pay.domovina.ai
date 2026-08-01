import { describe, expect, it } from 'vitest';

import {
  extractRoutingFromOrder,
  extractRoutingTarget,
  parseCampaignIdFromText,
  parseSidFromText,
} from '../src/monerium/sid';
import type { MoneriumOrder } from '../src/monerium/types';

const ADDR = '0x6693a7d19486dc45e9f90fd2d515d972bba2d65e';

describe('extractRoutingTarget — routable prefixes', () => {
  it('routes mpt: with a query-form sid', () => {
    const r = extractRoutingTarget(`mpt:${ADDR}?sid=abc123def456`);
    expect(r.target).toBe(ADDR);
    expect(r.prefix).toBe('mpt');
    expect(r.sid).toBe('abc123def456');
  });

  it('routes mpt: with the post-SEPA `sid.` mapping form', () => {
    // `=` is banned by the SEPA charset and arrives as `.` — verified against
    // a real LHV payload on 2026-05-21.
    const r = extractRoutingTarget(`mpt:${ADDR}?sid.yg6vbprgvqr6`);
    expect(r.target).toBe(ADDR);
    expect(r.sid).toBe('yg6vbprgvqr6');
  });

  it('routes cmp: and extracts the campaign id', () => {
    const r = extractRoutingTarget(`cmp:${ADDR}?id=kampanja-1`);
    expect(r.target).toBe(ADDR);
    expect(r.prefix).toBe('cmp');
    expect(r.campaignId).toBe('kampanja-1');
    expect(r.sid).toBeNull();
  });

  it('lowercases a checksummed address', () => {
    const r = extractRoutingTarget('mpt:0x6693a7D19486Dc45e9F90Fd2D515d972bBA2d65e?sid=wxmgcz3gem');
    expect(r.target).toBe(ADDR);
  });
});

describe('extractRoutingTarget — fail-closed on non-routable memos (ADR 0016)', () => {
  it('does NOT route a bare 0x address', () => {
    const r = extractRoutingTarget(ADDR);
    expect(r.target).toBeNull();
    expect(r.prefix).toBeNull();
    // still visible for diagnostics
    expect(r.diagnosticTarget).toBe(ADDR);
  });

  it('does NOT route a legacy gnosis: memo, even with a valid sid', () => {
    const r = extractRoutingTarget(`gnosis:${ADDR}?sid=abc123def456`);
    expect(r.target).toBeNull();
    expect(r.prefix).toBe('gnosis');
    expect(r.diagnosticTarget).toBe(ADDR);
    expect(r.sid).toBe('abc123def456');
  });

  it('does NOT route an address buried in free text', () => {
    const r = extractRoutingTarget(`Uplata za racun ${ADDR} hvala`);
    expect(r.target).toBeNull();
    expect(r.diagnosticTarget).toBe(ADDR);
  });

  it('returns nothing at all for an empty memo', () => {
    const r = extractRoutingTarget(null);
    expect(r.target).toBeNull();
    expect(r.diagnosticTarget).toBeNull();
    expect(r.prefix).toBeNull();
  });
});

describe('extractRoutingTarget — address boundary (BW-09)', () => {
  it('refuses to truncate a 64-hex string into a 40-hex address', () => {
    const txHash = `0x${'a'.repeat(64)}`;
    const r = extractRoutingTarget(`mpt:${txHash}?sid=abc123def456`);
    expect(r.target).toBeNull();
    expect(r.diagnosticTarget).toBeNull();
  });

  it('still matches a real address followed by a separator', () => {
    expect(extractRoutingTarget(`mpt:${ADDR}?sid=abc123def456`).target).toBe(ADDR);
    expect(extractRoutingTarget(`mpt:${ADDR} sid:abc123def456`).target).toBe(ADDR);
    expect(extractRoutingTarget(`mpt:${ADDR}`).target).toBe(ADDR);
  });
});

describe('extractRoutingFromOrder', () => {
  const order = (over: Partial<MoneriumOrder>): MoneriumOrder =>
    ({ id: 'o1', kind: 'issue', amount: '1.00', currency: 'eur', ...over }) as MoneriumOrder;

  it('prefers the memo when it is routable', () => {
    const r = extractRoutingFromOrder(order({
      memo: `mpt:${ADDR}?sid=abc123def456`,
      referenceNumber: `mpt:0x${'b'.repeat(40)}?sid=zzzzzzzzzzzz`,
    }));
    expect(r.target).toBe(ADDR);
    expect(r.sid).toBe('abc123def456');
  });

  it('falls back to referenceNumber when the memo is not routable', () => {
    const r = extractRoutingFromOrder(order({
      memo: 'placanje',
      referenceNumber: `mpt:${ADDR}?sid=abc123def456`,
    }));
    expect(r.target).toBe(ADDR);
  });

  it('keeps the diagnostic address when neither field is routable', () => {
    const r = extractRoutingFromOrder(order({
      memo: `gnosis:${ADDR}`,
      referenceNumber: null as unknown as string,
    }));
    expect(r.target).toBeNull();
    expect(r.diagnosticTarget).toBe(ADDR);
  });
});

describe('sid / campaign id token parsing', () => {
  it('accepts every SEPA-survival separator for sid', () => {
    for (const sep of ['=', '.', ':', '-']) {
      expect(parseSidFromText(`mpt:${ADDR}?sid${sep}abc123def456`)).toBe('abc123def456');
    }
  });

  it('does not mistake ?sid= for ?id=', () => {
    expect(parseCampaignIdFromText(`mpt:${ADDR}?sid=abc123def456`)).toBeNull();
  });

  it('reads the campaign id in both query and token form', () => {
    expect(parseCampaignIdFromText(`cmp:${ADDR}?id=kampanja-1`)).toBe('kampanja-1');
    expect(parseCampaignIdFromText(`cmp:${ADDR} id:kampanja-1`)).toBe('kampanja-1');
  });
});
