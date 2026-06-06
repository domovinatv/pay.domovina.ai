/**
 * ADR 0011/0012 — "passkey name = Safe address" via bootstrap, two ownership modes.
 *
 * The chicken-and-egg: `user.name` is an INPUT to navigator.credentials.create(),
 * but the Safe address is derived from the passkey pubkey (the OUTPUT). To embed
 * the real address in the passkey name we must know the address BEFORE the passkey
 * exists.
 *
 * Resolution: mint an ephemeral BIP39 account, derive the Safe address it would own
 * (known immediately, no passkey needed), create the passkey with that address in
 * its name, then in ONE atomic relayed tx deploy the Safe (owner = EOA) and attach
 * the passkey signer. Two modes for the attach step:
 *
 *   - 'swap'  → swapOwner(EOA → passkeySigner): owners=[passkey]. The EOA is removed;
 *               max security, recovery via passkey sync + multi-passkey (ADR 0008).
 *   - 'add'   → addOwnerWithThreshold(passkeySigner, 1): owners=[passkey, EOA] (1-of-2).
 *               The 12-word EOA mnemonic becomes a MetaMask / app.safe.global-compatible
 *               recovery key + interop owner. Removable later via removeOwner.
 *
 * Self-custody invariant (ADR 0001): the mnemonic lives only in memory for the few
 * seconds of this flow (and, in 'add' mode, until the user dismisses the created
 * screen). It is never persisted; only the EOA address + the SafeTx signature are
 * sent to the server. The relayer pays gas as an external sender; it is never a Safe
 * owner. The Safe address is not revealed to the user until the deploy confirms.
 */
import { encodeFunctionData, zeroAddress, type Address, type Hex } from 'viem';
import { english, generateMnemonic, mnemonicToAccount } from 'viem/accounts';
import { GNOSIS_CHAIN_ID } from './constants';
import { predictSafeAddress, predictSignerAddress, SAFE_TX_TYPES } from './safe';
import type { P256PublicKey } from './passkey';

/** Safe owners are a linked list terminated by SENTINEL (0x..01). With a single
 * owner, that owner's predecessor pointer is the sentinel — needed for swapOwner. */
const SENTINEL_OWNERS = '0x0000000000000000000000000000000000000001' as const;

export type OwnershipMode = 'swap' | 'add';

const OWNER_MGMT_ABI = [
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

/** Build the owner-management calldata for the post-deploy attach step. Kept here
 * AND mirrored on the server; both must produce byte-identical calldata or the EOA
 * signature won't verify. */
export function buildAttachCalldata(
  mode: OwnershipMode,
  eoaAddress: Address,
  signerAddress: Address,
): Hex {
  return mode === 'swap'
    ? encodeFunctionData({
        abi: OWNER_MGMT_ABI,
        functionName: 'swapOwner',
        args: [SENTINEL_OWNERS, eoaAddress, signerAddress],
      })
    : encodeFunctionData({
        abi: OWNER_MGMT_ABI,
        functionName: 'addOwnerWithThreshold',
        args: [signerAddress, 1n],
      });
}

export type BootstrapEoa = {
  /** Ephemeral 12-word BIP39 mnemonic — IN MEMORY ONLY. Never persisted. In 'add'
   *  mode it is the user's recovery key (shown once, on explicit tap). */
  mnemonic: string;
  /** The ephemeral EOA address; the Safe's initial owner (kept in 'add', swapped in 'swap'). */
  address: Address;
  /** Counterfactual Safe address derived from the EOA owner. This is the FINAL,
   *  permanent address — it does not change when the passkey is attached. */
  safeAddress: Address;
};

/**
 * Step 1: mint the ephemeral BIP39 account and derive its Safe address. Runs BEFORE
 * any passkey exists so the caller can embed `safeAddress` into the passkey user.name.
 */
export async function createBootstrapEoa(): Promise<BootstrapEoa> {
  const mnemonic = generateMnemonic(english);
  const address = mnemonicToAccount(mnemonic).address;
  const safeAddress = await predictSafeAddress(address);
  return { mnemonic, address, safeAddress };
}

/**
 * Step 2: after the passkey exists, derive its WebAuthn signer and have the
 * ephemeral EOA sign the SafeTx that attaches it (swap or add). The EOA signs
 * offline (EIP-712, nonce 0); the signature verifies once the Safe is deployed at
 * its deterministic address.
 */
export async function signAttach(args: {
  eoa: BootstrapEoa;
  pubKey: P256PublicKey;
  mode: OwnershipMode;
}): Promise<{ signerAddress: Address; eoaSignature: Hex }> {
  const account = mnemonicToAccount(args.eoa.mnemonic);
  const signerAddress = await predictSignerAddress(args.pubKey);
  const data = buildAttachCalldata(args.mode, args.eoa.address, signerAddress);
  const eoaSignature = await account.signTypedData({
    domain: { chainId: GNOSIS_CHAIN_ID, verifyingContract: args.eoa.safeAddress },
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx',
    message: {
      to: args.eoa.safeAddress,
      value: 0n,
      data,
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      nonce: 0n,
    },
  });
  return { signerAddress, eoaSignature };
}

export type BootstrapDeployResponse =
  | { ok: true; txHash?: Hex; alreadyDeployed?: boolean }
  | { ok: false; error: string; rateLimited?: boolean };

/**
 * Step 3: submit the deploy+attach bundle to the relayer. The server rebuilds the
 * attach calldata from (mode, ownerEoa, pubkey), verifies the Safe address, broadcasts
 * the atomic MultiSend, and waits for the receipt. Resolves only when the deploy is
 * CONFIRMED on-chain (or already was), so the caller can safely persist + reveal.
 */
export async function submitBootstrapDeploy(req: {
  safeAddress: Address;
  ownerEoa: Address;
  pubKeyX: string;
  pubKeyY: string;
  eoaSignature: Hex;
  mode: OwnershipMode;
}): Promise<BootstrapDeployResponse> {
  let res: Response;
  try {
    res = await fetch('/api/bootstrap-deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' };
  }
  if (res.status === 429) {
    return {
      ok: false,
      error: 'Dnevni limit besplatnih kreiranja dosegnut. Pokušaj ponovno sutra.',
      rateLimited: true,
    };
  }
  try {
    return (await res.json()) as BootstrapDeployResponse;
  } catch {
    return { ok: false, error: `Bootstrap deploy failed (HTTP ${res.status})` };
  }
}
