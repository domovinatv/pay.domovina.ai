/**
 * Shared Safe v1.4.1 + Safe-Passkey primitives for the gas-sponsoring Workers.
 *
 * SINGLE SOURCE OF TRUTH for the CREATE2-critical pieces. `relay.ts` and
 * `bootstrap-deploy.ts` both deploy Safes at counterfactual addresses the client
 * has already funded — if their `buildSafeInitializer` / `predictSafeProxyAddress`
 * ever drift by a single byte, funds get stranded at an address no one controls
 * (see memory: evm-call-to-empty-address, feedback_safe_counterfactual_address).
 * Before this module the two Workers carried byte-for-byte COPIES of this logic,
 * kept in sync by hand-discipline alone ("Mirrors relay.ts verbatim"). Importing
 * from one place makes that drift impossible.
 */
import {
  encodeFunctionData,
  encodePacked,
  getCreate2Address,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';

// ── Safe v1.4.1 canonical deployments on Gnosis (chain 100), from
//    safe-global/safe-deployments. Identical addresses on every major EVM.
export const SAFE_PROXY_FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67' as const;
export const SAFE_SINGLETON = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762' as const; // SafeL2
export const COMPATIBILITY_FALLBACK_HANDLER =
  '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99' as const;
export const MULTISEND_CALL_ONLY = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2' as const;

// keccak256(SafeProxyFactory.proxyCreationCode() ++ abi.encode(uint256(SAFE_SINGLETON))).
// Constant because both the proxy creation code (pure, on the v1.4.1 factory) and
// the singleton are fixed. Captured from the live Gnosis factory and verified to
// reproduce protocol-kit's predicted addresses for salt 0 AND a campaign salt.
export const SAFE_PROXY_INIT_CODE_HASH =
  '0xe298282cefe913ab5d282047161268a8222e4bd4ed106300c547894bbefd31ee' as const;

// Safe Passkey module v0.2.1 — see safe-modules-deployments.
export const SAFE_WEBAUTHN_SIGNER_FACTORY =
  '0x1d31F259eE307358a26dFb23EB365939E8641195' as const;
export const DAIMO_P256_VERIFIER = '0xc2b78104907F722DABAc4C69f826a522B2754De4' as const;
export const P256_PRECOMPILE = '0x0000000000000000000000000000000000000100' as const;

// Safe owners linked-list sentinel; the prevOwner pointer when a Safe has one owner.
export const SENTINEL_OWNERS = '0x0000000000000000000000000000000000000001' as const;

// ── ABIs ────────────────────────────────────────────────────────────────────

export const SAFE_EXEC_TX_ABI = [
  {
    inputs: [
      { type: 'address', name: 'to' },
      { type: 'uint256', name: 'value' },
      { type: 'bytes', name: 'data' },
      { type: 'uint8', name: 'operation' },
      { type: 'uint256', name: 'safeTxGas' },
      { type: 'uint256', name: 'baseGas' },
      { type: 'uint256', name: 'gasPrice' },
      { type: 'address', name: 'gasToken' },
      { type: 'address', name: 'refundReceiver' },
      { type: 'bytes', name: 'signatures' },
    ],
    name: 'execTransaction',
    outputs: [{ type: 'bool' }],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

export const SAFE_SETUP_ABI = [
  {
    inputs: [
      { type: 'address[]', name: '_owners' },
      { type: 'uint256', name: '_threshold' },
      { type: 'address', name: 'to' },
      { type: 'bytes', name: 'data' },
      { type: 'address', name: 'fallbackHandler' },
      { type: 'address', name: 'paymentToken' },
      { type: 'uint256', name: 'payment' },
      { type: 'address', name: 'paymentReceiver' },
    ],
    name: 'setup',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

export const PROXY_FACTORY_ABI = [
  {
    inputs: [
      { type: 'address', name: '_singleton' },
      { type: 'bytes', name: 'initializer' },
      { type: 'uint256', name: 'saltNonce' },
    ],
    name: 'createProxyWithNonce',
    outputs: [{ type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

export const SIGNER_FACTORY_ABI = [
  {
    inputs: [
      { type: 'uint256', name: 'x' },
      { type: 'uint256', name: 'y' },
      { type: 'uint176', name: 'verifiers' },
    ],
    name: 'createSigner',
    outputs: [{ type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { type: 'uint256', name: 'x' },
      { type: 'uint256', name: 'y' },
      { type: 'uint176', name: 'verifiers' },
    ],
    name: 'getSigner',
    outputs: [{ type: 'address', name: 'signer' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export const OWNER_MGMT_ABI = [
  {
    inputs: [
      { type: 'address', name: 'prevOwner' },
      { type: 'address', name: 'oldOwner' },
      { type: 'address', name: 'newOwner' },
    ],
    name: 'swapOwner',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { type: 'address', name: 'owner' },
      { type: 'uint256', name: '_threshold' },
    ],
    name: 'addOwnerWithThreshold',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

export const SAFE_GET_THRESHOLD_ABI = [
  {
    inputs: [],
    name: 'getThreshold',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export const MULTISEND_ABI = [
  {
    inputs: [{ type: 'bytes', name: 'transactions' }],
    name: 'multiSend',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

// ── Derivations (CREATE2-critical — keep byte-identical with the client) ──────

export type PackedCall = { to: Address; value: bigint; data: Hex };

/** Pack MultiSendCallOnly transactions: 1 byte op || 20 bytes to || 32 bytes value || 32 bytes dataLen || data. */
export function packMultiSend(ops: PackedCall[]): Hex {
  const parts: Hex[] = [];
  for (const op of ops) {
    const dataLen = (op.data.length - 2) / 2;
    parts.push(
      encodePacked(
        ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
        [0, op.to, op.value, BigInt(dataLen), op.data],
      ),
    );
  }
  // Concatenate the packed bytes (each part is already hex-prefixed).
  return ('0x' + parts.map((p) => p.slice(2)).join('')) as Hex;
}

/** Encode (precompile_address << 160 | fallback_verifier) into the uint176 the
 * SafeWebAuthnSignerFactory expects. The singleton tries the precompile first,
 * falls back to Daimo — works whether or not Gnosis has the RIP-7212 precompile. */
export function encodeVerifiers(): bigint {
  return (BigInt(P256_PRECOMPILE) << 160n) | BigInt(DAIMO_P256_VERIFIER);
}

/**
 * Safe v1.4.1 `setup` calldata for a threshold-1 Safe owned by `owners` (in the
 * given ORDER — order is part of the CREATE2 preimage). A single-element array is
 * the legacy 1/1 case (bootstrap/pinka/personal); a 2-element [signer,
 * recoveryOwner] array is an ADR-0013 derived account. Used both for the cold-
 * path deploy AND the CREATE2 guard, so they can never drift.
 */
export function buildSafeInitializer(owners: Address[]): Hex {
  return encodeFunctionData({
    abi: SAFE_SETUP_ABI,
    functionName: 'setup',
    args: [owners, 1n, zeroAddress, '0x', COMPATIBILITY_FALLBACK_HANDLER, zeroAddress, 0n, zeroAddress],
  });
}

/**
 * Deterministic counterfactual Safe address for (owners, saltNonce) under the
 * v1.4.1 SafeProxyFactory. Mirrors `createProxyWithNonce`'s CREATE2:
 *   salt = keccak256(keccak256(initializer) ++ saltNonce)
 *   addr = CREATE2(factory, salt, keccak256(creationCode ++ singleton))
 */
export function predictSafeProxyAddress(owners: Address[], saltNonce: bigint): Address {
  const initializer = buildSafeInitializer(owners);
  const salt = keccak256(
    encodePacked(['bytes32', 'uint256'], [keccak256(initializer), saltNonce]),
  );
  return getCreate2Address({
    from: SAFE_PROXY_FACTORY,
    salt,
    bytecodeHash: SAFE_PROXY_INIT_CODE_HASH,
  });
}
