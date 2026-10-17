import { createPublicClient, createWalletClient, getAddress, http, toEventSelector, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis, gnosisChiado } from 'viem/chains';

import type { Env } from '../types';
import { deployerKey } from './projects';
import { loadSetupContext } from './routes';
// @ts-expect-error — plain .mjs shared with the setup dApp and the safe-tx generators
import * as st from '../../safe-tx/lib/safe-tx.mjs';

/// „Izvrši, MPT plaća gas" (ADR 0027): the Worker's gas key for the rail's
/// chain (the same key that deploys project Safes) sends execTransaction for a
/// Safe tx the owners have ALREADY signed to threshold. Executing a fully
/// signed Safe tx is permissionless — the key only pays gas, it cannot change
/// what was signed, and it is not an owner. Everything is re-read here: the
/// tx from the Transaction Service, owners/threshold/nonce from the chain, and
/// the safeTxHash recomputed by the Safe itself.

const CHAINS = { gnosis, chiado: gnosisChiado } as const;
const EXECUTION_SUCCESS = toEventSelector('ExecutionSuccess(bytes32,uint256)');

export interface Confirmation { owner: string; signature: string }

/// Exactly `threshold` signatures from current owners, one per owner.
export function pickExecSignatures(confirmations: Confirmation[], owners: string[], threshold: number): { signer: Address; data: Hex }[] | null {
  const own = new Set(owners.map((o) => o.toLowerCase()));
  const seen = new Set<string>();
  const sigs: { signer: Address; data: Hex }[] = [];
  for (const c of confirmations) {
    const o = c.owner.toLowerCase();
    if (!own.has(o) || seen.has(o) || !/^0x[0-9a-fA-F]{130}$/.test(c.signature)) continue;
    seen.add(o);
    sigs.push({ signer: getAddress(c.owner), data: c.signature as Hex });
  }
  return sigs.length >= threshold ? sigs.slice(0, threshold) : null;
}

export type ExecResult =
  | { status: 200; body: { ok: true; tx_hash: Hex; block: string; executor: Address } }
  | { status: 400 | 404 | 409 | 502; body: { error: string; [k: string]: unknown } };

export async function executeWithGasKey(env: Env, tenantId: string, safeTxHashIn: string): Promise<ExecResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(safeTxHashIn)) return { status: 400, body: { error: 'invalid_safe_tx_hash' } };
  const ctx = await loadSetupContext(env, tenantId);
  if ('error' in ctx) return { status: 404, body: { error: ctx.error } };
  const key = deployerKey(env, ctx.chain);
  if (!key) return { status: 409, body: { error: 'no_gas_key', chain: ctx.chain } };
  const account = privateKeyToAccount(key);
  const pub = createPublicClient({ chain: CHAINS[ctx.chain], transport: http(ctx.rpcUrl) }) as PublicClient;
  const safe = getAddress(ctx.safe);

  const t = await st.getSafeTx(ctx.chainId, safeTxHashIn);
  if (!t) return { status: 404, body: { error: 'safe_tx_not_found' } };
  if (getAddress(t.safe) !== safe) return { status: 409, body: { error: 'safe_tx_of_other_safe' } };
  if (t.isExecuted) return { status: 409, body: { error: 'already_executed', tx_hash: t.transactionHash } };
  // Only zero-gas-refund txs: a refund would pay the executor out of the Safe.
  if (BigInt(t.gasPrice ?? 0) !== 0n || BigInt(t.baseGas ?? 0) !== 0n || BigInt(t.safeTxGas ?? 0) !== 0n) {
    return { status: 409, body: { error: 'refund_params_not_supported' } };
  }

  const [owners, threshold, nonce] = await Promise.all([
    pub.readContract({ address: safe, abi: st.SAFE_TX_ABI, functionName: 'getOwners' }) as Promise<Address[]>,
    pub.readContract({ address: safe, abi: st.SAFE_TX_ABI, functionName: 'getThreshold' }) as Promise<bigint>,
    pub.readContract({ address: safe, abi: st.SAFE_TX_ABI, functionName: 'nonce' }) as Promise<bigint>,
  ]);
  if (BigInt(t.nonce) !== nonce) return { status: 409, body: { error: 'not_next_nonce', nonce: String(nonce), tx_nonce: String(t.nonce) } };
  const tx = { to: getAddress(t.to), value: BigInt(t.value ?? 0), data: (t.data ?? '0x') as Hex, operation: Number(t.operation) };
  let hash: Hex;
  try {
    hash = (await st.safeTxHash(pub, { chainId: ctx.chainId, safe, tx, nonce })) as Hex;
  } catch (err) {
    return { status: 409, body: { error: 'hash_mismatch', detail: (err as Error).message } };
  }
  if (hash.toLowerCase() !== safeTxHashIn.toLowerCase()) return { status: 409, body: { error: 'hash_mismatch' } };

  const sigs = pickExecSignatures(t.confirmations ?? [], owners, Number(threshold));
  if (!sigs) return { status: 409, body: { error: 'not_enough_signatures', have: (t.confirmations ?? []).length, threshold: Number(threshold) } };
  const signatures = st.packSignatures(sigs) as Hex;
  const args = [tx.to, tx.value, tx.data, tx.operation, 0n, 0n, 0n, st.ZERO_ADDRESS, st.ZERO_ADDRESS, signatures] as const;

  try {
    const { request } = await pub.simulateContract({ account, address: safe, abi: st.SAFE_TX_ABI, functionName: 'execTransaction', args: args as never });
    const wallet = createWalletClient({ account, chain: CHAINS[ctx.chain], transport: http(ctx.rpcUrl) });
    const txHash = await wallet.writeContract(request as never);
    const rc = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
    const ok = rc.status === 'success' && rc.logs.some((l) => l.address.toLowerCase() === safe.toLowerCase() && l.topics[0] === EXECUTION_SUCCESS);
    if (!ok) return { status: 502, body: { error: 'execution_failed', tx_hash: txHash } };
    return { status: 200, body: { ok: true, tx_hash: txHash, block: String(rc.blockNumber), executor: account.address } };
  } catch (err) {
    return { status: 502, body: { error: 'execution_failed', executor: account.address, detail: (err as Error).message.split('\n')[0].slice(0, 300) } };
  }
}
