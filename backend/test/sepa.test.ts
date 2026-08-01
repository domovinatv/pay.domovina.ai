import { describe, expect, it } from 'vitest';

import { FALLBACK_SEPA, formatIban, getSepaDetails } from '../src/tenants/db';
import { buildEpcText } from '../src/intents/epc';
import type { Env } from '../src/types';

/// The SEPA leg is the account the money physically lands on. A wrong IBAN in
/// a QR is unrecoverable by any downstream check, so it gets its own tests.

const ITALK_IBAN = 'EE707777000162921128';

function envWithTenant(row: Record<string, unknown> | null): Env {
  return {
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => row }) }),
    },
  } as unknown as Env;
}

describe('formatIban', () => {
  it('groups ITalk’s IBAN exactly as printed on the checkout page', () => {
    expect(formatIban(ITALK_IBAN)).toBe('EE70 7777 0001 6292 1128');
  });

  it('is idempotent — re-formatting an already grouped IBAN does not drift', () => {
    expect(formatIban(formatIban(ITALK_IBAN))).toBe('EE70 7777 0001 6292 1128');
  });

  it('normalises the legacy oddly-spaced form to the same value', () => {
    // The pre-0016 constant carried a stray space: 'EE7077770001629211 28'.
    expect(formatIban('EE7077770001629211 28')).toBe('EE70 7777 0001 6292 1128');
  });
});

describe('getSepaDetails', () => {
  it('reads the collection account off the tenant row', async () => {
    const env = envWithTenant({
      id: 'italk',
      name: 'ITalk d.o.o.',
      status: 'active',
      allow_sources: '["wallet_registry"]',
      beneficiary_name: 'ITalk d.o.o.',
      iban: ITALK_IBAN,
      bic: 'LHVBEE22',
    });
    expect(await getSepaDetails(env, 'italk')).toEqual({
      beneficiaryName: 'ITalk d.o.o.',
      iban: ITALK_IBAN,
      bic: 'LHVBEE22',
    });
  });

  it('falls back to the hardcoded ITalk block rather than throwing on a missing row', async () => {
    // Read paths (checkout page, status endpoint) must never 500 — but the
    // fallback is only ever a display value; it decides nothing about money.
    expect(await getSepaDetails(envWithTenant(null), 'nepostojeci')).toEqual(FALLBACK_SEPA);
  });

  it('has a fallback that matches ITalk’s KYB’d Monerium account', () => {
    expect(FALLBACK_SEPA.iban).toBe(ITALK_IBAN);
    expect(FALLBACK_SEPA.bic).toBe('LHVBEE22');
  });
});

describe('EPC payload carries the tenant IBAN', () => {
  it('emits the canonical, space-free IBAN on line 7', () => {
    const epc = buildEpcText({
      beneficiaryName: 'ITalk d.o.o.',
      iban: ITALK_IBAN,
      amountEur: 1.02,
      purposeCode: 'OTHR',
      remittanceInfo: 'mpt:0x6693a7d19486dc45e9f90fd2d515d972bba2d65e?sid=abc123def456',
      bic: 'LHVBEE22',
    });
    const lines = epc.split('\n');
    expect(lines).toHaveLength(10);          // strict layout Revolut iOS accepts
    expect(lines[4]).toBe('LHVBEE22');
    expect(lines[5]).toBe('ITalk d.o.o.');
    expect(lines[6]).toBe(ITALK_IBAN);
    expect(lines[7]).toBe('EUR1.02');
  });

  it('strips spaces if a grouped IBAN ever reaches the builder', () => {
    const epc = buildEpcText({
      beneficiaryName: 'ITalk d.o.o.',
      iban: 'EE70 7777 0001 6292 1128',
      amountEur: 1,
      remittanceInfo: 'x',
      bic: 'LHVBEE22',
    });
    expect(epc.split('\n')[6]).toBe(ITALK_IBAN);
  });
});
