import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  isAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';

import type { Env } from '../types';

/// EURe (Monerium EUR e-money token on Gnosis) — ERC-20 with `transfer`.
const EURE_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

/// Zodiac Roles Modifier v2 — `execTransactionWithRole(to, value, data,
/// operation, roleKey, shouldRevert)`. Scoped on-chain so this EOA can ONLY
/// call EURe.transfer; any other call reverts at the Modifier layer.
/// Audited by ChainSecurity (2022/2023); see gnosisguild/zodiac-modifier-roles.
const ROLES_ABI = [
  {
    type: 'function',
    name: 'execTransactionWithRole',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'roleKey', type: 'bytes32' },
      { name: 'shouldRevert', type: 'bool' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

export interface ForwardArgs {
  /// On-chain recipient — must be a valid checksummed/lowercased EVM address.
  target: Address;
  /// Amount in EURe's smallest unit (wei equivalent — 18 decimals).
  amountWei: bigint;
}

export interface ForwardResult {
  ok: boolean;
  txHash?: Hex;
  /// Set when ok=false. Surfaced into D1 + admin UI for debugging.
  error?: string;
}

/// Builds a viem walletClient against the configured Gnosis RPC and submits
/// `RolesModifier.execTransactionWithRole(...)` wrapping `EURe.transfer(target, amount)`.
/// Returns the broadcast TX hash; does NOT wait for confirmation (the caller
/// already runs inside `c.executionCtx.waitUntil(...)` to keep the webhook
/// response fast — confirmation polling happens separately).
export async function forwardViaSafe(
  env: Env,
  args: ForwardArgs,
): Promise<ForwardResult> {
  if (!env.ROUTER_PRIVATE_KEY) return { ok: false, error: 'router_disabled: no ROUTER_PRIVATE_KEY' };
  if (!env.ROLES_MODIFIER_ADDRESS) return { ok: false, error: 'router_disabled: no ROLES_MODIFIER_ADDRESS' };
  if (!env.ROLE_KEY) return { ok: false, error: 'router_disabled: no ROLE_KEY' };
  if (!isAddress(args.target)) return { ok: false, error: `invalid target: ${args.target}` };
  if (args.amountWei <= 0n) return { ok: false, error: `invalid amount: ${args.amountWei}` };

  const account = privateKeyToAccount(normalizeHex(env.ROUTER_PRIVATE_KEY) as Hex);
  const rpcUrl = env.GNOSIS_RPC_URL || 'https://rpc.gnosischain.com';
  const wallet = createWalletClient({ account, chain: gnosis, transport: http(rpcUrl) });

  const transferCalldata = encodeFunctionData({
    abi: EURE_ABI,
    functionName: 'transfer',
    args: [args.target, args.amountWei],
  });

  try {
    const txHash = await wallet.writeContract({
      address: env.ROLES_MODIFIER_ADDRESS as Address,
      abi: ROLES_ABI,
      functionName: 'execTransactionWithRole',
      args: [
        env.EURE_CONTRACT as Address,
        0n,
        transferCalldata,
        0, // Call (not DelegateCall)
        normalizeHex(env.ROLE_KEY) as Hex,
        true, // shouldRevert — surface scope violations as TX revert
      ],
    });
    return { ok: true, txHash };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/// Best-effort confirmation poll. Called from a separate cron / admin replay
/// path rather than the webhook hot path so we never block Monerium's
/// retry timer.
export async function getForwardStatus(
  env: Env,
  txHash: Hex,
): Promise<'pending' | 'confirmed' | 'failed' | 'unknown'> {
  const rpcUrl = env.GNOSIS_RPC_URL || 'https://rpc.gnosischain.com';
  const client = createPublicClient({ chain: gnosis, transport: http(rpcUrl) });
  try {
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    if (!receipt) return 'pending';
    return receipt.status === 'success' ? 'confirmed' : 'failed';
  } catch {
    return 'unknown';
  }
}

function normalizeHex(s: string): string {
  return s.startsWith('0x') || s.startsWith('0X') ? s : `0x${s}`;
}
