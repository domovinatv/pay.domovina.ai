/**
 * "Aktiviraj račun" — deploy a counterfactual DERIVED Safe on-chain WITHOUT
 * moving any funds, so the account becomes loadable in standard Safe clients
 * (app.safe.global / Safe Mobile reject an undeployed address as "not a Safe
 * wallet" — see docs/safe-client-compatibility.md, refinement 1).
 *
 * Mechanism: a 0-value self-call (to = the Safe itself, data = 0x) signed by the
 * passkey and submitted through the existing relay. The relay's pre-flight
 * getCode sees no code and takes the COLD path: one atomic MultiSend of
 * [deploy WebAuthn signer (if missing), deploy Safe, execTransaction(self-call)]
 * — the Safe either deploys or the whole tx reverts loudly. Costs one free
 * relay slot; no EURe moves.
 *
 * Restricted to DERIVED accounts. A bootstrap account deploys at creation via
 * /api/bootstrap-deploy and CANNOT take this path anyway: its CREATE2 address
 * derives from the ephemeral-EOA initializer, which the relay cold-path guard
 * would correctly reject (predict([signer], salt) !== safeAddress).
 */
import { type Address, type Hex } from 'viem';
import { encodeWebAuthnSignature, getSafeTxHash, isSafeDeployed } from './safe';
import { recordRpId, signWithPasskey, type PasskeyRecord } from './passkey';
import { relayTx } from './relay';

export type ActivateArgs = {
  safeAddress: Address;
  signerAddress: Address;
  /** Decimal uint256 saltNonce of the derived account (AccountRecord.saltNonce). */
  saltNonce: string;
  /** The 2nd owner the relay cold path bakes into the 1-of-2 setup() initializer. */
  recoveryOwner: Address;
  /** The identity passkey that signs the activation SafeTx. */
  passkey: PasskeyRecord;
};

export type ActivateResult =
  | { status: 'activated'; txHash: Hex }
  | { status: 'already-deployed' };

export async function activateAccount(args: ActivateArgs): Promise<ActivateResult> {
  // Idempotence: someone may have sent to/from this account meanwhile (deploying
  // it lazily). Re-check before burning a Face ID ceremony on a no-op.
  if (await isSafeDeployed(args.safeAddress)) {
    return { status: 'already-deployed' };
  }

  // Counterfactual Safe → nonce 0. The self-call is a plain CALL with empty
  // calldata, which lands in the fallback handler and succeeds doing nothing —
  // its only effect is forcing the deploy bundle through.
  const { hash } = await getSafeTxHash(args.safeAddress, {
    to: args.safeAddress,
    value: 0n,
    data: '0x',
  });

  const assertion = await signWithPasskey(
    args.passkey.credentialId,
    hexToBytes(hash),
    recordRpId(args.passkey),
  );
  const signature = encodeWebAuthnSignature({ ...assertion, signerAddress: args.signerAddress });

  const result = await relayTx({
    safeAddress: args.safeAddress,
    signerAddress: args.signerAddress,
    pubKeyX: args.passkey.pubKey.x,
    pubKeyY: args.passkey.pubKey.y,
    to: args.safeAddress,
    value: '0',
    data: '0x',
    signature,
    saltNonce: args.saltNonce,
    recoveryOwner: args.recoveryOwner,
  });

  if (!result.ok) {
    throw new Error(
      result.rateLimited ? 'Dosegao si dnevni limit (5 besplatnih transakcija).' : result.error,
    );
  }
  return { status: 'activated', txHash: result.txHash };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
