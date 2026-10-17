import { describe, expect, it } from 'vitest';
import { encodeFunctionData, hashTypedData, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// @ts-expect-error — plain .mjs shared with the safe-tx generators and tools/funding
import * as st from '../safe-tx/lib/safe-tx.mjs';
// @ts-expect-error — plain .mjs shared with the safe-tx generators and tools/funding
import * as rv2 from '../safe-tx/lib/roles-v2.mjs';
import { renderSetupPage, setupConnectSrc, type SetupContext } from '../src/setup/routes';

const SAFE = '0xe2e21755d3F576F090Ecda1D830F3fDA865f37fF'; // italk-sandbox main Safe (Chiado, 1.3.0)
const ROLES = '0x8E926f20eAe8bDCED7Bb7c14F006aEC4975E1532';
const EURE = '0x7a47605930002cc2cd2c3c408d1f33fc2a18ab71';
const ROUTER = '0xD92219dEa8c4FDAf2d53042f7d306fc3E0896759';
const KARTA = '0xb3438D62c7B968806a7E3D78fc4b31Ee8F738720';
const STRANKE = '0x346230f2748745a1D19550969f0b239F3D2b5896';

/// The ProjectRouter setup batch for italk-sandbox, as 009 builds it.
function setupCalls() {
  const key = rv2.roleKeyOf('ProjectRouter');
  const role = (functionName: string, args: unknown[]) => ({
    to: ROLES, value: 0n, data: encodeFunctionData({ abi: rv2.ROLES_ABI, functionName, args } as never),
  });
  return [
    { to: SAFE, value: 0n, data: encodeFunctionData({ abi: rv2.SAFE_ABI, functionName: 'enableModule', args: [ROLES] }) },
    role('scopeTarget', [key, EURE]),
    role('scopeFunction', [key, EURE, rv2.TRANSFER_SELECTOR,
      rv2.transferRecipientConditions(rv2.normaliseRecipients([KARTA, STRANKE], { safe: SAFE })), rv2.ExecutionOptions.None]),
    role('assignRoles', [ROUTER, [key], [true]]),
  ];
}

describe('safe-tx lib (ADR 0027)', () => {
  it('safeTxHash of the Chiado setup batch equals what the Safe itself returned (getTransactionHash, 17.10.2026.)', () => {
    const tx = st.batchToSafeTx(setupCalls(), 10200);
    expect(tx.operation).toBe(1);
    expect(tx.to).toBe('0x40A2aCCbd92BCA938b02010E17A5b8929b49130D');
    const h = hashTypedData(st.safeTxTypedData({ chainId: 10200, safe: SAFE, tx, nonce: 0n }));
    expect(h).toBe('0x5975ad373b0492dd788cc6213dc05424bac181d66a777689302eb2425ac6d26d');
  });

  it('a single call is sent as itself, not through MultiSend', () => {
    const [one] = setupCalls();
    expect(st.batchToSafeTx([one], 10200)).toEqual({ to: SAFE, value: 0n, data: one.data, operation: 0 });
    expect(() => st.batchToSafeTx([], 10200)).toThrow(/empty/);
  });

  it('a signature over the typed data recovers to the signer', async () => {
    const acct = privateKeyToAccount(`0x${'11'.repeat(32)}`);
    const td = st.safeTxTypedData({ chainId: 10200, safe: SAFE, tx: st.batchToSafeTx(setupCalls(), 10200), nonce: 3n });
    const sig = await acct.signTypedData(td);
    expect(await recoverTypedDataAddress({ ...td, signature: sig })).toBe(acct.address);
  });

  it('packs signatures in ascending signer order and refuses duplicates or bad lengths', () => {
    const a = { signer: '0xC2386b03441C6104F8d40E52E74306EAE830a24B', data: `0x${'aa'.repeat(65)}` };
    const b = { signer: '0x4924f440A12ac82F6e06B058a33d7fd8182f1944', data: `0x${'bb'.repeat(65)}` };
    expect(st.packSignatures([a, b])).toBe(`0x${'bb'.repeat(65)}${'aa'.repeat(65)}`);
    expect(() => st.packSignatures([a, a])).toThrow(/two signatures/);
    expect(() => st.packSignatures([{ ...a, data: '0xaa' }])).toThrow(/65/);
  });

  it('pre-validated signature is r = owner, s = 0, v = 1', () => {
    const s = st.preValidatedSignature(ROUTER);
    expect(s).toBe(`0x${'0'.repeat(24)}${ROUTER.slice(2)}${'0'.repeat(64)}01`);
  });

  it('next nonce skips the queue but ignores stale entries below the chain nonce', () => {
    expect(st.nextNonce(5n, [])).toBe(5n);
    expect(st.nextNonce(5n, [{ nonce: '3' }])).toBe(5n);
    expect(st.nextNonce(5n, [{ nonce: '5' }, { nonce: '7' }])).toBe(8n);
  });
});

describe('setup page', () => {
  const ctx: SetupContext = {
    tenantId: 'italk-sandbox', tenantName: 'ITalk <sandbox>', legacy: false, chain: 'chiado', chainId: 10200,
    rpcUrl: 'https://rpc.chiadochain.net/path', safe: SAFE, roles: ROLES, roleKey: null, router: ROUTER, eure: EURE,
    fromBlock: null, recipients: [{ address: KARTA, label: '</script><b>x', campaignId: 'k' }],
  };

  it('allows only the rail RPC, the Safe service and Blockscout', () => {
    expect(setupConnectSrc(ctx)).toBe('https://api.safe.global https://gnosis-chiado.blockscout.com https://rpc.chiadochain.net');
    expect(setupConnectSrc({ ...ctx, rpcUrl: 'not a url' })).toBe('https://api.safe.global https://gnosis-chiado.blockscout.com');
  });

  it('escapes tenant data in HTML and in the config JSON', () => {
    const html = renderSetupPage(ctx);
    expect(html).toContain('ITalk &lt;sandbox&gt;');
    expect(html).not.toContain('</script><b>');
    const json = html.match(/id="setup-config">(.*?)<\/script>/s)![1];
    expect(JSON.parse(json).recipients[0].label).toBe('</script><b>x');
  });
});
