import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  isAddress,
  numberToHex,
  pad,
  size,
  stringToHex,
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

/// PaymentRegistry — emits a `Payment` event so each forward's
/// (sessionId, kind, recipient, sender, token, amount, metadataURI) is
/// recoverable from chain alone. See backend/contracts/PaymentRegistry.sol.
const REGISTRY_ABI = [
  {
    type: 'function',
    name: 'record',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'sessionId',   type: 'bytes32' },
      { name: 'kind',        type: 'bytes32' },
      { name: 'recipient',   type: 'address' },
      { name: 'token',       type: 'address' },
      { name: 'amount',      type: 'uint256' },
      { name: 'metadataURI', type: 'string'  },
    ],
    outputs: [],
  },
] as const;

/// Safe MultiSendCallOnly — `multiSend(bytes transactions)`. Called via
/// DELEGATECALL from the Safe so inner txs run in Safe's context.
const MULTISEND_ABI = [
  {
    type: 'function',
    name: 'multiSend',
    stateMutability: 'payable',
    inputs: [{ name: 'transactions', type: 'bytes' }],
    outputs: [],
  },
] as const;

/// Zodiac Roles Modifier v2 — `execTransactionWithRole(to, value, data,
/// operation, roleKey, shouldRevert)`. Scoped on-chain: this EOA may call
/// (a) EURe.transfer directly, or (b) MultiSendCallOnly.multiSend via
/// DELEGATECALL — anything else reverts at the Modifier layer.
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

const OP_CALL = 0;
const OP_DELEGATECALL = 1;

export interface ForwardArgs {
  /// On-chain recipient — must be a valid checksummed/lowercased EVM address.
  target: Address;
  /// Amount in EURe's smallest unit (wei equivalent — 18 decimals).
  amountWei: bigint;
  /// Frontend-generated session id pulled out of the SEPA remittance. When
  /// present and PaymentRegistry env vars are set, the forward is batched
  /// with a `registry.record(...)` call so the event lands in the same tx.
  /// Null/empty → legacy single-transfer path (no event).
  sessionId?: string | null;
  /// Short ASCII tag right-padded into bytes32 — e.g. "payment", "donation".
  /// Defaults to "payment" when not supplied.
  kind?: string;
  /// Optional URL or ipfs:// pointer with renderable metadata (Open Graph
  /// tags). Emitted as-is in the `Payment` event. Empty string when absent.
  metadataURI?: string;
}

export interface ForwardResult {
  ok: boolean;
  txHash?: Hex;
  /// Set when ok=false. Surfaced into D1 + admin UI for debugging.
  error?: string;
}

/// Builds a viem walletClient against the configured Gnosis RPC and submits
/// `RolesModifier.execTransactionWithRole(...)`. Two paths:
///
///   1. **MultiSend batch** (when PAYMENT_REGISTRY_ADDRESS + MULTISEND_ADDRESS
///      are set): wraps `[registry.record(...), EURe.transfer(...)]` in a
///      Safe MultiSendCallOnly payload and executes via DELEGATECALL through
///      the Roles Modifier. One tx hash carries both the event and the
///      transfer.
///   2. **Legacy single transfer** (fallback): plain `EURe.transfer(...)`
///      via the role. Used when registry env vars are unset OR no sessionId
///      is provided (manual / unindexed payments).
///
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

  const useRegistry =
    args.sessionId &&
    env.PAYMENT_REGISTRY_ADDRESS &&
    env.MULTISEND_ADDRESS &&
    isAddress(env.PAYMENT_REGISTRY_ADDRESS) &&
    isAddress(env.MULTISEND_ADDRESS);

  const transferCalldata = encodeFunctionData({
    abi: EURE_ABI,
    functionName: 'transfer',
    args: [args.target, args.amountWei],
  });

  try {
    let to: Address;
    let data: Hex;
    let operation: number;

    if (useRegistry) {
      const sidBytes32 = asciiToBytes32(args.sessionId!);
      const kindBytes32 = asciiToBytes32(args.kind && args.kind.length > 0 ? args.kind : 'payment');
      const recordCalldata = encodeFunctionData({
        abi: REGISTRY_ABI,
        functionName: 'record',
        args: [
          sidBytes32,
          kindBytes32,
          args.target,
          env.EURE_CONTRACT as Address,
          args.amountWei,
          args.metadataURI ?? '',
        ],
      });
      const multiSendPayload = encodeMultiSend([
        { operation: OP_CALL, to: env.PAYMENT_REGISTRY_ADDRESS as Address, value: 0n, data: recordCalldata },
        { operation: OP_CALL, to: env.EURE_CONTRACT as Address,            value: 0n, data: transferCalldata },
      ]);
      data = encodeFunctionData({
        abi: MULTISEND_ABI,
        functionName: 'multiSend',
        args: [multiSendPayload],
      });
      to = env.MULTISEND_ADDRESS as Address;
      operation = OP_DELEGATECALL;
    } else {
      to = env.EURE_CONTRACT as Address;
      data = transferCalldata;
      operation = OP_CALL;
    }

    const txHash = await wallet.writeContract({
      address: env.ROLES_MODIFIER_ADDRESS as Address,
      abi: ROLES_ABI,
      functionName: 'execTransactionWithRole',
      args: [
        to,
        0n,
        data,
        operation,
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

/// Encode a Safe MultiSend payload. Format per Safe contracts (single-byte
/// packed encoding — NOT ABI):
///   operation(uint8) || to(address,20B) || value(uint256,32B) || dataLen(uint256,32B) || data(bytes)
/// concatenated for each inner transaction.
export function encodeMultiSend(
  txs: Array<{ operation: number; to: Address; value: bigint; data: Hex }>,
): Hex {
  const parts: Hex[] = txs.map((t) => {
    const dataLen = BigInt(size(t.data));
    return concatHex([
      numberToHex(t.operation, { size: 1 }),
      pad(t.to, { size: 20 }) as Hex,
      pad(numberToHex(t.value), { size: 32 }) as Hex,
      pad(numberToHex(dataLen), { size: 32 }) as Hex,
      t.data,
    ]);
  });
  return concatHex(parts);
}

/// Right-pad a short ASCII tag into bytes32. Used for sessionId / kind
/// fields that the indexer trims trailing zeros to decode.
function asciiToBytes32(s: string): Hex {
  // stringToHex with size: 32 truncates anything past 32 bytes — guard so we
  // surface the error rather than silently emit a corrupted id.
  const bytes = new TextEncoder().encode(s);
  if (bytes.length > 32) {
    throw new Error(`asciiToBytes32: "${s}" is ${bytes.length} bytes (>32)`);
  }
  return stringToHex(s, { size: 32 });
}

function normalizeHex(s: string): string {
  return s.startsWith('0x') || s.startsWith('0X') ? s : `0x${s}`;
}
