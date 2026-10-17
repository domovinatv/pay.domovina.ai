import { describe, expect, it } from 'vitest';
import { decodeFunctionData, getAddress } from 'viem';

import * as rv2 from '../safe-tx/lib/roles-v2.mjs';
import { buildProjectRouterBatch, ROLE } from '../safe-tx/lib/project-router-batch.mjs';

const SAFE = getAddress('0xe2e21755d3F576F090Ecda1D830F3fDA865f37fF');
const ROLES = getAddress('0x8E926f20eAe8bDCED7Bb7c14F006aEC4975E1532');
const EURE = getAddress('0x7a47605930002cc2cd2c3c408d1f33fc2a18ab71');
const STRANKE = getAddress('0x346230f2748745a1D19550969f0b239F3D2b5896');
const KARTA = getAddress('0xb3438D62c7B968806a7E3D78fc4b31Ee8F738720');
const NOVI = getAddress('0x00000000000000000000000000000000000000a1');

/// The Chiado state after 17.10.2026: module on, EURe scoped, role allows the given set.
function chain(onChain: string[]) {
  const roleKey = rv2.roleKeyOf(ROLE);
  const target = { eventName: 'ScopeTarget', args: { roleKey, targetAddress: EURE }, blockNumber: 2n, transactionHash: '0x01' };
  const fn = {
    eventName: 'ScopeFunction',
    args: { roleKey, targetAddress: EURE, selector: rv2.TRANSFER_SELECTOR, conditions: rv2.transferRecipientConditions(onChain), options: rv2.ExecutionOptions.None },
    blockNumber: 2n, transactionHash: '0x01',
  };
  return {
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === 'getModulesPaginated' ? [[ROLES], rv2.SENTINEL] : SAFE,
    getCode: async () => `0x363d3d373d3d3d363d73${rv2.ROLES_MASTERCOPY.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`,
    getBlockNumber: async () => 10n,
    getLogs: async (q: { events?: { name: string }[] }) => {
      if (!q.events) return [];
      const names = q.events.map((e) => e.name);
      return names.includes('ScopeFunction') ? [target, fn] : [target];
    },
  };
}

const build = (onChain: string[], recipients: string[], remove?: string[]) =>
  buildProjectRouterBatch({ env: 'chiado', safe: SAFE, roles: ROLES, eure: EURE, fromBlock: 1n, recipients, remove }, chain(onChain));

const scopedSet = (b: Awaited<ReturnType<typeof build>>) => {
  const { args } = decodeFunctionData({ abi: rv2.ROLES_ABI, data: b.txs[0].data as `0x${string}` });
  return rv2.recipientsFromConditions(args![3] as never);
};

describe('buildProjectRouterBatch: adding and removing projects (ADR 0027)', () => {
  it('nothing new → no steps', async () => {
    const b = await build([STRANKE, KARTA], [STRANKE, KARTA]);
    expect(b.txs).toHaveLength(0);
  });

  it('a new project → one scopeFunction with the old set plus it', async () => {
    const b = await build([STRANKE, KARTA], [STRANKE, KARTA, NOVI]);
    expect(b.txs.map((t: { _label: string }) => t._label)).toEqual(['Roles.scopeFunction']);
    expect(b.added).toEqual([NOVI]);
    expect(scopedSet(b).map((a: string) => a.toLowerCase()).sort()).toEqual([NOVI, KARTA, STRANKE].map((a) => a.toLowerCase()).sort());
  });

  it('a project dropped from D1 stays on chain unless it is removed explicitly', async () => {
    expect((await build([STRANKE, KARTA], [STRANKE])).txs).toHaveLength(0);
    const b = await build([STRANKE, KARTA], [STRANKE], [KARTA]);
    expect(b.removed).toEqual([KARTA]);
    expect(scopedSet(b)).toEqual([STRANKE]);
  });

  it('removal wins over addition, and the last project cannot be removed', async () => {
    const b = await build([STRANKE, KARTA], [STRANKE, KARTA], [KARTA.toLowerCase()]);
    expect(scopedSet(b)).toEqual([STRANKE]);
    await expect(build([STRANKE], [STRANKE], [STRANKE])).rejects.toThrow(/last project/);
  });

  it('removing an address that is not on chain changes nothing', async () => {
    expect((await build([STRANKE, KARTA], [STRANKE, KARTA], [NOVI])).txs).toHaveLength(0);
  });
});
