import Safe from '@safe-global/protocol-kit';
import {
  createPublicClient,
  hashTypedData,
  http,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { encodeSafeContractSignature, encodeWebAuthnSignerSignature } from './webauthnSig';
import {
  gnosis,
  GNOSIS_CHAIN_ID,
  SAFE_WEBAUTHN_SIGNER_FACTORY,
  DAIMO_P256_VERIFIER,
  P256_PRECOMPILE_ADDRESS,
} from './constants';
import type { P256PublicKey } from './passkey';

export const publicClient = createPublicClient({
  chain: gnosis,
  transport: http(),
});

/**
 * Encode (precompile_address << 160 | fallback_verifier) into the uint176 expected by
 * SafeWebAuthnSignerFactory. The singleton tries the precompile first, falls back to Daimo.
 * Works whether or not Gnosis has the RIP-7212 precompile.
 */
export function encodeVerifiers(): bigint {
  return (BigInt(P256_PRECOMPILE_ADDRESS) << 160n) | BigInt(DAIMO_P256_VERIFIER);
}

const SAFE_WEBAUTHN_SIGNER_FACTORY_ABI = [
  {
    inputs: [
      { name: 'x', type: 'uint256' },
      { name: 'y', type: 'uint256' },
      { name: 'verifiers', type: 'uint176' },
    ],
    name: 'getSigner',
    outputs: [{ name: 'signer', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/**
 * Read the counterfactual WebAuthnSigner proxy address for a passkey pubkey.
 * Does not deploy anything — just a view call on the factory.
 */
export async function predictSignerAddress(pubKey: P256PublicKey): Promise<Address> {
  return publicClient.readContract({
    address: SAFE_WEBAUTHN_SIGNER_FACTORY,
    abi: SAFE_WEBAUTHN_SIGNER_FACTORY_ABI,
    functionName: 'getSigner',
    args: [pubKey.x, pubKey.y, encodeVerifiers()],
  });
}

/**
 * Predict the counterfactual Safe address for an explicit owner set + threshold.
 * Uses Safe protocol-kit which performs the CREATE2 derivation deterministically.
 * No deploy — the address is known even if no Safe contract exists yet there.
 *
 * IMPORTANT: the owner ORDER is part of the CREATE2 preimage (the setup()
 * initializer encodes the array verbatim). The relayer's hand-built initializer
 * (functions/api/relay.ts buildSafeInitializer) MUST pass owners in the SAME
 * order or it deploys a different address than the one funded — the relay's
 * cold-path CREATE2 guard exists precisely to catch any such drift before it
 * strands funds. The canonical order for an ADR-0013 account is
 * `[passkeySigner, recoveryOwner]` (see src/lib/accounts.ts derivedOwners()).
 */
export async function predictSafeAddressForOwners(
  owners: Address[],
  threshold: number,
  saltNonce = '0',
): Promise<Address> {
  const protocolKit = await Safe.init({
    provider: gnosis.rpcUrls.default.http[0],
    predictedSafe: {
      safeAccountConfig: { owners, threshold },
      safeDeploymentConfig: {
        // Default '0' = personal wallet. pinka per-campaign Safes pass
        // keccak("pinka:campaign:<id>") as a decimal string; recovery
        // (src/lib/recover.ts) must use the SAME salt to match the funded address.
        saltNonce,
        safeVersion: '1.4.1',
      },
    },
  });
  const addr = await protocolKit.getAddress();
  return addr as Address;
}

/**
 * Predict the counterfactual Safe 1/1 address with signerAddress as the only
 * owner. Thin wrapper over predictSafeAddressForOwners for the single-owner
 * cases (bootstrap EOA Safe, pinka campaign Safe, /recover). ADR-0013 derived
 * accounts use the 2-owner form directly.
 */
export async function predictSafeAddress(
  signerAddress: Address,
  saltNonce = '0',
): Promise<Address> {
  return predictSafeAddressForOwners([signerAddress], 1, saltNonce);
}

const SAFE_NONCE_ABI = [
  {
    inputs: [],
    name: 'nonce',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const SAFE_GET_OWNERS_ABI = [
  {
    inputs: [],
    name: 'getOwners',
    outputs: [{ type: 'address[]' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const SAFE_GET_THRESHOLD_ABI = [
  {
    inputs: [],
    name: 'getThreshold',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/** Whether the Safe currently holds code on-chain. False = counterfactual —
 * standard Safe clients (app.safe.global) reject it as "not a Safe wallet"
 * until it deploys (lazily on first send, or explicitly via activateAccount). */
export async function isSafeDeployed(safeAddress: Address): Promise<boolean> {
  const code = await publicClient.getCode({ address: safeAddress });
  return !!code && code !== '0x';
}

/**
 * Read a deployed Safe's signature threshold. Null if the Safe has no code yet
 * (a counterfactual account always deploys at threshold 1) or the read fails.
 *
 * Why callers care: the relay submits execTransaction with exactly ONE passkey
 * signature. Safe's checkSignatures requires `threshold` signatures, so a
 * threshold raised above 1 (e.g. externally via app.safe.global, which the EOA
 * owner can legitimately do) makes every relayed send revert. Send/activate
 * guard on this BEFORE burning a Face ID ceremony + a free relay slot.
 */
export async function readSafeThreshold(safeAddress: Address): Promise<bigint | null> {
  if (!(await isSafeDeployed(safeAddress))) return null;
  try {
    return await publicClient.readContract({
      address: safeAddress,
      abi: SAFE_GET_THRESHOLD_ABI,
      functionName: 'getThreshold',
    });
  } catch {
    return null;
  }
}

/**
 * Read a deployed Safe's owner set. Empty array if the Safe has no code yet
 * (counterfactual) or the call fails. Used to recover the ADR-0013 recovery owner
 * (the non-signer EOA owner) on a device that doesn't have it locally — so account
 * minting works cross-device even if the creating device is gone.
 */
export async function readSafeOwners(safeAddress: Address): Promise<Address[]> {
  const code = await publicClient.getCode({ address: safeAddress });
  if (!code || code === '0x') return [];
  try {
    return (await publicClient.readContract({
      address: safeAddress,
      abi: SAFE_GET_OWNERS_ABI,
      functionName: 'getOwners',
    })) as Address[];
  } catch {
    return [];
  }
}

export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

export type SafeTxFields = {
  to: Address;
  value: bigint;
  data: Hex;
  operation: 0 | 1;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
  nonce: bigint;
};

/**
 * Read the current nonce of a Safe. If the Safe hasn't been deployed yet
 * (counterfactual), the nonce is 0 — that's the value that will apply when
 * the first execTransaction is bundled with the deploy.
 */
export async function readSafeNonce(safeAddress: Address): Promise<bigint> {
  const code = await publicClient.getCode({ address: safeAddress });
  if (!code || code === '0x') return 0n;
  return publicClient.readContract({
    address: safeAddress,
    abi: SAFE_NONCE_ABI,
    functionName: 'nonce',
  });
}

/**
 * Build the EIP-712 `SafeTx` hash that will be signed by the passkey.
 *
 * Safe v1.4.1 domain uses `{ chainId, verifyingContract }`. We populate the
 * gas-refund fields (safeTxGas, baseGas, gasPrice, gasToken, refundReceiver)
 * with zero values — they're only meaningful for the legacy Safe-pays-relayer
 * pattern. Our relayer absorbs the gas directly out-of-band, so these stay 0.
 */
export async function getSafeTxHash(
  safeAddress: Address,
  tx: { to: Address; value: bigint; data: Hex; operation?: 0 | 1; nonce?: bigint },
): Promise<{ hash: Hex; fields: SafeTxFields }> {
  const nonce = tx.nonce ?? (await readSafeNonce(safeAddress));

  const fields: SafeTxFields = {
    to: tx.to,
    value: tx.value,
    data: tx.data,
    operation: tx.operation ?? 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: zeroAddress,
    refundReceiver: zeroAddress,
    nonce,
  };

  const hash = hashTypedData({
    domain: {
      chainId: GNOSIS_CHAIN_ID,
      verifyingContract: safeAddress,
    },
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx',
    message: fields,
  });

  return { hash, fields };
}

/**
 * Wrap a raw WebAuthn assertion into the full Safe `signatures` blob for
 * execTransaction. Composes the WebAuthn-singleton-specific payload with
 * Safe's ERC-1271 contract-signature framing.
 */
export function encodeWebAuthnSignature(args: {
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
  signerAddress: Address;
}): Hex {
  const innerSig = encodeWebAuthnSignerSignature({
    authenticatorData: args.authenticatorData,
    clientDataJSON: args.clientDataJSON,
    derSignature: args.signature,
  });
  return encodeSafeContractSignature(args.signerAddress, innerSig);
}
