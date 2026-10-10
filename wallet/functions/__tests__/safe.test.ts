import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';

import { predictSafeProxyAddress } from '../_lib/safe';

/// CREATE2 parity (XD-01). The relayer deploys the Safe at whatever
/// (owners, saltNonce) derive to, and the client funds the address IT
/// predicted. If the two ever disagree, EURe sits forever at an address
/// nobody can deploy. Vectors: real derived accounts (ADR 0013, 1-of-2
/// [signer, recoveryOwner]) from production wallet_accounts, 2026-10-10 —
/// on-chain public data.
const SIGNER = '0x06a300d779999b51385f23cc1e002f24954751f1' as Address;
const RECOVERY = '0x39c86046038ba132f1bcdb4b5b35bb33511dd72c' as Address;

describe('predictSafeProxyAddress', () => {
  it.each([
    [0n, '0x5e79bfc14d980b94ed7017e238be9a754e6ea84c'],
    [1n, '0x5d7eea89b23ff0128034ea5bed2d1ee18dc0b91f'],
    [2n, '0x575fe66a0533fa2a237fdcbd9a2d35288fac1f7b'],
  ])('derived account saltNonce %s → the address production funded', (salt, expected) => {
    expect(predictSafeProxyAddress([SIGNER, RECOVERY], salt).toLowerCase()).toBe(expected);
  });

  it('owner order is significant (relay must use [signer, recovery], like the client)', () => {
    expect(predictSafeProxyAddress([RECOVERY, SIGNER], 0n).toLowerCase())
      .not.toBe('0x5e79bfc14d980b94ed7017e238be9a754e6ea84c');
  });

  it('single-owner and two-owner Safes never collide', () => {
    expect(predictSafeProxyAddress([SIGNER], 0n)).not.toBe(predictSafeProxyAddress([SIGNER, RECOVERY], 0n));
  });
});
