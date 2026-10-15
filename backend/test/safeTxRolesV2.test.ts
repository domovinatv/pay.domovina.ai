import { describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs shared with the safe-tx generators and tools/funding
import * as rv2 from '../safe-tx/lib/roles-v2.mjs';

const A = '0x4f7f1950b2cb6713ccb47b869f30c0ebc01d0173';
const B = '0x346230f2748745a1d19550969f0b239f3d2b5896';
const SAFE = '0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e';

describe('Roles v2 enums (verified against mastercopy 0x9646…D337 Types.sol)', () => {
  it('match the deployed contract', () => {
    expect(rv2.ParameterType).toEqual({ None: 0, Static: 1, Dynamic: 2, Tuple: 3, Array: 4, Calldata: 5, AbiEncoded: 6 });
    expect(rv2.Operator).toMatchObject({ Pass: 0, And: 1, Or: 2, Nor: 3, Matches: 5, EqualTo: 16, GreaterThan: 17, LessThan: 18 });
    expect(rv2.ExecutionOptions).toEqual({ None: 0, Send: 1, DelegateCall: 2, Both: 3 });
    expect(rv2.TRANSFER_SELECTOR).toBe('0xa9059cbb');
    expect(rv2.roleKeyOf('EUReForwarder')).toBe('0x45555265466f7277617264657200000000000000000000000000000000000000');
  });
});

describe('transferRecipientConditions (ADR 0026 tree)', () => {
  it('Or node has paramType None and EqualTo leaves under [1], BFS order', () => {
    const c = rv2.transferRecipientConditions(rv2.normaliseRecipients([A, B]));
    expect(c.map((n: { parent: number }) => n.parent)).toEqual([0, 0, 0, 1, 1]);
    expect(c[0]).toMatchObject({ paramType: 5, operator: 5 });
    expect(c[1]).toMatchObject({ paramType: 0, operator: 2, compValue: '0x' });
    expect(c[2]).toMatchObject({ paramType: 1, operator: 0, compValue: '0x' });
    for (const leaf of c.slice(3)) expect(leaf).toMatchObject({ paramType: 1, operator: 16 });
    expect(c[3].compValue).toBe(`0x${'0'.repeat(24)}${B.slice(2)}`);
  });

  it('one recipient is a plain EqualTo, no Or', () => {
    const c = rv2.transferRecipientConditions(rv2.normaliseRecipients([A]));
    expect(c).toHaveLength(3);
    expect(c[1]).toMatchObject({ paramType: 1, operator: 16 });
  });

  it('round-trips through recipientsFromConditions', () => {
    const set = rv2.normaliseRecipients([B, A, A.toUpperCase().replace('0X', '0x')]);
    expect(set).toHaveLength(2);
    expect(rv2.recipientsFromConditions(rv2.transferRecipientConditions(set))).toEqual(set);
    expect(rv2.recipientsFromConditions(rv2.transferRecipientConditions([set[0]]))).toEqual([set[0]]);
  });

  it('refuses to read a capped tree (ADR 0026 has none) or a foreign shape', () => {
    const capped = rv2.transferRecipientConditions([A], { capWei: 10n });
    expect(() => rv2.recipientsFromConditions(capped)).toThrow(/constrained/);
    const pass = [
      { parent: 0, paramType: 5, operator: 5, compValue: '0x' },
      { parent: 0, paramType: 1, operator: 0, compValue: '0x' },
      { parent: 0, paramType: 1, operator: 0, compValue: '0x' },
    ];
    expect(() => rv2.recipientsFromConditions(pass)).toThrow(/neither EqualTo nor Or/);
  });

  it('normaliseRecipients refuses the main Safe and garbage', () => {
    expect(() => rv2.normaliseRecipients([A, SAFE.toLowerCase()], { safe: SAFE })).toThrow(/main Safe/);
    expect(() => rv2.normaliseRecipients(['0x1234'])).toThrow(/not an EVM address/);
    expect(() => rv2.normaliseRecipients([])).toThrow(/at least one/);
  });
});
