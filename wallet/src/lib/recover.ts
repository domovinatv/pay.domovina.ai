/**
 * Fund recovery for counterfactual Safes whose owner is a passkey WebAuthn signer
 * — e.g. pinka per-campaign Safes that received EURe but were never deployed.
 *
 * The hard part is "which passkey?". We do NOT need the credentialId, the pubkey,
 * localStorage, or any DB record up front. We recover the P-256 public key directly
 * from a WebAuthn assertion (ECDSA public-key recovery yields 2 candidates), then
 * for each candidate compute `predictSafe(getSigner(pubkey), saltNonce)` and match
 * it against the target Safe. The passkey that controls the Safe is the one that
 * mathematically derives to it. The user just taps Face ID and picks a passkey.
 *
 * Withdrawal then reuses the existing /api/relay cold path: it deploys the signer +
 * Safe (at the campaign saltNonce) and runs the EURe transfer atomically.
 */
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import {
  bytesToBigInt,
  bytesToHex,
  encodeFunctionData,
  hexToBytes,
  keccak256,
  stringToBytes,
  type Address,
  type Hex,
} from 'viem';
import { EURE_ADDRESS } from './constants';
import {
  encodeWebAuthnSignature,
  getSafeTxHash,
  predictSafeAddress,
  predictSignerAddress,
  publicClient,
} from './safe';
import { signWithPasskey } from './passkey';
import { relayTx } from './relay';

const ERC20_ABI = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/** Decimal uint256 saltNonce for a pinka campaign — keccak256("pinka:campaign:<id>").
 * Mirrors pinka-finance/app/lib/chain/safe.ts saltFromCampaignId. */
export function saltFromCampaignId(campaignId: string): string {
  return BigInt(keccak256(stringToBytes(`pinka:campaign:${campaignId}`))).toString();
}

/** Parse a DER ECDSA signature to raw (r, s) WITHOUT low-s normalization — recovery
 * needs the exact (r, s) the authenticator produced. */
function parseDerRaw(der: Uint8Array): { r: bigint; s: bigint } {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error('bad DER (seq)');
  i++; // total length byte (assume short form, < 128)
  if (der[i++] !== 0x02) throw new Error('bad DER (r tag)');
  const rlen = der[i++];
  const r = bytesToBigInt(der.slice(i, i + rlen));
  i += rlen;
  if (der[i++] !== 0x02) throw new Error('bad DER (s tag)');
  const slen = der[i++];
  const s = bytesToBigInt(der.slice(i, i + slen));
  return { r, s };
}

/** ECDSA digest WebAuthn signs: sha256(authenticatorData || sha256(clientDataJSON)). */
function webauthnDigest(authenticatorData: Uint8Array, clientDataJSON: Uint8Array): Uint8Array {
  const cdHash = sha256(clientDataJSON);
  const signed = new Uint8Array(authenticatorData.length + cdHash.length);
  signed.set(authenticatorData, 0);
  signed.set(cdHash, authenticatorData.length);
  return sha256(signed);
}

/** Recover the (up to 2) candidate P-256 pubkeys from a WebAuthn assertion. */
function recoverPubkeys(a: {
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
}): { x: bigint; y: bigint }[] {
  const { r, s } = parseDerRaw(a.signature);
  const digest = webauthnDigest(a.authenticatorData, a.clientDataJSON);
  const out: { x: bigint; y: bigint }[] = [];
  for (const bit of [0, 1]) {
    try {
      const pt = new p256.Signature(r, s).addRecoveryBit(bit).recoverPublicKey(digest);
      const aff = pt.toAffine();
      out.push({ x: aff.x, y: aff.y });
    } catch {
      /* invalid recovery bit for this signature — skip */
    }
  }
  return out;
}

/** Discoverable WebAuthn get() under a specific rpId. Returns the assertion +
 * credentialId. No allowCredentials → the OS shows every passkey for that rpId. */
async function discoverableGet(rpId: string): Promise<{
  credentialId: string;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
}> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const assertion = (await navigator.credentials.get({
    publicKey: {
      rpId,
      challenge: challenge.buffer as ArrayBuffer,
      userVerification: 'required',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) throw new Error('cancelled');
  const resp = assertion.response as AuthenticatorAssertionResponse;
  return {
    credentialId: bytesToHex(new Uint8Array(assertion.rawId)),
    authenticatorData: new Uint8Array(resp.authenticatorData),
    clientDataJSON: new Uint8Array(resp.clientDataJSON),
    signature: new Uint8Array(resp.signature),
  };
}

export type IdentifyResult = {
  credentialId: string;
  rpId: string;
  pubKey: { x: bigint; y: bigint };
  signerAddress: Address;
};

/**
 * Prompt Face ID and figure out whether the chosen passkey controls `targetSafe`
 * (= predictSafe(signer, saltNonce)). Tries each rpId in order. Returns the match
 * or null if no recovery candidate from the chosen passkey derives to the Safe.
 */
export async function identifyPasskeyForSafe(args: {
  targetSafe: Address;
  saltNonce: string;
  rpIds: string[];
}): Promise<IdentifyResult | null> {
  // A WebAuthn rpId must be the current origin's host or a registrable parent of
  // it. e.g. on wallet-staging.domovina.ai, 'domovina.ai' is valid but
  // 'wallet.domovina.ai' is NOT (sibling, not an ancestor) — passing it throws
  // SecurityError. Drop rpIds that don't apply to this origin.
  const host = typeof window !== 'undefined' ? window.location.hostname : '';
  const rpIds = args.rpIds.filter((r) => host === r || host.endsWith('.' + r));

  for (const rpId of rpIds) {
    let got;
    try {
      got = await discoverableGet(rpId);
    } catch (e) {
      const name = e instanceof DOMException ? e.name : '';
      const msg = e instanceof Error ? e.message : String(e);
      if (name === 'SecurityError' || /cancel|NotAllowed|abort|timed out|security/i.test(msg)) continue;
      throw e;
    }
    for (const pub of recoverPubkeys(got)) {
      const signerAddress = await predictSignerAddress(pub);
      const safe = await predictSafeAddress(signerAddress, args.saltNonce);
      if (safe.toLowerCase() === args.targetSafe.toLowerCase()) {
        return { credentialId: got.credentialId, rpId, pubKey: pub, signerAddress };
      }
    }
  }
  return null;
}

/** Current EURe balance of a (possibly undeployed) Safe address. */
export async function eureBalanceOf(safe: Address): Promise<bigint> {
  return publicClient.readContract({
    address: EURE_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [safe],
  });
}

/**
 * Deploy (if needed) + withdraw the full EURe balance of `safe` to `destination`,
 * signed by the identified passkey, via the relay cold path with the campaign salt.
 */
export async function recoverFunds(args: {
  identity: IdentifyResult;
  safe: Address;
  saltNonce: string;
  destination: Address;
  amount?: bigint; // defaults to full balance
}): Promise<{ txHash: Hex }> {
  const amount = args.amount ?? (await eureBalanceOf(args.safe));
  if (amount <= 0n) throw new Error('Safe je prazan — nema EURe za povući.');

  const transferData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [args.destination, amount],
  });

  // Fresh (undeployed) Safe → nonce 0. Pass it explicitly so getSafeTxHash does
  // not read the chain (the Safe has no code yet).
  const { hash } = await getSafeTxHash(args.safe, {
    to: EURE_ADDRESS,
    value: 0n,
    data: transferData,
    nonce: 0n,
  });

  const assertion = await signWithPasskey(args.identity.credentialId, hexToBytes(hash), args.identity.rpId);
  const signature = encodeWebAuthnSignature({
    authenticatorData: assertion.authenticatorData,
    clientDataJSON: assertion.clientDataJSON,
    signature: assertion.signature,
    signerAddress: args.identity.signerAddress,
  });

  const res = await relayTx({
    safeAddress: args.safe,
    signerAddress: args.identity.signerAddress,
    pubKeyX: args.identity.pubKey.x.toString(),
    pubKeyY: args.identity.pubKey.y.toString(),
    to: EURE_ADDRESS,
    value: '0',
    data: transferData,
    signature,
    saltNonce: args.saltNonce,
  });
  if (!res.ok) throw new Error(res.error);
  return { txHash: res.txHash };
}
