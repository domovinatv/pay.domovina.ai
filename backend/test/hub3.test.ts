import { describe, expect, it } from 'vitest';

import { buildHub3Text, hub3Text } from '../src/intents/hub3';
import { extractRoutingTarget, parseSidFromText } from '../src/monerium/sid';

/// HUB3 v6 spec (HUB, rujan 2022) + four real bills, see
/// docs/research/aircash/05-hub3-format-provjera.md.

const ITALK = { beneficiaryName: 'ITalk d.o.o.', iban: 'EE707777000162921128' };

describe('buildHub3Text', () => {
  it('emits 14 fields, each terminated by LF (spec: graničnik after every field)', () => {
    const out = buildHub3Text({ ...ITALK, amountEur: 1.02, purposeCode: 'OTHR', description: 'Lukavec' })!;
    expect(out.endsWith('\n')).toBe(true);
    expect(out.split('\n')).toEqual([
      'HRVHUB30',
      'EUR',
      '000000000000102',
      '',
      '',
      '',
      'ITalk d.o.o.',
      '',
      '',
      'EE707777000162921128',
      'HR99',
      '',
      'OTHR',
      'Lukavec',
      '', // after the final LF
    ]);
  });

  it('matches the layout of a real HEP bill field by field', () => {
    // Shape of a real HEP bill (payer block blanked, customer reference replaced).
    const out = buildHub3Text({
      beneficiaryName: 'HEP-OPSKRBA D.O.O.',
      beneficiaryStreet: 'Ulica grada Vukovara 37',
      beneficiaryCity: '10000 Zagreb',
      iban: 'HR2523600001102100146',
      amountEur: 46.56,
      model: 'HR01',
      reference: '0012345678-260820-1',
      purposeCode: 'ELEC',
      description: 'Racun za 8.2026',
    });
    expect(out).toBe(
      'HRVHUB30\nEUR\n000000000004656\n\n\n\nHEP-OPSKRBA D.O.O.\nUlica grada Vukovara 37\n10000 Zagreb\n' +
        'HR2523600001102100146\nHR01\n0012345678-260820-1\nELEC\nRacun za 8.2026\n',
    );
  });

  it('accepts an EE IBAN (20 chars fits the 21-char field) and refuses longer ones', () => {
    expect(buildHub3Text({ ...ITALK, amountEur: 1 })).not.toBeNull();
    expect(buildHub3Text({ ...ITALK, iban: 'DE89370400440532013000', amountEur: 1 })).toBeNull();
  });

  it('refuses amounts that are not positive', () => {
    expect(buildHub3Text({ ...ITALK, amountEur: 0 })).toBeNull();
    expect(buildHub3Text({ ...ITALK, amountEur: -1 })).toBeNull();
  });

  it('drops the reference when the model is HR99 (no reference)', () => {
    const lines = buildHub3Text({ ...ITALK, amountEur: 1, model: 'HR99', reference: '123' })!.split('\n');
    expect(lines[10]).toBe('HR99');
    expect(lines[11]).toBe('');
  });

  it('cuts every field to its spec length', () => {
    const lines = buildHub3Text({
      beneficiaryName: 'A very long beneficiary name d.o.o.',
      iban: ITALK.iban,
      amountEur: 1,
      description: 'x'.repeat(80),
    })!.split('\n');
    expect(lines[6].length).toBeLessThanOrEqual(25);
    expect(lines[13]).toHaveLength(35);
  });
});

describe('hub3Text', () => {
  it('writes Croatian letters without diacritics, as real bills do', () => {
    expect(hub3Text('Južna obala, Čistoća Đakovo', 99)).toBe('Juzna obala, Cistoca Dakovo');
  });

  it('replaces characters outside the spec set and collapses spaces', () => {
    expect(hub3Text('a=b & c_d   e@f', 99)).toBe('a b c d e f');
  });
});

describe('HUB3 description vs routing', () => {
  it('the default description is a stray, not an unroutable sid/address memo', () => {
    const desc = buildHub3Text({ ...ITALK, amountEur: 1, description: 'Uplata' })!.split('\n')[13];
    const r = extractRoutingTarget(desc);
    expect(r.diagnosticTarget).toBeNull();
    expect(parseSidFromText(desc)).toBeNull();
  });
});
